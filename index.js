'use strict';

/**
 * 羽球輪轉排場：上場推播
 * 管理者每次更新排場（teams/{teamId}/live/current），就找出新上場的人，
 * 推播給「已確認、而且開啟上場通知」的球友。
 * 管理者把 live/current.notifyEnabled 設成 false 時整個不送。
 */
const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { logger } = require('firebase-functions');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');
const { newlyOnCourt, messageText } = require('./oncourt');

initializeApp();

const DEFAULT_APP_URL = 'https://atony1334.github.io/badminton/';
// 失效的推播憑證（手機換了、取消通知），收到這些錯誤就從資料庫移除
const DEAD_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
]);

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
        jobs.push(getMessaging().sendEachForMulticast({
          tokens,
          // 只送 data，由網頁的 sw.js 自己顯示通知（iPhone 和安卓都一樣）
          data: { title, body, url: link, tag: `oncourt-${teamId}` },
          webpush: { headers: { Urgency: 'high', TTL: '600' } },
        }).then((res) => {
          const dead = [];
          res.responses.forEach((r, i) => {
            if (!r.success && r.error && DEAD_TOKEN_CODES.has(r.error.code)) dead.push(tokens[i]);
          });
          if (dead.length) return ref.update({ fcmTokens: FieldValue.arrayRemove(...dead) });
          return null;
        }));
      });
    });
    const results = await Promise.allSettled(jobs);
    const failed = results.filter((r) => r.status === 'rejected');
    if (failed.length) logger.warn('部分推播失敗', failed.map((f) => String(f.reason)));
    logger.info(`上場推播：${items.map((i) => i.name).join('、')}，送出 ${jobs.length} 份`);
  },
);
