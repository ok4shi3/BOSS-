/*************************************************
 * BOSSの名鑑bot（Discord版）
 * GAS(JSON) → 10分前にDiscord通知
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
const POLL_SECONDS = 60;          // 何秒ごとに再計画するか
const MAX_FUTURE_MS = 48 * 60 * 60 * 1000; // 48時間先まで予約

// ===== Discord Client =====
const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

// 予約管理（race_key -> timeoutId）
const scheduled = new Map();

// ===== Discord送信 =====
async function sendToChannel(text) {
  const ch = await client.channels.fetch(CHANNEL_ID);
  if (!ch) throw new Error("チャンネルが取得できません");
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

// ===== 古い予約の掃除 =====
function clearOldSchedules(now) {
  for (const [key, t] of scheduled.entries()) {
    // timeoutは自動で消えるが、念のため
    if (!t || typeof t !== "object") {
      scheduled.delete(key);
    }
  }
}

// ===== 通知計画 =====
async function planNotifications() {
  const now = DateTime.now().setZone("Asia/Tokyo");
  clearOldSchedules(now);

  const races = await fetchRaces();

  for (const r of races) {
    if (
      !r ||
      !r.race_key ||
      !r.announceAtISO ||
      !r.startAtISO ||
      !r.message
    ) continue;

    // すでに予約済みはスキップ
    if (scheduled.has(r.race_key)) continue;

    const notifyAt = DateTime.fromISO(r.announceAtISO, { zone: "Asia/Tokyo" });
    if (!notifyAt.isValid) continue;

    const ms = notifyAt.toMillis() - now.toMillis();

    // すでに過去 or 遠すぎる未来は無視
    if (ms <= 0) continue;
    if (ms > MAX_FUTURE_MS) continue;

    const timeoutId = setTimeout(async () => {
      try {
        await sendToChannel(r.message);
      } catch (e) {
        console.error("send error:", e);
      } finally {
        scheduled.delete(r.race_key);
      }
    }, ms);

    scheduled.set(r.race_key, timeoutId);
  }
}

// ===== 起動 =====
client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await sendToChannel("🤖 起動しました。10分前通知の監視を開始します。");

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
