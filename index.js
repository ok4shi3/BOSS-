/*************************************************
 * BOSS Discord Bot（ポーリング停止版）
 *
 * - 起動時にGAS(JSON)を1回だけ取得
 * - announceAtISO（JST）に到達したら通知（setTimeoutで予約）
 * - 定期ポーリングはしない（= doGet連射しない）
 *
 * Node.js 18+ 前提（組み込み fetch 使用）
 *************************************************/

require("dotenv").config();
const { Client, GatewayIntentBits } = require("discord.js");
const { DateTime } = require("luxon");

// ===== 環境変数 =====
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const RACES_JSON_URL = process.env.RACES_JSON_URL;

if (!DISCORD_TOKEN) throw new Error("DISCORD_TOKEN が未設定です");
if (!DISCORD_CHANNEL_ID) throw new Error("DISCORD_CHANNEL_ID が未設定です");
if (!RACES_JSON_URL) throw new Error("RACES_JSON_URL が未設定です");

// ===== 設定 =====
const ZONE = "Asia/Tokyo";
const MAX_FUTURE_MS = 48 * 60 * 60 * 1000; // 48時間先まで予約
const LATE_GRACE_MS = 3 * 60 * 1000;       // 3分遅れまで即送信
const RESCHEDULE_DIFF_MS = 1000;           // 1秒以上ズレたら再予約（今回は再取得しないので保険程度）

// ===== Discord Client =====
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

// race_key -> { timeoutId, notifyAtMs }
const scheduled = new Map();

// ===== Discord送信 =====
async function sendToChannel(text) {
  const channel = await client.channels.fetch(DISCORD_CHANNEL_ID);
  if (!channel || !channel.isTextBased()) {
    throw new Error("通知先チャンネルが取得できません");
  }
  await channel.send(text);
}

// ===== GAS(JSON)取得 =====
async function fetchRaces() {
  const res = await fetch(RACES_JSON_URL);
  if (!res.ok) throw new Error(`fetch failed: HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error("JSONが配列ではありません");
  return data;
}

// ===== ISO（announceAtISO）を JST としてパース =====
function parseNotifyAtMs(iso) {
  const dt = DateTime.fromISO(String(iso || ""), { zone: ZONE });
  if (!dt.isValid) return null;
  return dt.toMillis();
}

// ===== 既存予約をキャンセル =====
function cancelSchedule(key) {
  const cur = scheduled.get(key);
  if (cur && cur.timeoutId) clearTimeout(cur.timeoutId);
  scheduled.delete(key);
}

// ===== 通知計画（1回だけ作る） =====
async function planNotificationsOnce() {
  const nowMs = DateTime.now().setZone(ZONE).toMillis();

  const races = await fetchRaces();
  console.log(`[plan-once] fetched=${races.length} now=${DateTime.fromMillis(nowMs).toISO()}`);

  let scheduledCount = 0;
  let sentNowCount = 0;

  for (const r of races) {
    if (!r || !r.race_key || !r.announceAtISO || !r.message) continue;

    const key = String(r.race_key);
    const msg = String(r.message).trim();
    if (!msg) continue;

    const notifyAtMs = parseNotifyAtMs(r.announceAtISO);
    if (!notifyAtMs) continue;

    const diff = notifyAtMs - nowMs;

    // 未来すぎるものは無視
    if (diff > MAX_FUTURE_MS) continue;

    // すでに過去 → 救済送信（直近だけ）
    if (diff <= 0) {
      if (Math.abs(diff) <= LATE_GRACE_MS) {
        cancelSchedule(key);
        await sendToChannel(msg);
        console.log(`[send-now] ${key} (late ${-diff}ms)`);
        sentNowCount++;
      }
      continue;
    }

    // すでに予約済みならスキップ（今回は起動1回運用なので基本発生しない）
    const existing = scheduled.get(key);
    if (existing && Math.abs(existing.notifyAtMs - notifyAtMs) < RESCHEDULE_DIFF_MS) {
      continue;
    }
    if (existing) cancelSchedule(key);

    const timeoutId = setTimeout(async () => {
      try {
        await sendToChannel(msg);
        console.log(`[send] ${key}`);
      } catch (e) {
        console.error("[send error]", key, e);
      } finally {
        scheduled.delete(key);
      }
    }, diff);

    scheduled.set(key, { timeoutId, notifyAtMs });
    scheduledCount++;
  }

  console.log(`[plan-once] scheduled=${scheduledCount} send-now=${sentNowCount} active=${scheduled.size}`);
}

// ===== 起動 =====
client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  // 起動通知は送らない（余計な投稿を防ぐ）
  await planNotificationsOnce();
});

client.login(DISCORD_TOKEN);
