'use strict';

/**
 * 羽球輪轉排場：上場推播
 * 管理者每次更新排場（teams/{teamId}/live/current），就找出新上場的人，
 * 推播給「已確認、而且開啟上場通知」的球友。
 * 管理者把 live/current.notifyEnabled 設成 false 時整個不送。
 */
const { onDocumentWritten, onDocumentDeleted, onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { logger } = require('firebase-functions');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');
const { newlyOnCourt, messageText } = require('./oncourt');
const {
  sortSignups, eventCap, promotedAfterRemoval, promotedAfterCapChange, promotionText, notifyTarget, eventStartMs,
} = require('./signup');

initializeApp();

const DEFAULT_APP_URL = 'https://atony1334.github.io/badminton/';
// 失效的推播憑證（手機換了、取消通知），收到這些錯誤就從資料庫移除
const DEAD_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
]);

/**
 * 通知的時效：
 *  - TTL：手機離線時，推播服務最多保留多久；過了就丟掉，不會晚到才跳出來
 *  - expiresAt：通知本身的有效期限，sw.js 和網頁會把過期的通知自動清掉
 */
const ONCOURT_TTL_SEC = 180;            // 上場通知 3 分鐘內沒送到就不送了
const ONCOURT_VALID_MS = 15 * 60000;    // 上場通知 15 分鐘後視為過期（一場大約 10 分鐘）
const SIGNUP_TTL_MAX_SEC = 7 * 86400;   // 推播服務最多保留 7 天

function taipeiTime(t) {
  return new Date(t).toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false });
}

// 送給一位球友的所有裝置；失效的憑證順手清掉
function sendToMember(ref, tokens, data, ttlSec) {
  return getMessaging().sendEachForMulticast({
    tokens,
    // 只送 data，由網頁的 sw.js 自己顯示通知（iPhone 和安卓都一樣）
    data,
    webpush: { headers: { Urgency: 'high', TTL: String(Math.round(ttlSec)) } },
  }).then((res) => {
    const dead = [];
    res.responses.forEach((r, i) => {
      if (!r.success && r.error && DEAD_TOKEN_CODES.has(r.error.code)) dead.push(tokens[i]);
    });
    if (dead.length) return ref.update({ fcmTokens: FieldValue.arrayRemove(...dead) });
    return null;
  });
}

function parseState(snap) {
  if (!snap || !snap.exists) return null;
  try {
    return JSON.parse(snap.data().stateJson || 'null');
  } catch (err) {
    return null;
  }
}

exports.notifyOnCourt = onDocumentWritten(
  { document: 'teams/{teamId}/live/current', region: 'asia-east1' },
  async (event) => {
    const { teamId } = event.params;
    // 管理者關閉了上場通知（例如只是在測試排場）
    const afterDoc = event.data.after;
    if (!afterDoc || !afterDoc.exists || afterDoc.data().notifyEnabled === false) return;
    const before = parseState(event.data.before);
    const after = parseState(event.data.after);
    const items = newlyOnCourt(before, after);
    if (!items.length) return;

    const db = getFirestore();
    const [team, members] = await Promise.all([
      db.doc(`teams/${teamId}`).get(),
      db.collection(`teams/${teamId}/members`)
        .where('status', '==', 'approved')
        .where('notifyOn', '==', true)
        .get(),
    ]);
    if (members.empty) return;
    const appUrl = (team.exists && team.data().appUrl) || DEFAULT_APP_URL;
    const link = `${appUrl}?team=${teamId}`;

    const byName = {};
    members.docs.forEach((d) => {
      const m = d.data();
      if (m.name && Array.isArray(m.fcmTokens) && m.fcmTokens.length) {
        (byName[m.name] = byName[m.name] || []).push({ ref: d.ref, tokens: m.fcmTokens });
      }
    });

    const jobs = [];
    items.forEach((item) => {
      (byName[item.name] || []).forEach(({ ref, tokens }) => {
        const { title, body } = messageText(item);
        const now = Date.now();
        jobs.push(sendToMember(ref, tokens, {
          title,
          body: `${body}（${taipeiTime(now)} 排出）`,
          url: link,
          tag: `oncourt-${teamId}`,
          expiresAt: String(now + ONCOURT_VALID_MS),
        }, ONCOURT_TTL_SEC));
      });
    });
    const results = await Promise.allSettled(jobs);
    const failed = results.filter((r) => r.status === 'rejected');
    if (failed.length) logger.warn('部分推播失敗', failed.map((f) => String(f.reason)));
    logger.info(`上場推播：${items.map((i) => i.name).join('、')}，送出 ${jobs.length} 份`);
  },
);

