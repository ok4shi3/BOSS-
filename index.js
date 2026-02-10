/*************************************************
 * BOSSの名鑑bot（Discord版）- 改善版
 * GAS(JSON) → announceAtISO に到達したらDiscord通知
 *
 * 改善点：
 * - race_key が同じでも announceAtISO が変わったら予約を更新（重要）
 * - 取りこぼし救済：少し過去(猶予内)なら即送信
 * - ログ強化：取得件数・予約件数・送信件数が分かる
 *************************************************/

require("dotenv").config();
const { Client, GatewayIntentBits } = require("discord.js");
const { DateTime } = require("luxon");
const fetch = require("node-fetch");

// ===== 環境変数 =====
const TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const RACES_JSON_URL = process.env.RACES_JSON_URL;

if (!TOKEN) throw new Error("DISCORD_TOKEN が .env にありません");
if (!CHANNEL_ID) throw new Error("DISCORD_CHANNEL_ID が .env にありません");
if (!RACES_JSON_URL) throw new Error("RACES_JSON_URL が .env にありません");

// ===== 設定 =====
const ZONE = "Asia/Tokyo";
const POLL_SECONDS = 60;                 // 何秒ごとに再計画するか
const MAX_FUTURE_MS = 48 * 60 * 60 * 1000; // 48時間先まで予約
const LATE_GRACE_MS = 3 * 60 * 1000;     // 取りこぼし救済（3分まで遅れても即送る）
const MIN_RESCHEDULE_DIFF_MS = 1000;     // 予約更新の差分しきい値（1秒）

// ===== Discord Client =====
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// 予約管理（race_key -> { timeoutId, notifyAtMs }）
const scheduled = new Map();

// ===== Discord送信 =====
async function sendToChannel(text) {
  const ch = await client.channels.fetch(CHANNEL_ID);
  if (!ch) throw new Error("チャンネルが取得できません");
  if (!ch.isTextBased()) throw new Error("指定チャンネルがTextBasedではありません");
  await ch.send(text);
}

// ===== GAS(JSON)取得 =====
async function fetchRaces() {
  const res = await fetch(RACES_JSON_URL, { method: "GET" });
  if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error("JSONが配列ではありません");
  return data;
}

// ===== ISOパース（JST固定） =====
function parseNotifyAtMs(announceAtISO) {
  // announceAtISO が "2026-02-11T21:10:00"（TZ無し）でも JST として解釈する
  const dt = DateTime.fromISO(String(announceAtISO || ""), { zone: ZONE });
  if (!dt.isValid) return null;
  return dt.toMillis();
}

// ===== 特定キーの予約を解除 =====
function cancelSchedule(key) {
  const cur = scheduled.get(key);
  if (cur && cur.timeoutId) {
    clearTimeout(cur.timeoutId);
  }
  scheduled.delete(key);
}

// ===== 通知計画 =====
async function planNotifications() {
  const now = DateTime.now().setZone(ZONE).toMillis();

  const races = await fetchRaces();
  console.log(`[plan] fetched races=${races.length} now=${DateTime.fromMillis(now).toISO()}`);

  let scheduledCount = 0;
  let updatedCount = 0;
  let sentNowCount = 0;

  for (const r of races) {
    if (!r || !r.race_key || !r.announceAtISO || !r.message) continue;

    const key = String(r.race_key);
    const msg = String(r.message).trim();
    if (!msg) continue;

    const notifyAtMs = parseNotifyAtMs(r.announceAtISO);
    if (!notifyAtMs) continue;

    const diff = notifyAtMs - now;

    // 遠すぎる未来は無視
    if (diff > MAX_FUTURE_MS) continue;

    // 既に過去 → 救済：少しだけ過ぎてたら即送信、それ以上はスキップ
    if (diff <= 0) {
      if (Math.abs(diff) <= LATE_GRACE_MS) {
        // 二重送信防止：すでに予約が残ってるなら一旦消す
        cancelSchedule(key);
        try {
          await sendToChannel(msg);
          console.log(`[send-now] ${key} (late ${-diff}ms)`);
          sentNowCount++;
        } catch (e) {
          console.error("[send-now error]", key, e);
        }
      }
      continue;
    }

    // ここから未来 → 予約すべき
    const existing = scheduled.get(key);

    // すでに同じ時刻で予約済みなら何もしない
    if (existing && Math.abs(existing.notifyAtMs - notifyAtMs) < MIN_RESCHEDULE_DIFF_MS) {
      continue;
    }

    // 予約済みだが時刻が変わった → 予約更新（ここが本丸）
    if (existing) {
      cancelSchedule(key);
      updatedCount++;
    }

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

  console.log(
    `[plan] scheduled=${scheduledCount} updated=${updatedCount} send-now=${sentNowCount} total_active=${scheduled.size}`
  );
}

// ===== 起動 =====
client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  try {
    await sendToChannel("🤖 起動しました。通知監視を開始します。");
  } catch (e) {
    console.error("startup message failed:", e);
  }

  // 起動直後に一度計画
  try {
    await planNotifications();
  } catch (e) {
    console.error("initial plan error", e);
  }

  // 定期再計画（GAS側の変更・再起動対策）
  setInterval(async () => {
    try {
      await planNotifications();
    } catch (e) {
      console.error("planNotifications error", e);
    }
  }, POLL_SECONDS * 1000);
});

// ===== ログイン =====
client.login(TOKEN);

