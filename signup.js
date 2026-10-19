'use strict';

/**
 * 報名：找出「候補轉正取」的人。
 * 正取／候補不存在資料庫，而是依報名時間排序，前 cap 位是正取（和網頁的算法一樣）。
 */
const SIGNUP_PER_COURT = 8;

/** Firestore Timestamp／數字 → 毫秒；還沒有時間的排最後 */
function stampMs(v) {
  if (v === null || v === undefined) return Number.MAX_SAFE_INTEGER;
  if (typeof v === 'number') return v;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (typeof v.seconds === 'number') return v.seconds * 1000;
  return Number.MAX_SAFE_INTEGER;
}

/** @param {Array<{id: string, at: *}>} list */
function sortSignups(list) {
  return list.slice().sort((a, b) => (stampMs(a.at) - stampMs(b.at)) || (a.id < b.id ? -1 : 1));
}

function eventCap(ev) {
  return Math.max(1, Number(ev && ev.cap) || (Number(ev && ev.courts) || 1) * SIGNUP_PER_COURT);
}

/**
 * 有人取消後，誰從候補升上來。
 * @param {Array} remaining 取消後的名單（已排序）
 * @param {{id: string, at: *}} removed 被取消的那一筆
 * @param {number} cap 正取名額
 * @returns {Array} 升為正取的人（0 或 1 位）
 */
function promotedAfterRemoval(remaining, removed, cap) {
  const all = sortSignups(remaining.concat([removed]));
  const rank = all.findIndex((s) => s.id === removed.id);
  if (rank < 0 || rank >= cap) return [];   // 取消的是候補：沒有人升級
  return remaining.length >= cap ? [remaining[cap - 1]] : [];
}

/** 管理者加開場地（名額變多）時，升上來的那幾位 */
function promotedAfterCapChange(sorted, oldCap, newCap) {
  return newCap > oldCap ? sorted.slice(oldCap, newCap) : [];
}

function eventDateText(ev) {
  const [y, m, d] = String(ev.date || '').split('-').map(Number);
  if (!y || !m || !d) return '';
  return `${m}/${d}（${'日一二三四五六'[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}）`;
}

/** 通知要送給誰：自己報名的送本人；幫朋友報名的（id = uid_g1）送代報的人 */
function notifyTarget(signup) {
  const m = /^(.+)_g\d+$/.exec(signup.id);
  if (m) return { uid: signup.by || m[1], guest: true };
  return { uid: signup.id, guest: false };
}

function promotionText(ev, name, guest = false) {
  const time = ev.start ? ` ${ev.start}${ev.end ? `–${ev.end}` : ''}` : '';
  if (guest) {
    return {
      title: `🏸 你幫 ${name} 報名的場次轉正取了！`,
      body: `${eventDateText(ev)}${time}${ev.venue ? `｜${ev.venue}` : ''}，記得通知 ${name}。不能來的話請到報名頁取消。`,
    };
  }
  return {
    title: `🏸 ${name}，你已經從候補轉為正取！`,
    body: `${eventDateText(ev)}${time}${ev.venue ? `｜${ev.venue}` : ''}，記得準時到。不能來的話請到報名頁取消。`,
  };
}

module.exports = {
  stampMs, sortSignups, eventCap, promotedAfterRemoval, promotedAfterCapChange, promotionText, notifyTarget,
};