/* ===================== 報名：候補轉正取通知 ===================== */
/**
 * 報名者的文件 id 就是他的 Google uid；有認領球員、開過通知的人，
 * teams/{teamId}/members/{uid} 裡有推播憑證，就送「你已經轉正取」。
 * 球友幫朋友報名的（uid_g1）送給代報的人；管理者代報的（m 開頭）沒有帳號，不會收到。
 */
async function notifyPromoted(db, teamId, eventId, ev, promoted) {
  if (!promoted.length) return;
  // 場次已經開打（或日期已過）：遞補通知沒有意義，不送
  const start = eventStartMs(ev);
  const left = start ? start - Date.now() : SIGNUP_TTL_MAX_SEC * 1000;
  if (left <= 0) {
    logger.info(`場次已開打，略過遞補通知：${promoted.map((p) => p.name).join('、')}`);
    return;
  }
  const ttl = Math.max(60, Math.min(SIGNUP_TTL_MAX_SEC, left / 1000));
  const team = await db.doc(`teams/${teamId}`).get();
  const appUrl = (team.exists && team.data().appUrl) || DEFAULT_APP_URL;
  const link = `${appUrl}?team=${teamId}&event=${eventId}`;
  const jobs = promoted.map(async (p) => {
    const target = notifyTarget(p);
    const ref = db.doc(`teams/${teamId}/members/${target.uid}`);
    const member = await ref.get();
    const tokens = member.exists ? member.data().fcmTokens : null;
    if (!Array.isArray(tokens) || !tokens.length) return null;
    const { title, body } = promotionText(ev, p.name || '', target.guest);
    return sendToMember(ref, tokens, {
      title, body, url: link, tag: `signup-${eventId}`, expiresAt: String(start || Date.now() + left),
    }, ttl);
  });
  const results = await Promise.allSettled(jobs);
  const failed = results.filter((r) => r.status === 'rejected');
  if (failed.length) logger.warn('部分遞補通知失敗', failed.map((f) => String(f.reason)));
  logger.info(`遞補通知：${promoted.map((p) => p.name).join('、')}`);
}

async function loadSignups(db, teamId, eventId) {
  const snap = await db.collection(`teams/${teamId}/events/${eventId}/signups`).get();
  return sortSignups(snap.docs.map((d) => Object.assign({ id: d.id }, d.data())));
}

// 有人取消報名
exports.notifySignupPromoted = onDocumentDeleted(
  { document: 'teams/{teamId}/events/{eventId}/signups/{signupId}', region: 'asia-east1' },
  async (event) => {
    const { teamId, eventId, signupId } = event.params;
    const db = getFirestore();
    const evSnap = await db.doc(`teams/${teamId}/events/${eventId}`).get();
    if (!evSnap.exists) return;   // 整個場次被刪掉了
    const ev = evSnap.data();
    const removed = Object.assign({ id: signupId }, event.data ? event.data.data() : {});
    const remaining = await loadSignups(db, teamId, eventId);
    await notifyPromoted(db, teamId, eventId, ev, promotedAfterRemoval(remaining, removed, eventCap(ev)));
  },
);

// 管理者加開場地，名額變多
exports.notifyCapIncrease = onDocumentUpdated(
  { document: 'teams/{teamId}/events/{eventId}', region: 'asia-east1' },
  async (event) => {
    const { teamId, eventId } = event.params;
    const before = event.data.before.data();
    const after = event.data.after.data();
    const oldCap = eventCap(before);
    const newCap = eventCap(after);
    if (newCap <= oldCap) return;
    const db = getFirestore();
    const sorted = await loadSignups(db, teamId, eventId);
    await notifyPromoted(db, teamId, eventId, after, promotedAfterCapChange(sorted, oldCap, newCap));
  },
);
