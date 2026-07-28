import { Client, GatewayIntentBits, Collection, REST, Routes, SlashCommandBuilder, PermissionFlagsBits, ChannelType, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle, ComponentType } from 'discord.js';
import https from 'https';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import mysql from 'mysql2/promise';
const __dirname = dirname(fileURLToPath(import.meta.url));

// Load config
let CONFIG;
try {
  CONFIG = JSON.parse(readFileSync(join(__dirname, 'config.json'), 'utf-8'));
} catch {
  CONFIG = { DISCORD_TOKEN: process.env.DISCORD_TOKEN, CLIENT_ID: process.env.CLIENT_ID, API_URL: process.env.API_URL };
}
Object.assign(process.env, CONFIG);

const WEB_URL = 'https://gag2-tracker.onrender.com';

function roleName(key) { return 'gag2-' + key.toLowerCase().replace(/[^a-z0-9_-]/g, ''); }

// ── MySQL pool + cache ──
const DB_CONFIG = {
  host: '91.99.159.222', port: 3306, user: 'u42392_27CVwh7vyo',
  password: '0oUeLpVmgl.TMQR.2jYCgWvr', database: 's42392_Save-data',
  waitForConnections: true, connectionLimit: 5, queueLimit: 0,
  enableKeepAlive: true, keepAliveInitialDelay: 10000,
};
let pool;
let dbAvailable = true; // set to false if MySQL connection fails

async function initDB() {
  pool = mysql.createPool(DB_CONFIG);
  pool.on('error', e => { console.error('[DB] Pool error:', e.message); dbAvailable = false; });
  // Test connection with short timeout
  try {
    const conn = await Promise.race([
      pool.getConnection(),
      new Promise((_, r) => setTimeout(r, 4000, new Error('connect timeout')))
    ]);
    conn.release();
  } catch (e) {
    console.error('[DB] Connection failed (' + e.message + ') — running without DB');
    dbAvailable = false;
    return;
  }
  console.log('[DB] Creating tables...');
  try {
    await q('CREATE TABLE IF NOT EXISTS guild_config (guild_id VARCHAR(64) PRIMARY KEY, channel_id VARCHAR(64))');
    await q('CREATE TABLE IF NOT EXISTS subscriptions (id INT AUTO_INCREMENT PRIMARY KEY, guild_id VARCHAR(64) NOT NULL, user_id VARCHAR(64) NOT NULL, type VARCHAR(16) NOT NULL, value VARCHAR(255) NOT NULL, UNIQUE KEY u (guild_id, user_id, type, value))');
    await q('CREATE TABLE IF NOT EXISTS wishlist (id INT AUTO_INCREMENT PRIMARY KEY, guild_id VARCHAR(64) NOT NULL, value VARCHAR(255) NOT NULL, UNIQUE KEY u (guild_id, value))');
    await q('CREATE TABLE IF NOT EXISTS notif_prefs (guild_id VARCHAR(64) NOT NULL, user_id VARCHAR(64) NOT NULL, mode VARCHAR(16) NOT NULL DEFAULT \'both\', UNIQUE KEY u (guild_id, user_id))');
    await q('CREATE TABLE IF NOT EXISTS restock_history (id INT AUTO_INCREMENT PRIMARY KEY, item_key VARCHAR(255) NOT NULL, item_name VARCHAR(255), quantity INT NOT NULL, rarity VARCHAR(64), category VARCHAR(64), ts BIGINT NOT NULL, INDEX idx_item (item_key), INDEX idx_ts (ts))');
    await q('CREATE TABLE IF NOT EXISTS sell_history (id INT AUTO_INCREMENT PRIMARY KEY, item_key VARCHAR(255) NOT NULL, item_name VARCHAR(255), multiplier DECIMAL(10,4) NOT NULL, ts BIGINT NOT NULL, INDEX idx_item (item_key), INDEX idx_ts (ts))');
    await q('CREATE TABLE IF NOT EXISTS weather_history (id INT AUTO_INCREMENT PRIMARY KEY, weather_type VARCHAR(64), weather_name VARCHAR(255), ts BIGINT NOT NULL, INDEX idx_type (weather_type), INDEX idx_ts (ts))');
    await q('CREATE TABLE IF NOT EXISTS guild_settings (guild_id VARCHAR(64) NOT NULL, setting VARCHAR(64) NOT NULL, value VARCHAR(255), UNIQUE KEY u (guild_id, setting))');
    try { await q('ALTER TABLE restock_history ADD INDEX idx_item_ts (item_key, ts)'); } catch {}
    try { await q('ALTER TABLE sell_history ADD INDEX idx_item_ts (item_key, ts)'); } catch {}
    try { await q('ALTER TABLE weather_history ADD INDEX idx_type_ts (weather_type, ts)'); } catch {}
  } catch (e) {
    console.error('[DB] Table creation failed:', e.message);
    dbAvailable = false;
    return;
  }
  console.log('[DB] Pool ready');
}

async function q(sql, params) {
  if (!dbAvailable) return [[], { affectedRows: 0 }];
  try { return await Promise.race([pool.execute(sql, params), new Promise((_, r) => setTimeout(r, 8000, new Error('timeout')))]); }
  catch (e) { console.error('[DB] Error:', e.message); throw e; }
}

// In-memory cache (30s TTL) for hot-path queries
const cache = { guilds: {} };
const cacheTime = {};

function isCached(key, ttl) {
  return cacheTime[key] && Date.now() - cacheTime[key] < ttl;
}

async function getChannelId(g) {
  if (isCached('ch_' + g, 30000) && cache.guilds[g] !== undefined) return cache.guilds[g];
  const [r] = await q('SELECT channel_id FROM guild_config WHERE guild_id=?', [g]);
  cache.guilds[g] = r.length ? r[0].channel_id : null;
  cacheTime['ch_' + g] = Date.now();
  return cache.guilds[g];
}
async function setChannel(g, c) {
  await q('INSERT INTO guild_config (guild_id, channel_id) VALUES (?,?) ON DUPLICATE KEY UPDATE channel_id=?', [g, c, c]);
  cache.guilds[g] = c; cacheTime['ch_' + g] = Date.now();
}

async function getCachedAll(type, g) {
  const key = 'all_' + type + '_' + g;
  if (isCached(key, 30000) && cache[key]) return cache[key];
  const [r] = await q('SELECT user_id, value FROM subscriptions WHERE guild_id=? AND type=?', [g, type]);
  const m = {};
  for (const row of r) { if (!m[row.user_id]) m[row.user_id] = []; m[row.user_id].push(row.value); }
  cache[key] = m; cacheTime[key] = Date.now();
  return m;
}
function invalidateCache(type, g) {
  const key = 'all_' + type + '_' + g;
  delete cache[key]; delete cacheTime[key];
}

async function addUserItem(g, u, i) {
  try { await q('INSERT INTO subscriptions (guild_id,user_id,type,value) VALUES (?,?,?,?)', [g, u, 'item', i.toLowerCase().trim()]); invalidateCache('item', g); invalidateUserSub(g, 'item'); return true; } catch { return false; }
}
async function removeUserItem(g, u, i) {
  const [r] = await q('DELETE FROM subscriptions WHERE guild_id=? AND user_id=? AND type=? AND value=?', [g, u, 'item', i.toLowerCase().trim()]);
  if (r.affectedRows > 0) invalidateCache('item', g); invalidateUserSub(g, 'item');
  return r.affectedRows > 0;
}
async function getUserItems(g, u) {
  const [r] = await q('SELECT value FROM subscriptions WHERE guild_id=? AND user_id=? AND type=?', [g, u, 'item']);
  return r.map(x => x.value);
}
async function getAllSubscribers(g) { return getCachedAll('item', g); }

async function addWeatherSub(g, u, w) {
  try { await q('INSERT INTO subscriptions (guild_id,user_id,type,value) VALUES (?,?,?,?)', [g, u, 'weather', w.toLowerCase().trim()]); invalidateCache('weather', g); invalidateUserSub(g, 'weather'); return true; } catch { return false; }
}
async function removeWeatherSub(g, u, w) {
  const [r] = await q('DELETE FROM subscriptions WHERE guild_id=? AND user_id=? AND type=? AND value=?', [g, u, 'weather', w.toLowerCase().trim()]);
  if (r.affectedRows > 0) invalidateCache('weather', g); invalidateUserSub(g, 'weather');
  return r.affectedRows > 0;
}
async function getWeatherSubs(g, u) {
  const [r] = await q('SELECT value FROM subscriptions WHERE guild_id=? AND user_id=? AND type=?', [g, u, 'weather']);
  return r.map(x => x.value);
}
async function getAllWeatherSubs(g) { return getCachedAll('weather', g); }

async function addSellSub(g, u, k, thresh) {
  const val = thresh ? k.toLowerCase().trim() + ':' + thresh : k.toLowerCase().trim();
  try { await q('INSERT INTO subscriptions (guild_id,user_id,type,value) VALUES (?,?,?,?)', [g, u, 'sell', val]); invalidateCache('sell', g); invalidateUserSub(g, 'sell'); return true; } catch { return false; }
}
async function removeSellSub(g, u, k) {
  const [r] = await q('DELETE FROM subscriptions WHERE guild_id=? AND user_id=? AND type=? AND value LIKE ?', [g, u, 'sell', k.toLowerCase().trim() + '%']);
  if (r.affectedRows > 0) invalidateCache('sell', g); invalidateUserSub(g, 'sell');
  return r.affectedRows > 0;
}
async function getSellSubs(g, u) {
  const [r] = await q('SELECT value FROM subscriptions WHERE guild_id=? AND user_id=? AND type=?', [g, u, 'sell']);
  return r.map(x => x.value);
}
async function getAllSellSubs(g) { return getCachedAll('sell', g); }

async function addCategorySub(g, u, c) {
  try { await q('INSERT INTO subscriptions (guild_id,user_id,type,value) VALUES (?,?,?,?)', [g, u, 'cat', c.toLowerCase().trim()]); invalidateCache('cat', g); invalidateUserSub(g, 'cat'); return true; } catch { return false; }
}
async function removeCategorySub(g, u, c) {
  const [r] = await q('DELETE FROM subscriptions WHERE guild_id=? AND user_id=? AND type=? AND value=?', [g, u, 'cat', c.toLowerCase().trim()]);
  if (r.affectedRows > 0) invalidateCache('cat', g); invalidateUserSub(g, 'cat');
  return r.affectedRows > 0;
}
async function getCategorySubs(g, u) {
  const [r] = await q('SELECT value FROM subscriptions WHERE guild_id=? AND user_id=? AND type=?', [g, u, 'cat']);
  return r.map(x => x.value);
}
async function getAllCategorySubs(g) { return getCachedAll('cat', g); }

// ── Wishlist (server-wide) ──
async function addWishlistItem(g, v) {
  try { await q('INSERT INTO wishlist (guild_id, value) VALUES (?,?)', [g, v.toLowerCase().trim()]); return true; } catch { return false; }
}
async function removeWishlistItem(g, v) {
  const [r] = await q('DELETE FROM wishlist WHERE guild_id=? AND value=?', [g, v.toLowerCase().trim()]);
  return r.affectedRows > 0;
}
async function getWishlist(g) {
  const [r] = await q('SELECT value FROM wishlist WHERE guild_id=?', [g]);
  return r.map(x => x.value);
}

// ── Notification preferences (cached 30s, in-memory fallback) ──
const notifCache = {};
const memoryNotifs = {};

async function getNotifMode(g, u) {
  const key = 'notif_' + g + '_' + u;
  if (notifCache[key] && notifCache[key].exp > Date.now()) return notifCache[key].mode;
  if (!dbAvailable) {
    const mode = memoryNotifs[key] || 'both';
    notifCache[key] = { mode, exp: Date.now() + 300000 };
    return mode;
  }
  const [r] = await q('SELECT mode FROM notif_prefs WHERE guild_id=? AND user_id=?', [g, u]);
  const mode = r.length ? r[0].mode : 'both';
  notifCache[key] = { mode, exp: Date.now() + 300000 };
  return mode;
}
async function setNotifMode(g, u, mode) {
  const key = 'notif_' + g + '_' + u;
  memoryNotifs[key] = mode;
  notifCache[key] = { mode, exp: Date.now() + 300000 };
  if (!dbAvailable) return;
  await q('INSERT INTO notif_prefs (guild_id, user_id, mode) VALUES (?,?,?) ON DUPLICATE KEY UPDATE mode=?', [g, u, mode, mode]);
}

// ── Snooze (silence pings) ──
const snoozeFile = join(process.cwd(), 'snoozes.json');
let snoozes = {};
function loadSnoozes() {
  try { snoozes = JSON.parse(readFileSync(snoozeFile, 'utf-8')); } catch { snoozes = {}; }
}
function saveSnoozes() { writeFileSync(snoozeFile, JSON.stringify(snoozes)); }
function isSnoozed(g, u) { return snoozes[g + ':' + u] > Date.now(); }
function setSnooze(g, u, ms) { snoozes[g + ':' + u] = Date.now() + ms; saveSnoozes(); }
function clearSnooze(g, u) { delete snoozes[g + ':' + u]; saveSnoozes(); }
loadSnoozes();

// Parse sell sub values (may include :threshold)
function parseSellSub(val) {
  const parts = val.split(':');
  if (parts.length >= 2 && !isNaN(parseFloat(parts[parts.length - 1]))) {
    const th = parseFloat(parts.pop());
    return { key: parts.join(':'), threshold: th };
  }
  return { key: val, threshold: 0 };
}

// ── Data source (direct from api.gag2.gg) ──
let latestData = null;
let dataListeners = [];
// In-memory stock history for graphs (no DB needed)
const stockHistory = {}; // item_key -> [{ts, qty}, ...]
const MAX_HISTORY = 1008; // 7 days at 10min intervals

function fetchStock() {
  return new Promise((resolve, reject) => {
    const req = https.get('https://api.gag2.gg/api/live', { timeout: 8000 }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(d)); } catch { reject(new Error('Bad JSON')); }
        } else { reject(new Error('HTTP ' + res.statusCode)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

async function refreshData() {
  try {
    const data = await fetchStock();
    if (data?.stock) {
      lastFetchTime = Date.now();
      if (Object.keys(previousStock).length === 0) previousStock = buildItemMap(data);
      const changed = JSON.stringify(latestData) !== JSON.stringify(data);
      latestData = data;
      if (changed) {
        for (const cb of dataListeners) cb(data);
      }
    }
  } catch (e) { console.log('[API] Fetch failed:', e.message); }
  setTimeout(refreshData, 15000);
}

function onData(cb) { dataListeners.push(cb); }
let lastFetchTime = 0;
function isFresh() { return Date.now() - lastFetchTime < 5 * 60 * 1000; }

// ── All-items lookup (fetches from items API if not in current stock) ──
let allItemsCache = null;
let allItemsCacheTime = 0;
let allItemsPromise = null;

function apiGet(path) {
  return new Promise((resolve, reject) => {
    const req = https.get('https://api.gag2.gg' + path, { timeout: 8000 }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(d)); } catch { reject(new Error('Bad JSON')); }
        } else { reject(new Error('HTTP ' + res.statusCode)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

async function getAllItems() {
  if (allItemsCache && Date.now() - allItemsCacheTime < 1800000) return allItemsCache;
  if (!allItemsPromise) {
    allItemsPromise = (async () => {
      const types = ['seed', 'gear', 'crate', 'pet', 'cosmetic'];
      const results = await Promise.all(types.map(t =>
        apiGet('/api/items?type=' + t + '&limit=200').then(res => res?.items?.map(it => ({ ...it, category: t })) || []).catch(() => [])
      ));
      allItemsCache = results.flat();
      allItemsCacheTime = Date.now();
      return allItemsCache;
    })();
  }
  try { return await allItemsPromise; } finally { allItemsPromise = null; }
}

function findItemCached(key) {
  const live = latestData;
  if (!live?.stock) return null;
  for (const cat of live.stock) {
    for (const it of cat.items) {
      if (it.key === key || it.name?.toLowerCase() === key.toLowerCase()) return { ...it, category: cat.category, stock: it.quantity };
    }
  }
  return null;
}

async function findItem(key) {
  const live = latestData;
  if (live?.stock) {
    for (const cat of live.stock) {
      for (const it of cat.items) {
        if (it.key === key || it.name?.toLowerCase() === key.toLowerCase()) return { ...it, category: cat.category, stock: it.quantity };
      }
    }
  }
  const all = await getAllItems();
  const m = all.find(it => it.id === key || it.slug === key || it.name?.toLowerCase() === key.toLowerCase());
  if (m) return { key: m.id, name: m.name, rarity: m.rarity, emoji: m.emoji, category: m.category, value: m.value, stock: 0 };
  return null;
}

async function searchItems(query) {
  const live = latestData;
  const results = [];
  if (live?.stock) {
    for (const cat of live.stock) {
      for (const it of cat.items) {
        if (it.key.toLowerCase().includes(query) || it.name.toLowerCase().includes(query)) results.push(it.key);
      }
    }
  }
  const all = await getAllItems();
  for (const it of all) {
    if (!results.includes(it.id) && (it.id.includes(query) || it.slug?.includes(query) || it.name?.toLowerCase().includes(query))) results.push(it.id);
  }
  return results.slice(0, 25);
}

// ── Trackers ──
let activePings = {};
let activeWeatherPings = {};
let weatherMessages = {};
let dashboardMessages = {};
let lastDashboardUpdate = 0;
let previousStock = {};
let lastWeatherKey = '';
let lastSell = {};
let restockCounts = {};
let todayStr = '';
let lastPingTime = {}; // key -> last ping timestamp

function getToday() { return new Date().toISOString().slice(0, 10); }
function resetStatsIfNewDay() {
  const t = getToday();
  if (t !== todayStr) { todayStr = t; restockCounts = {}; }
}

function buildItemMap(data) {
  const map = {};
  if (!data?.stock) return map;
  for (const cat of data.stock) {
    for (const item of cat.items) {
      map[item.key] = { ...item, category: cat.category };
    }
  }
  return map;
}

async function refreshTracker(client) {
  const data = latestData;
  if (!data) return;
  const current = buildItemMap(data);

  resetStatsIfNewDay();
  // Check for newly in-stock items
  for (const [key, item] of Object.entries(current)) {
    const was = previousStock[key]?.quantity > 0;
    const now = item.quantity > 0;
    if (now && !was) {
      restockCounts[key] = (restockCounts[key] || 0) + 1;
      // Log to restock history
      q('INSERT INTO restock_history (item_key, item_name, quantity, rarity, category, ts) VALUES (?,?,?,?,?,?)',
        [key, item.name, item.quantity, item.rarity, item.category, Date.now()]).catch(() => {});
      if (!activePings[key]) {
        console.log('[!] ' + item.name + ' in stock');
        startPingLoop(key, item, client);
      }
    }
    if (!now && activePings[key]) {
      console.log('[!] ' + item.name + ' out of stock — stopping pings');
      stopPingLoop(key);
    }
  }
  previousStock = current;

  // Weather changes — ping every 10s while active (skip first run)
  const curW = data.weather?.current?.type;
  if (curW) {
    if (!lastWeatherKey) { lastWeatherKey = curW; }
    else if (curW !== lastWeatherKey) {
      q('INSERT INTO weather_history (weather_type, weather_name, ts) VALUES (?,?,?)',
        [curW, data.weather.current.name, Date.now()]).catch(() => {});
      stopWeatherLoop(lastWeatherKey, client);
      lastWeatherKey = curW;
      startWeatherLoop(curW, data.weather.current, client);
    }
  } else if (lastWeatherKey) {
    stopWeatherLoop(lastWeatherKey, client);
    lastWeatherKey = '';
  }
  // Sell changes (skip first run)
  if (data.sell?.entries) {
    const sellMap = {};
    for (const e of data.sell.entries) sellMap[e.key] = e.multiplier;
    if (Object.keys(lastSell).length === 0) { lastSell = sellMap; return; }
    else if (JSON.stringify(sellMap) !== JSON.stringify(lastSell)) {
      lastSell = sellMap;
      // Log all sell entries to history
      for (const e of data.sell.entries) {
        q('INSERT INTO sell_history (item_key, item_name, multiplier, ts) VALUES (?,?,?,?)',
          [e.key, e.name, e.multiplier, Date.now()]).catch(() => {});
      }
      if (!isFresh()) return;
      checkSell(data.sell.entries, client);
    }
  }
}

function startPingLoop(key, item, client) {
  if (activePings[key]) return;
  activePings[key] = setInterval(async () => {
    const current = latestData;
    if (!current) return;
    let found = null;
    for (const cat of current.stock || []) {
      for (const i of cat.items || []) {
        if (i.key === key) { found = { ...i, category: cat.category }; break; }
      }
      if (found) break;
    }
    if (!found || found.quantity <= 0) {
      stopPingLoop(key);
      return;
    }
    if (!isFresh()) return;
    await sendPing(key, found, client);
  }, 10000);
  // Also send immediately
  sendPing(key, item, client);
}

function stopPingLoop(key) {
  if (activePings[key]) {
    clearInterval(activePings[key]);
    delete activePings[key];
  }
}

async function sendPing(key, item, client) {
  const nm = item.name || key;
  const ct = item.category || '';
  const em = item.emoji || '\u{1F4E6}';
  const now = Date.now();

  for (const [, guild] of client.guilds.cache) {
    const channelId = await getChannelId(guild.id);
    const users = await getAllSubscribers(guild.id);
    const catUsers = await getAllCategorySubs(guild.id);
    // Get ping cooldown (default 120s)
    const cdSetting = await getGuildSetting(guild.id, 'ping_cooldown');
    const pingCD = (parseInt(cdSetting) || 2) * 60000;
    const matched = [];

    // Direct item subscribers
    for (const [uid, items] of Object.entries(users)) {
      if (!isSnoozed(guild.id, uid) && items.some(i => i === key.toLowerCase() || i === nm.toLowerCase())) {
        matched.push(uid);
      }
    }
    // Category subscribers (e.g. "seed" matches all seed items)
    for (const [uid, cats] of Object.entries(catUsers)) {
      if (!matched.includes(uid) && !isSnoozed(guild.id, uid) && cats.some(c => c === ct.toLowerCase())) {
        matched.push(uid);
      }
    }

    if (matched.length === 0) continue;

    // 2-min cooldown per item per guild (configurable via /settings cooldown)
    const cdKey = key + ':' + guild.id;
    if (lastPingTime[cdKey] && now - lastPingTime[cdKey] < pingCD) continue;
    lastPingTime[cdKey] = now;

    // Check notification preferences per user
    const wantChannel = [];
    const wantDM = [];
    for (const uid of matched) {
      const mode = await getNotifMode(guild.id, uid);
      if (mode === 'channel' || mode === 'both') wantChannel.push(uid);
      if (mode === 'dm' || mode === 'both') wantDM.push(uid);
    }

    if (channelId && wantChannel.length > 0) {
      const ch = await guild.channels.fetch(channelId).catch(() => null);
      if (ch) {
        const rn = roleName(key);
        const role = guild.roles.cache.find(r => r.name === rn);
        rateLimitSend(ch, () => ch.send({
          content: role ? '<@&' + role.id + '>' : '',
          embeds: [{
            color: ct === 'seed' ? 0x10b981 : ct === 'gear' ? 0x0ea5e9 : 0xf97316,
            title: em + ' ' + nm + ' IN STOCK!',
            description: '**' + (ct.charAt(0).toUpperCase() + ct.slice(1)) + '** \u00D7' + item.quantity + (item.rarity ? ' (' + item.rarity + ')' : ''),
            timestamp: new Date().toISOString(),
          }],
        }).catch(() => {}));
      }
    }

    for (const uid of wantDM) {
      try {
        const user = await client.users.fetch(uid);
        if (user) {
          user.send({
            embeds: [{
              color: 0x10b981,
              title: em + ' ' + nm + ' IN STOCK!',
              description: '**' + (ct.charAt(0).toUpperCase() + ct.slice(1)) + '** \u00D7' + item.quantity + (item.rarity ? ' (' + item.rarity + ')' : ''),
              timestamp: new Date().toISOString(),
            }],
          }).catch(() => {});
        }
      } catch {}
    }
  }
}

async function checkWeather(w, client) {
  const em = w.emoji || '\u{1F326}\uFE0F';
  const nm = w.name;
  const ends = w.endsAt ? '<t:' + Math.floor(new Date(w.endsAt).getTime() / 1000) + ':R>' : '';
  for (const [, guild] of client.guilds.cache) {
    const channelId = await getChannelId(guild.id);
    const subs = await getAllWeatherSubs(guild.id);
    const matched = Object.entries(subs).filter(([, list]) => list.some(s => s === w.type || s === nm.toLowerCase())).map(([uid]) => uid);
    if (matched.length === 0 && !channelId) continue;
    const wantChannel = [];
    const wantDM = [];
    for (const uid of matched) {
      const mode = await getNotifMode(guild.id, uid);
      if (mode === 'channel' || mode === 'both') wantChannel.push(uid);
      if (mode === 'dm' || mode === 'both') wantDM.push(uid);
    }
    if (channelId && wantChannel.length > 0) {
      if (weatherMessages[guild.id]) {
        try {
          const ch = await guild.channels.fetch(channelId).catch(() => null);
          if (ch) { const old = await ch.messages.fetch(weatherMessages[guild.id]).catch(() => null); if (old) await old.delete().catch(() => {}); }
        } catch {}
      }
      const ch = await guild.channels.fetch(channelId).catch(() => null);
      if (ch) {
        const rn = 'gag2-' + w.type;
        const role = guild.roles.cache.find(r => r.name === rn);
        let msg;
        rateLimitSend(ch, async () => {
          msg = await ch.send({
            content: role ? '<@&' + role.id + '>' : '',
            embeds: [{ color: parseInt(w.color?.slice(1) || 'e88bff', 16) || 0xe88bff, title: em + ' ' + nm, description: (w.blurb || '') + (ends ? '\nEnds ' + ends : ''), timestamp: new Date().toISOString() }],
          }).catch(() => null);
          if (msg) weatherMessages[guild.id] = msg.id;
        });
      }
    }
    for (const uid of wantDM) {
      try {
        const user = await client.users.fetch(uid);
        if (user) user.send({ embeds: [{ color: 0xe88bff, title: em + ' ' + nm, description: (w.blurb || '') + (ends ? '\nEnds ' + ends : ''), timestamp: new Date().toISOString() }] }).catch(() => {});
      } catch {}
    }
  }
}

function startWeatherLoop(type, w, client) {
  if (activeWeatherPings[type]) return;
  checkWeather(w, client);
  activeWeatherPings[type] = setInterval(async () => {
    const cur = latestData?.weather?.current;
    if (!cur || cur.type !== type) { stopWeatherLoop(type, client); return; }
    if (!isFresh()) return;
    checkWeather(cur, client);
  }, 10000);
}

async function stopWeatherLoop(type, client) {
  if (activeWeatherPings[type]) {
    clearInterval(activeWeatherPings[type]);
    delete activeWeatherPings[type];
  }
}

let sendQueue = Promise.resolve();
function rateLimitSend(ch, cb) {
  sendQueue = sendQueue.then(() => new Promise(async res => { try { await cb(); } catch {} setTimeout(res, 1500); }));
}

async function checkSell(entries, client) {
  for (const [, guild] of client.guilds.cache) {
    const channelId = await getChannelId(guild.id);
    const subs = await getAllSellSubs(guild.id);

    // Parse sell subs to support :threshold syntax
    const parsedSubs = {};
    for (const [uid, list] of Object.entries(subs)) {
      parsedSubs[uid] = list.map(parseSellSub);
    }

    const matched = [];
    for (const e of entries) {
      for (const [uid, list] of Object.entries(parsedSubs)) {
        for (const sub of list) {
          const match = sub.key === e.key || sub.key === e.name.toLowerCase();
          if (match && (!sub.threshold || e.multiplier >= sub.threshold)) {
            matched.push({ uid, entry: e });
          }
        }
      }
    }
    if (matched.length === 0) continue;
    const sellUIDs = [...new Set(matched.map(m => m.uid))];
    const sellWantChan = [], sellWantDM = [];
    for (const uid of sellUIDs) {
      const mode = await getNotifMode(guild.id, uid);
      if (mode === 'channel' || mode === 'both') sellWantChan.push(uid);
      if (mode === 'dm' || mode === 'both') sellWantDM.push(uid);
    }
    if (channelId && sellWantChan.length > 0) {
      const ch = await guild.channels.fetch(channelId).catch(() => null);
      if (ch) {
        const roleMentions = [];
        const seenKeys = new Set();
        for (const m of matched) {
          if (!seenKeys.has(m.entry.key)) {
            seenKeys.add(m.entry.key);
            const rn = 'gag2-' + m.entry.key;
            const role = guild.roles.cache.find(r => r.name === rn);
            if (role) roleMentions.push('<@&' + role.id + '>');
          }
        }
        const grouped = {};
        for (const m of matched) { if (!grouped[m.entry.key]) grouped[m.entry.key] = []; grouped[m.entry.key].push(m.entry); }
        const desc = Object.values(grouped).flat().map(e => '**' + e.name + '** \u00D7' + e.multiplier.toFixed(2)).join('\n');
        rateLimitSend(ch, () => ch.send({ content: roleMentions.join(' '), embeds: [{ color: 0xf59e0b, title: '\u{1F4B0} Sell multiplier update', description: desc, timestamp: new Date().toISOString() }] }).catch(() => {}));
      }
    }
    const grouped = {};
    for (const m of matched) { if (!grouped[m.uid]) grouped[m.uid] = []; grouped[m.uid].push(m.entry); }
    for (const uid of sellWantDM) {
      const items = grouped[uid] || [];
      if (!items.length) continue;
      try {
        const user = await client.users.fetch(uid);
        if (user) user.send({ embeds: [{ color: 0xf59e0b, title: '\u{1F4B0} Sell multiplier update', description: items.map(e => '**' + e.name + '** \u00D7' + e.multiplier.toFixed(2)).join('\n'), timestamp: new Date().toISOString() }] }).catch(() => {});
      } catch {}
    }
  }
}

async function updateDashboard(client) {
  const d = latestData;
  if (!d) return;
  for (const [, guild] of client.guilds.cache) {
    const dashSetting = await getGuildSetting(guild.id, 'dashboard');
    if (dashSetting === 'off') continue;
    const channelId = await getChannelId(guild.id);
    if (!channelId) continue;
    const ch = await guild.channels.fetch(channelId).catch(() => null);
    if (!ch) continue;
    const stockLines = [];
    if (d.stock) for (const s of d.stock) {
      const labels = { seed: '\u{1F331} Seeds', gear: '\u{1F527} Gear', crate: '\u{1F4E6} Crates' };
      const inStock = s.items.filter(i => i.quantity > 0);
      stockLines.push('**' + (labels[s.category] || s.category) + ':** ' + inStock.length + '/' + s.items.length + ' in stock');
    }
    let weatherLine = '';
    if (d.weather?.current) {
      const w = d.weather.current;
      weatherLine = (w.emoji || '') + ' **' + w.name + '** \u2014 ' + (w.blurb || '');
    }
    const topSell = d.sell?.entries ? [...d.sell.entries].sort((a, b) => b.multiplier - a.multiplier).slice(0, 3) : [];
    const embed = {
      color: 0x6366f1, title: '\u{1F4CA} GAG2 Dashboard',
      fields: [
        { name: '\u{1F4E6} Stock', value: stockLines.join('\n') || 'Loading...', inline: false },
        ...(weatherLine ? [{ name: '\u{1F326}\uFE0F Weather', value: weatherLine, inline: false }] : []),
        ...(topSell.length ? [{ name: '\u{1F4B0} Top Sell', value: topSell.map(e => '**' + e.name + '** x' + e.multiplier.toFixed(2)).join('\n'), inline: false }] : []),
      ],
      footer: { text: 'Auto-updates every 15s' }, timestamp: new Date().toISOString(),
    };
    rateLimitSend(ch, async () => {
      if (dashboardMessages[guild.id]) {
        try {
          const msg = await ch.messages.fetch(dashboardMessages[guild.id]).catch(() => null);
          if (msg) { await msg.edit({ embeds: [embed] }).catch(() => {}); return; }
        } catch {}
      }
      const msg = await ch.send({ embeds: [embed] }).catch(() => null);
      if (msg) dashboardMessages[guild.id] = msg.id;
    });
  }
}

// ── Chart rendering (simple unicode bar charts via embed) ──
function chartEmbed(title, labels, values, w) {
  w = w || 14;
  const max = Math.max(...values, 1);
  const lines = [];
  for (let i = 0; i < labels.length; i++) {
    const bar = '\u2588'.repeat(Math.round((values[i] / max) * w));
    lines.push((labels[i] + ':').padEnd(8) + bar + ' ' + values[i]);
  }
  return { embeds: [{ color: 0x6366f1, title: title, description: '```\n' + lines.join('\n') + '\n```' }] };
}

// ── Commands ──
const cmdSetup = {
  data: new SlashCommandBuilder().setName('setup').setDescription('Set up GAG2 stock channel').setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels | PermissionFlagsBits.ManageRoles),
  async execute(i) {
    await i.deferReply({ ephemeral: true });
    const ex = i.guild.channels.cache.find(c => c.name === 'gag2-stock' && c.type === ChannelType.GuildText);
    if (ex) { await setChannel(i.guild.id, ex.id); } else {
      const cat = i.guild.channels.cache.find(c => c.name === 'GAG2 Stock' && c.type === ChannelType.GuildCategory) || await i.guild.channels.create({ name: 'GAG2 Stock', type: ChannelType.GuildCategory });
      const ch = await i.guild.channels.create({ name: 'gag2-stock', type: ChannelType.GuildText, parent: cat.id });
      await setChannel(i.guild.id, ch.id);
    }
    await i.editReply('Setup done. Use /subscribe to get pings for specific items.');
  }
};
const cmdStock = {
  data: new SlashCommandBuilder().setName('stock').setDescription('View GAG2 stock'),
  async execute(i) {
    await i.deferReply();
    try {
      const d = latestData;
      if (!d || !d.stock || !d.stock.length) return i.editReply('Stock data not loaded yet. Try again in a few seconds.');
      const embeds = [];
      for (const s of d.stock) {
        if (!s || !s.items) continue;
        const colors = { seed: 0x10b981, gear: 0x0ea5e9, crate: 0xf97316 };
        const labels = { seed: '\u{1F331} Seed Shop', gear: '\u{1F527} Gear Shop', crate: '\u{1F4E6} Crates' };
        const nx = s.nextRestockAt ? '<t:' + Math.floor(new Date(s.nextRestockAt).getTime() / 1000) + ':R>' : '?';
        const items = s.items.length ? s.items.map(it => (it.emoji || '') + ' **' + it.name + '** x' + it.quantity + (it.rarity ? ' (' + it.rarity + ')' : '')).join('\n') : 'Empty';
        embeds.push({ color: colors[s.category] || 0x6b7280, title: labels[s.category] || s.category, description: items, fields: [{ name: 'Restock', value: nx, inline: true }], timestamp: new Date().toISOString() });
      }
      if (!embeds.length) return i.editReply('Stock data is empty.');
      await i.editReply({ embeds });
    } catch (e) { console.error('[Stock] Error:', e.message); await i.editReply('Error loading stock. Try again.'); }
  }
};
const cmdSub = {
  data: new SlashCommandBuilder().setName('subscribe').setDescription('Subscribe to item').addStringOption(o => o.setName('item').setDescription('Item').setRequired(true).setAutocomplete(true)),
  async autocomplete(i) {
    const f = i.options.getFocused().toLowerCase();
    const keys = await searchItems(f);
    const all = await getAllItems();
    const items = [];
    for (const k of keys) {
      const m = all.find(it => it.id === k);
      if (m) items.push({ name: (m.emoji || '') + ' ' + m.name + ' (' + m.category + ')', value: m.id });
    }
    await i.respond(items.slice(0, 25));
  },
  async execute(i) {
    const k = i.options.getString('item');
    const m = await findItem(k);
    if (!m) return i.reply({ content: 'Item "' + k + '" not found anywhere on GAG2.', ephemeral: true });
    const added = await addUserItem(i.guild.id, i.user.id, m.key);
    if (added) {
      const rn = roleName(m.key);
      let role = i.guild.roles.cache.find(r => r.name === rn);
      if (!role) role = await i.guild.roles.create({ name: rn, mentionable: true, reason: 'GAG2 ping for ' + (m.name || m.key) }).catch(() => null);
      if (role && i.member) await i.member.roles.add(role.id).catch(() => {});
    }
    const ct = (m.category || '').charAt(0).toUpperCase() + (m.category || '').slice(1);
    const stockStr = m.stock > 0 ? '\u2705 In stock (\u00D7' + m.stock + ')' : '\u274C Out of stock';
    return i.reply({ content: added ? '\u2705 Watching **' + m.name + '**' : 'Already watching.', embeds: [{ color: m.stock > 0 ? 0x10b981 : 0xef4444, title: (m.emoji || '') + ' ' + m.name, fields: [
      { name: 'Stock', value: stockStr, inline: true },
      { name: 'Rarity', value: m.rarity || 'N/A', inline: true },
      { name: 'Category', value: ct, inline: true },
      ...(m.value ? [{ name: 'Value', value: '' + m.value, inline: true }] : []),
    ], timestamp: new Date().toISOString() }], ephemeral: true });


  }
};
const cmdUnsub = {
  data: new SlashCommandBuilder().setName('unsubscribe').setDescription('Unsubscribe').addStringOption(o => o.setName('item').setDescription('Item').setRequired(true).setAutocomplete(true)),
  async autocomplete(i) {
    const f = i.options.getFocused().toLowerCase();
    const items = (await getUserItems(i.guild.id, i.user.id)).filter(x => x.includes(f));
    await i.respond(items.map(x => ({ name: x, value: x })).slice(0, 25));
  },
  async execute(i) {
    const it = i.options.getString('item');
    const removed = await removeUserItem(i.guild.id, i.user.id, it);
    if (removed) {
      const rn = roleName(it);
      const role = i.guild.roles.cache.find(r => r.name === rn);
      if (role && i.member) await i.member.roles.remove(role.id).catch(() => {});
    }
    return i.reply({ content: removed ? '\u2705 Unsubscribed' : 'Not subscribed.', ephemeral: true });
  }
};
const cmdList = {
  data: new SlashCommandBuilder().setName('list').setDescription('Your items'),
  async execute(i) {
    const items = await getUserItems(i.guild.id, i.user.id);
    const w = await getWeatherSubs(i.guild.id, i.user.id);
    const s = await getSellSubs(i.guild.id, i.user.id);
    const cats = await getCategorySubs(i.guild.id, i.user.id);
    const lines = [];
    if (items.length) lines.push('**Stock:**', ...items.map(x => '\u2022 ' + x));
    if (cats.length) lines.push('**Categories:**', ...cats.map(x => '\u2022 ' + x));
    if (w.length) lines.push('**Weather:**', ...w.map(x => '\u2022 ' + x));
    if (s.length) lines.push('**Sell:**', ...s.map(x => { const p = parseSellSub(x); return '\u2022 ' + p.key + (p.threshold ? ' (\u2265\u00D7' + p.threshold + ')' : ''); }));
    if (!lines.length) return i.reply({ content: 'No subscriptions. Use /subscribe, /subcategory, /subweather, /subsell', ephemeral: true });
    return i.reply({ embeds: [{ color: 0x10b981, title: 'Your Subscriptions', description: lines.join('\n') }], ephemeral: true });
  }
};
const cmdWeather = {
  data: new SlashCommandBuilder().setName('weather').setDescription('Current weather'),
  async execute(i) {
    const d = latestData;
    if (!d?.weather?.current) return i.reply({ content: 'Weather data not available.', ephemeral: true });
    const w = d.weather.current;
    return i.reply({ embeds: [{ color: parseInt(w.color?.slice(1) || 'e88bff', 16) || 0xe88bff, title: (w.emoji || '') + ' ' + w.name, description: w.blurb || '', fields: [
      { name: 'Ends', value: '<t:' + Math.floor(new Date(w.endsAt).getTime() / 1000) + ':R>', inline: true },
      ...(w.boost ? [{ name: 'Boost', value: w.boost, inline: true }] : []),
    ], timestamp: new Date().toISOString() }], ephemeral: true });
  }
};
const cmdSubWeather = {
  data: new SlashCommandBuilder().setName('subweather').setDescription('Subscribe to weather type').addStringOption(o => o.setName('type').setDescription('Weather type (rainbow, starfall, bloodmoon, etc.)').setRequired(true)),
  async execute(i) {
    const w = i.options.getString('type').toLowerCase().trim();
    const valid = ['rainbow', 'starfall', 'bloodmoon', 'rain', 'lightning', 'snowfall', 'mega_moon', 'rainbow_moon', 'goldmoon', 'aurora', 'eclipse', 'sunburst'];
    if (!valid.includes(w)) return i.reply({ content: 'Valid types: ' + valid.join(', '), ephemeral: true });
    const added = await addWeatherSub(i.guild.id, i.user.id, w);
    if (added) {
      const rn = 'gag2-' + w;
      let role = i.guild.roles.cache.find(r => r.name === rn);
      if (!role) role = await i.guild.roles.create({ name: rn, mentionable: true, reason: 'GAG2 weather ping for ' + w }).catch(() => null);
      if (role && i.member) await i.member.roles.add(role.id).catch(() => {});
    }
    return i.reply({ content: added ? '\u2705 You\'ll be pinged when **' + w + '** starts' : 'Already subscribed to **' + w + '**.', ephemeral: true });
  }
};
const cmdUnsubWeather = {
  data: new SlashCommandBuilder().setName('unsubweather').setDescription('Unsubscribe from weather').addStringOption(o => o.setName('type').setDescription('Weather type').setRequired(true).setAutocomplete(true)),
  async autocomplete(i) {
    const f = i.options.getFocused().toLowerCase();
    const items = (await getWeatherSubs(i.guild.id, i.user.id)).filter(x => x.includes(f));
    await i.respond(items.map(x => ({ name: x, value: x })).slice(0, 25));
  },
  async execute(i) {
    const w = i.options.getString('type');
    const removed = await removeWeatherSub(i.guild.id, i.user.id, w);
    if (removed) {
      const rn = 'gag2-' + w;
      const role = i.guild.roles.cache.find(r => r.name === rn);
      if (role && i.member) await i.member.roles.remove(role.id).catch(() => {});
    }
    return i.reply({ content: removed ? '\u2705 Unsubscribed from **' + w + '**' : 'Not subscribed to **' + w + '**.', ephemeral: true });
  }
};
const cmdSubSell = {
  data: new SlashCommandBuilder().setName('subsell').setDescription('Subscribe to sell multiplier')
    .addStringOption(o => o.setName('crop').setDescription('Crop name').setRequired(true).setAutocomplete(true))
    .addNumberOption(o => o.setName('threshold').setDescription('Min multiplier (e.g. 1.5)').setRequired(false).setMinValue(0)),
  async autocomplete(i) {
    const f = i.options.getFocused().toLowerCase();
    if (i.options.getFocused(true).name === 'threshold') return i.respond([]);
    const d = latestData;
    const set = new Set();
    const items = [];
    if (d?.sell?.entries) for (const e of d.sell.entries) { if (e.name.toLowerCase().includes(f) || e.key.includes(f)) { set.add(e.key); items.push({ name: e.name + ' (\u00D7' + e.multiplier.toFixed(2) + ')', value: e.key }); } }
    const all = await getAllItems();
    for (const it of all) { if (!set.has(it.id) && (it.name?.toLowerCase().includes(f) || it.id.includes(f))) items.push({ name: (it.emoji || '') + ' ' + it.name + ' (' + it.category + ')', value: it.id }); }
    await i.respond(items.slice(0, 25));
  },
  async execute(i) {
    const k = i.options.getString('crop').toLowerCase().trim();
    const th = i.options.getNumber('threshold');
    const added = await addSellSub(i.guild.id, i.user.id, k, th || null);
    if (added) {
      const rn = 'gag2-' + k;
      let role = i.guild.roles.cache.find(r => r.name === rn);
      if (!role) role = await i.guild.roles.create({ name: rn, mentionable: true, reason: 'GAG2 sell ping for ' + k }).catch(() => null);
      if (role && i.member) await i.member.roles.add(role.id).catch(() => {});
    }
    return i.reply({ content: added ? '\u2705 Watching **' + k + '**' + (th ? ' (\u2265\u00D7' + th + ')' : '') : 'Already watching.', ephemeral: true });
  }
};
const cmdSell = {
  data: new SlashCommandBuilder().setName('sell').setDescription('Current sell multipliers'),
  async execute(i) {
    const d = latestData;
    if (!d?.sell?.entries) return i.reply({ content: 'Sell data not available.', ephemeral: true });
    const top = [...d.sell.entries].sort((a, b) => b.multiplier - a.multiplier).slice(0, 25);
    return i.reply({ embeds: [{ color: 0xf59e0b, title: '\u{1F4B0} Sell Multipliers', description: top.map(e => '**' + e.name + '** \u00D7' + e.multiplier.toFixed(2) + (e.tier === 'mega' ? ' (mega)' : '')).join('\n'), footer: { text: 'Cycle refreshes every 10 min' }, timestamp: new Date().toISOString() }], ephemeral: true });
  }
};
const cmdGraph = {
  data: new SlashCommandBuilder().setName('graph').setDescription('View charts from historical data')
    .addSubcommand(s => s.setName('item').setDescription('Restock quantity line chart').addStringOption(o => o.setName('item').setDescription('Item').setRequired(true).setAutocomplete(true)))
    .addSubcommand(s => s.setName('frequency').setDescription('Restocks by day of week').addStringOption(o => o.setName('item').setDescription('Item').setRequired(true).setAutocomplete(true)))
    .addSubcommand(s => s.setName('sell').setDescription('Sell multiplier history').addStringOption(o => o.setName('item').setDescription('Item').setRequired(true).setAutocomplete(true)))
    .addSubcommand(s => s.setName('weather').setDescription('Weather frequency')),
  async autocomplete(i) {
    try {
      const sub = i.options.getSubcommand();
      if (!sub || sub === 'weather') return i.respond([]);
      const f = i.options.getFocused().toLowerCase();
      // Cache-only: use latestData stock + allItemsCache, never fetch API
      const live = latestData;
      const results = [];
      if (live?.stock) {
        for (const cat of live.stock) {
          for (const it of cat.items) {
            if (it.key.toLowerCase().includes(f) || it.name.toLowerCase().includes(f)) results.push(it.key);
          }
        }
      }
      if (allItemsCache) {
        for (const it of allItemsCache) {
          if (!results.includes(it.id) && (it.id.includes(f) || it.slug?.includes(f) || it.name?.toLowerCase().includes(f))) results.push(it.id);
        }
      }
      const all = allItemsCache || [];
      const items = [];
      for (const k of results) { const m = all.find(it => it.id === k); if (m) items.push({ name: (m.emoji || '') + ' ' + m.name + ' (' + m.category + ')', value: m.id }); }
      await i.respond(items.slice(0, 25));
    } catch { await i.respond([]); }
  },
  async execute(i) {
    try {
      await i.deferReply({ ephemeral: true });
      const sub = i.options.getSubcommand();
      if (!sub) return i.editReply('Select a subcommand: item, frequency, sell, or weather.');

      function makeChart(title, labels, vals, w) {
        const ch = chartEmbed(title, labels, vals, w);
        ch.embeds[0].color = 0x6366f1;
        return ch;
      }

      function sampleFor(title, data) {
        const ch = makeChart(title, data.labels, data.vals, data.w);
        ch.embeds[0].footer = { text: 'Sample data (real data collected every 10 min)' };
        return ch;
      }

      if (sub === 'item') {
        const k = i.options.getString('item');
        const m = (latestData?.stock ? findItemCached(k) : null) || await findItem(k).catch(() => null);
        if (!m) return i.editReply({ embeds: [{ color: 0x6366f1, title: 'Item not found', description: 'Try autocomplete.' }] });
        const url = WEB_URL + '/graph/' + encodeURIComponent(m.key);
        return i.editReply({
          embeds: [{
            color: 0x6366f1, title: (m.emoji||'') + ' ' + m.name,
            description: '\u{1F4CA} [View quantity history graph](' + url + ')'
          }]
        });
      } else if (sub === 'frequency') {
        const k = i.options.getString('item');
        const m = (latestData?.stock ? findItemCached(k) : null) || await findItem(k);
        if (!m) return i.editReply({ embeds: [{ color: 0x6366f1, title: 'Item not found', description: 'Try autocomplete.' }] });
        let rows;
        try { [rows] = await q('SELECT ts FROM restock_history WHERE item_key=? AND ts > ?', [m.key, Date.now() - 604800000]); } catch { rows = []; }
        if (!rows || !rows.length) return i.editReply(sampleFor((m.emoji||'')+' '+m.name+' Restocks by Day (sample)', { labels: ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'], vals: [1,3,2,0,4,1,2] }));
        const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
        const counts = [0,0,0,0,0,0,0];
        for (const r of rows) { try { const d = new Date(Number(r.ts)); if (!isNaN(d.getTime())) counts[d.getDay()]++; } catch {} }
        const ch = makeChart((m.emoji||'')+' '+m.name+' Restocks by Day', dayNames, counts);
        ch.embeds[0].footer = { text: 'Last 7 days' };
        return i.editReply(ch);
      } else if (sub === 'sell') {
        const k = i.options.getString('item');
        const m = (latestData?.stock ? findItemCached(k) : null) || await findItem(k);
        const key = m ? m.key : k.toLowerCase().trim();
        let rows;
        try { [rows] = await q('SELECT multiplier, ts FROM sell_history WHERE item_key=? AND ts > ? ORDER BY ts ASC LIMIT 30', [key, Date.now() - 604800000]); } catch { rows = []; }
        if (!rows || !rows.length) return i.editReply(sampleFor('\u{1F4B0} '+(m?.name||key)+' Sell Multiplier (sample)', { labels: ['Mon','Tue','Wed','Thu','Fri'], vals: [1.2, 2.5, 3.0, 1.8, 4.2] }));
        const labels = rows.map(r => { try { const d = new Date(Number(r.ts)); return isNaN(d.getTime()) ? '?' : (d.getMonth()+1)+'/'+d.getDate(); } catch { return '?'; } });
        const vals = rows.map(r => r.multiplier || 0);
        const ch = makeChart('\u{1F4B0} '+(m?.name||key)+' Sell Multiplier', labels, vals);
        ch.embeds[0].footer = { text: 'Last 7 days' };
        return i.editReply(ch);
      } else if (sub === 'weather') {
        let rows;
        try { [rows] = await q('SELECT weather_name, COUNT(*) as cnt FROM weather_history WHERE ts > ? GROUP BY weather_name ORDER BY cnt DESC LIMIT 10', [Date.now() - 604800000]); } catch { rows = []; }
        if (!rows || !rows.length) return i.editReply(sampleFor('\u{1F326}\uFE0F Weather Frequency (sample)', { labels: ['Rain','Clear','Bloodmoon','Starfall'], vals: [4,7,1,2], w: 12 }));
        const ch = makeChart('\u{1F326}\uFE0F Weather Frequency (7d)', rows.map(r => r.weather_name), rows.map(r => Number(r.cnt)), 12);
        ch.embeds[0].footer = { text: 'Last 7 days' };
        return i.editReply(ch);
      } else {
        return i.editReply('Unknown subcommand. Use: item, frequency, sell, or weather.');
      }
    } catch (e) { console.error('[Graph] Error:', e.message); try { await i.editReply({ embeds: [{ color: 0xef4444, title: 'Error', description: 'Error generating graph: ' + e.message }] }); } catch {} }
  }
};
const cmdStats = {
  data: new SlashCommandBuilder().setName('stats').setDescription('Today\'s restock counts'),
  async execute(i) {
    resetStatsIfNewDay();
    const entries = Object.entries(restockCounts).sort((a, b) => b[1] - a[1]).slice(0, 25);
    if (!entries.length) return i.reply({ content: 'No restocks tracked yet today.', ephemeral: true });
    return i.reply({ embeds: [{ color: 0x3b82f6, title: '\u{1F4CA} Today\'s Restocks (' + (todayStr || getToday()) + ')', description: entries.map(([k, v]) => '**' + k + '** \u00D7' + v + ' restocks').join('\n'), timestamp: new Date().toISOString() }], ephemeral: true });
  }
};
const cmdCleanup = {
  data: new SlashCommandBuilder().setName('cleanup').setDescription('Delete unused gag2 roles').setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),
  async execute(i) {
    await i.deferReply({ ephemeral: true });
    const prefix = 'gag2-';
    let removed = 0;
    for (const [, r] of i.guild.roles.cache) {
      if (r.name.startsWith(prefix) && r.members.size === 0) {
        await r.delete().catch(() => {});
        removed++;
      }
    }
    await i.editReply('\u2705 Deleted **' + removed + '** unused roles.');
  }
};
const cmdSubCategory = {
  data: new SlashCommandBuilder().setName('subcategory').setDescription('Subscribe to a category (seed/gear/crate)').addStringOption(o => o.setName('category').setDescription('seed, gear, or crate').setRequired(true).addChoices({ name: 'Seed', value: 'seed' }, { name: 'Gear', value: 'gear' }, { name: 'Crate', value: 'crate' })),
  async execute(i) {
    const c = i.options.getString('category').toLowerCase().trim();
    const added = await addCategorySub(i.guild.id, i.user.id, c);
    if (added) {
      const rn = 'gag2-cat-' + c;
      let role = i.guild.roles.cache.find(r => r.name === rn);
      if (!role) role = await i.guild.roles.create({ name: rn, mentionable: true, reason: 'GAG2 category ping for ' + c }).catch(() => null);
      if (role && i.member) await i.member.roles.add(role.id).catch(() => {});
    }
    return i.reply({ content: added ? '\u2705 Watching **' + c + '** category — pinged for any ' + c + ' restock' : 'Already watching.', ephemeral: true });
  }
};
const cmdUnsubCategory = {
  data: new SlashCommandBuilder().setName('unsubcategory').setDescription('Unsubscribe from category').addStringOption(o => o.setName('category').setDescription('Category').setRequired(true).setAutocomplete(true)),
  async autocomplete(i) {
    const f = i.options.getFocused().toLowerCase();
    const items = (await getCategorySubs(i.guild.id, i.user.id)).filter(x => x.includes(f));
    await i.respond(items.map(x => ({ name: x, value: x })).slice(0, 25));
  },
  async execute(i) {
    const c = i.options.getString('category').toLowerCase().trim();
    const removed = await removeCategorySub(i.guild.id, i.user.id, c);
    if (removed) {
      const rn = 'gag2-cat-' + c;
      const role = i.guild.roles.cache.find(r => r.name === rn);
      if (role && i.member) await i.member.roles.remove(role.id).catch(() => {});
    }
    return i.reply({ content: removed ? '\u2705 Unsubscribed from **' + c + '**' : 'Not subscribed.', ephemeral: true });
  }
};
const cmdSnooze = {
  data: new SlashCommandBuilder().setName('snooze').setDescription('Silence pings for N hours').addNumberOption(o => o.setName('hours').setDescription('Hours to snooze').setRequired(true).setMinValue(1).setMaxValue(24)),
  async execute(i) {
    const h = i.options.getNumber('hours');
    setSnooze(i.guild.id, i.user.id, h * 3600000);
    return i.reply({ content: '\u{1F634} Snoozed for **' + h + '** hour' + (h > 1 ? 's' : '') + '. Use /unsnooze to wake up.', ephemeral: true });
  }
};
const cmdUnsnooze = {
  data: new SlashCommandBuilder().setName('unsnooze').setDescription('Wake up — stop snoozing'),
  async execute(i) {
    clearSnooze(i.guild.id, i.user.id);
    return i.reply({ content: '\u2705 You\'re awake! Pings resumed.', ephemeral: true });
  }
};
const cmdInfo = {
  data: new SlashCommandBuilder().setName('info').setDescription('Full item info').addStringOption(o => o.setName('item').setDescription('Item name').setRequired(true).setAutocomplete(true)),
  async autocomplete(i) {
    const f = i.options.getFocused().toLowerCase();
    const keys = await searchItems(f);
    const all = await getAllItems();
    const items = [];
    for (const k of keys) {
      const m = all.find(it => it.id === k);
      if (m) items.push({ name: (m.emoji || '') + ' ' + m.name + ' (' + m.category + ')', value: m.id });
    }
    await i.respond(items.slice(0, 25));
  },
  async execute(i) {
    const k = i.options.getString('item');
    const m = await findItem(k);
    if (!m) return i.reply({ content: 'Not found.', ephemeral: true });
    const ct = (m.category || '').charAt(0).toUpperCase() + (m.category || '').slice(1);
    const stock = m.stock > 0 ? '\u2705 \u00D7' + m.stock : '\u274C Out of stock';
    return i.reply({ embeds: [{ color: 0x6366f1, title: (m.emoji || '') + ' ' + m.name, fields: [
      { name: 'Category', value: ct, inline: true },
      { name: 'Rarity', value: m.rarity || 'N/A', inline: true },
      { name: 'Stock', value: stock, inline: true },
      ...(m.value ? [{ name: 'Trade Value', value: '' + m.value, inline: true }] : []),
      { name: 'Key', value: m.key, inline: true },
    ], timestamp: new Date().toISOString() }], ephemeral: true });
  }
};
const cmdAlerts = {
  data: new SlashCommandBuilder().setName('alerts').setDescription('All tracked items & subscriber counts'),
  async execute(i) {
    const items = await getAllSubscribers(i.guild.id);
    const cats = await getAllCategorySubs(i.guild.id);
    const weather = await getAllWeatherSubs(i.guild.id);
    const sell = await getAllSellSubs(i.guild.id);
    const lines = [];
    const countMap = {};
    for (const [, list] of Object.entries(items)) for (const v of list) { countMap['\u{1F4E6} ' + v] = (countMap['\u{1F4E6} ' + v] || 0) + 1; }
    for (const [, list] of Object.entries(cats)) for (const v of list) { countMap['\u{1F4E1} cat-' + v] = (countMap['\u{1F4E1} cat-' + v] || 0) + 1; }
    for (const [, list] of Object.entries(weather)) for (const v of list) { countMap['\u{1F326} ' + v] = (countMap['\u{1F326} ' + v] || 0) + 1; }
    for (const [, list] of Object.entries(sell)) for (const v of list) { const p = parseSellSub(v); countMap['\u{1F4B0} ' + p.key] = (countMap['\u{1F4B0} ' + p.key] || 0) + 1; }
    const sorted = Object.entries(countMap).sort((a, b) => b[1] - a[1]);
    if (!sorted.length) return i.reply({ content: 'No one is subscribed to anything.', ephemeral: true });
    for (const [label, count] of sorted.slice(0, 50)) lines.push(label + ' \u2192 ' + count + ' sub' + (count > 1 ? 's' : ''));
    return i.reply({ embeds: [{ color: 0x8b5cf6, title: '\u{1F514} Alerts', description: lines.join('\n'), footer: { text: 'Showing top 50' }, timestamp: new Date().toISOString() }], ephemeral: true });
  }
};
const cmdCompare = {
  data: new SlashCommandBuilder().setName('compare').setDescription('Compare two items side-by-side')
    .addStringOption(o => o.setName('item1').setDescription('First item').setRequired(true).setAutocomplete(true))
    .addStringOption(o => o.setName('item2').setDescription('Second item').setRequired(true).setAutocomplete(true)),
  async autocomplete(i) {
    const f = i.options.getFocused().toLowerCase();
    const keys = await searchItems(f);
    const all = await getAllItems();
    const items = [];
    for (const k of keys) {
      const m = all.find(it => it.id === k);
      if (m) items.push({ name: (m.emoji || '') + ' ' + m.name + ' (' + m.category + ')', value: m.id });
    }
    await i.respond(items.slice(0, 25));
  },
  async execute(i) {
    const k1 = i.options.getString('item1');
    const k2 = i.options.getString('item2');
    const m1 = await findItem(k1);
    const m2 = await findItem(k2);
    if (!m1 || !m2) return i.reply({ content: !m1 ? 'Item "' + k1 + '" not found.' : 'Item "' + k2 + '" not found.', ephemeral: true });
    const stock1 = m1.stock > 0 ? '\u2705 x' + m1.stock : '\u274C Out of stock';
    const stock2 = m2.stock > 0 ? '\u2705 x' + m2.stock : '\u274C Out of stock';
    const ct1 = (m1.category || '').charAt(0).toUpperCase() + (m1.category || '').slice(1);
    const ct2 = (m2.category || '').charAt(0).toUpperCase() + (m2.category || '').slice(1);
    const f1 = (m1.emoji || '') + ' ' + m1.name;
    const f2 = (m2.emoji || '') + ' ' + m2.name;
    const v1 = '**Stock:** ' + stock1 + '\n**Rarity:** ' + (m1.rarity || 'N/A') + '\n**Category:** ' + ct1 + (m1.value ? '\n**Value:** ' + m1.value : '');
    const v2 = '**Stock:** ' + stock2 + '\n**Rarity:** ' + (m2.rarity || 'N/A') + '\n**Category:** ' + ct2 + (m2.value ? '\n**Value:** ' + m2.value : '');
    return i.reply({ embeds: [{ color: 0x6366f1, title: '\u2694\uFE0F Comparison', fields: [{ name: f1, value: v1, inline: true }, { name: f2, value: v2, inline: true }], timestamp: new Date().toISOString() }], ephemeral: true });
  }
};
const cmdWish = {
  data: new SlashCommandBuilder().setName('wish').setDescription('Add item to server wishlist').addStringOption(o => o.setName('item').setDescription('Item').setRequired(true).setAutocomplete(true)),
  async autocomplete(i) {
    const f = i.options.getFocused().toLowerCase();
    const keys = await searchItems(f);
    const all = await getAllItems();
    const items = [];
    for (const k of keys) { const m = all.find(it => it.id === k); if (m) items.push({ name: (m.emoji || '') + ' ' + m.name + ' (' + m.category + ')', value: m.id }); }
    await i.respond(items.slice(0, 25));
  },
  async execute(i) {
    const v = i.options.getString('item');
    const m = await findItem(v);
    if (!m) return i.reply({ content: 'Item "' + v + '" not found.', ephemeral: true });
    const added = await addWishlistItem(i.guild.id, m.key);
    return i.reply({ content: added ? '\u2705 **' + m.name + '** added to server wishlist' : 'Already on wishlist.', ephemeral: true });
  }
};
const cmdUnwish = {
  data: new SlashCommandBuilder().setName('unwish').setDescription('Remove item from server wishlist').addStringOption(o => o.setName('item').setDescription('Item').setRequired(true).setAutocomplete(true)),
  async autocomplete(i) {
    const f = i.options.getFocused().toLowerCase();
    const items = (await getWishlist(i.guild.id)).filter(x => x.includes(f));
    await i.respond(items.map(x => ({ name: x, value: x })).slice(0, 25));
  },
  async execute(i) {
    const v = i.options.getString('item');
    const removed = await removeWishlistItem(i.guild.id, v);
    return i.reply({ content: removed ? '\u2705 Removed from wishlist' : 'Not on wishlist.', ephemeral: true });
  }
};
const cmdWishlist = {
  data: new SlashCommandBuilder().setName('wishlist').setDescription('Server wishlist with live stock'),
  async execute(i) {
    await i.deferReply({ ephemeral: true });
    const items = await getWishlist(i.guild.id);
    if (!items.length) return i.editReply('Wishlist is empty. Use /wish to add items.');
    const results = [];
    for (const k of items) {
      const m = await findItem(k);
      if (m) results.push((m.stock > 0 ? '\u2705' : '\u274C') + ' ' + (m.emoji || '') + ' **' + m.name + '** x' + (m.stock > 0 ? m.stock : 0) + (m.rarity ? ' (' + m.rarity + ')' : ''));
      else results.push('\u2753 ' + k);
    }
    const chunks = [];
    for (let i = 0; i < results.length; i += 25) chunks.push(results.slice(i, i + 25).join('\n'));
    await i.editReply({ embeds: chunks.map((d, idx) => ({ color: 0x6366f1, title: idx === 0 ? '\u{1F4CB} Server Wishlist' : '\u{1F4CB} Wishlist (cont.)', description: d, timestamp: new Date().toISOString() })) });
  }
};
const cmdNotif = {
  data: new SlashCommandBuilder().setName('notif').setDescription('Set how you get notifications').addStringOption(o => o.setName('mode').setDescription('Notification mode').setRequired(true).addChoices({ name: 'Both (channel + DM)', value: 'both' }, { name: 'Channel only', value: 'channel' }, { name: 'DM only', value: 'dm' })),
  async execute(i) {
    const mode = i.options.getString('mode');
    await setNotifMode(i.guild.id, i.user.id, mode);
    const labels = { both: 'channel + DM', channel: 'channel only', dm: 'DM only' };
    return i.reply({ content: '\u2705 Notifications set to **' + (labels[mode] || mode) + '**', ephemeral: true });
  }
};
const gsCache = {};
const memoryGuildSettings = {}; // persistent in-memory fallback

async function getGuildSetting(g, s) {
  const key = 'gs_' + g + '_' + s;
  if (gsCache[key] && gsCache[key].exp > Date.now()) return gsCache[key].val;
  if (!dbAvailable) {
    const val = memoryGuildSettings[key] !== undefined ? memoryGuildSettings[key] : null;
    gsCache[key] = { val, exp: Date.now() + 300000 };
    return val;
  }
  const [r] = await q('SELECT value FROM guild_settings WHERE guild_id=? AND setting=?', [g, s]);
  const val = r.length ? r[0].value : null;
  gsCache[key] = { val, exp: Date.now() + 300000 };
  return val;
}
async function setGuildSetting(g, s, v) {
  const key = 'gs_' + g + '_' + s;
  memoryGuildSettings[key] = v;
  gsCache[key] = { val: v, exp: Date.now() + 300000 };
  if (!dbAvailable) return;
  await q('INSERT INTO guild_settings (guild_id, setting, value) VALUES (?,?,?) ON DUPLICATE KEY UPDATE value=?', [g, s, v, v]);
}
// ── Settings session system (global, no message collectors) ──
const settingsSessions = new Map();
const SS_CATS = { seed: 'Seeds', gear: 'Gear', crate: 'Crates', pet: 'Pets', cosmetic: 'Cosmetics' };

function buildMainPanel(s) {
  const nLabels = { both: 'Channel + DM', channel: 'Channel only', dm: 'DM only' };
  const desc = '\u{1F4CA} **Dashboard:** ' + (s.dashOn ? '\u2705 On' : '\u274C Off')
    + '\n\u23F1 **Ping cooldown:** ' + s.cdVal + ' min'
    + '\n\u{1F514} **Notifications:** ' + (nLabels[s.notifMode] || s.notifMode)
    + '\n\n**Category Subscriptions:**'
    + Object.entries(SS_CATS).filter(([c]) => s.allItems ? s.allItems.some(it => it.category === c) : true).map(([c, l]) => '\n' + (s.cats.has(c) ? '\u2705' : '\u274C') + ' ' + l).join('')
    + '\n\n_Use buttons below to toggle settings._';
  return {
    embeds: [{ color: 0x6366f1, title: '\u2699\uFE0F Settings', description: desc }],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('s_dash').setLabel(s.dashOn ? 'Disable Dashboard' : 'Enable Dashboard').setStyle(s.dashOn ? ButtonStyle.Danger : ButtonStyle.Success),
        new ButtonBuilder().setCustomId('s_cd_down').setLabel('\u25C0 Cooldown').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('s_cd_up').setLabel('Cooldown \u25B6').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('s_notif').setLabel('\u{1F514} Notif: ' + ({ both: 'DM+Ch', channel: 'Ch', dm: 'DM' })[s.notifMode] || s.notifMode).setStyle(ButtonStyle.Secondary)
      ),
      new ActionRowBuilder().addComponents(
        ...Object.entries(SS_CATS).filter(([c]) => s.allItems ? s.allItems.some(it => it.category === c) : true).map(([c, l]) =>
          new ButtonBuilder().setCustomId('s_cat_' + c).setLabel(l).setStyle(s.cats.has(c) ? ButtonStyle.Primary : ButtonStyle.Secondary).setEmoji(s.cats.has(c) ? '\u2705' : '\u274C')
        ),
        new ButtonBuilder().setCustomId('s_browse').setLabel('Browse Items').setStyle(ButtonStyle.Success).setEmoji('\u{1F4CB}')
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('s_done').setLabel('Close').setStyle(ButtonStyle.Danger)
      )
    ]
  };
}

function buildItemsPanel(s) {
  if (!s.allItems) {
    return {
      embeds: [{ color: 0x6366f1, title: '\u{1F4CB} Items', description: 'Loading items from API...' }],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('s_main').setLabel('\u25C0 Back').setStyle(ButtonStyle.Secondary)
      )]
    };
  }
  if (!s.allItems.length) {
    return {
      embeds: [{ color: 0x6366f1, title: '\u{1F4CB} Items', description: 'No items available from API.' }],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('s_main').setLabel('\u25C0 Back').setStyle(ButtonStyle.Secondary)
      )]
    };
  }
  const items = s.allItems.filter(it => it.category === s.browseCat);
  const totalPages = Math.max(1, Math.ceil(items.length / 25));
  if (s.browsePage >= totalPages) s.browsePage = totalPages - 1;
  if (s.browsePage < 0) s.browsePage = 0;
  const pageItems = items.slice(s.browsePage * 25, (s.browsePage + 1) * 25);

  const selectOptions = pageItems.map(it => ({
    label: it.name, value: it.id,
    description: it.rarity || '',
    emoji: it.emoji || undefined,
    default: s.items.has(it.id)
  }));

  const components = [];
  const catOpts = Object.entries(SS_CATS).filter(([c]) => s.allItems.some(it => it.category === c)).map(([c, l]) => ({ label: l, value: c, default: c === s.browseCat }));
  components.push(new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('s_cat_sel').setPlaceholder('Category').addOptions(catOpts)
  ));
  if (selectOptions.length) {
    components.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId('s_item_sel').setPlaceholder('Select items to subscribe...').setMinValues(0).setMaxValues(selectOptions.length).addOptions(selectOptions)
    ));
  }

  const navBtn = (id, label, style, disabled) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style).setDisabled(disabled);
  components.push(new ActionRowBuilder().addComponents(
    navBtn('s_main', '\u25C0 Back', ButtonStyle.Secondary, false),
    navBtn('s_page_prev', 'Prev', ButtonStyle.Primary, s.browsePage === 0),
    navBtn('s_page_info', 'P' + (s.browsePage + 1) + '/' + totalPages, ButtonStyle.Secondary, true),
    navBtn('s_page_next', 'Next', ButtonStyle.Primary, s.browsePage >= totalPages - 1)
  ));
  components.push(new ActionRowBuilder().addComponents(
    navBtn('s_sub_sel', 'Subscribe Selected', ButtonStyle.Success, !selectOptions.length),
    navBtn('s_unsub_sel', 'Unsubscribe Selected', ButtonStyle.Danger, !selectOptions.length),
    navBtn('s_sub_all', 'Sub All on Page', ButtonStyle.Success, !selectOptions.length),
    navBtn('s_unsub_all', 'Unsub All on Page', ButtonStyle.Danger, !selectOptions.length)
  ));
  return {
    embeds: [{ color: 0x6366f1, title: '\u{1F4CB} Items - ' + (SS_CATS[s.browseCat] || s.browseCat), description: (selectOptions.length ? 'Select items, then click Subscribe/Unsubscribe' : 'No items in this category.') + '\n_Green = subscribed_' }],
    components
  };
}

async function handleSettingsInteraction(i) {
  const s = settingsSessions.get(i.user.id);
  if (!s) return i.reply({ content: 'Session expired. Run /settings again.', ephemeral: true });
  await i.deferUpdate();
  try {
    if (i.customId === 's_dash') {
      s.dashOn = !s.dashOn; await setGuildSetting(s.gid, 'dashboard', s.dashOn ? 'on' : 'off').catch(() => {});
      await i.editReply(buildMainPanel(s));
    } else if (i.customId === 's_cd_down') {
      let v = parseInt(s.cdVal) || 2; if (v > 1) v--; s.cdVal = '' + v; await setGuildSetting(s.gid, 'ping_cooldown', s.cdVal).catch(() => {});
      await i.editReply(buildMainPanel(s));
    } else if (i.customId === 's_cd_up') {
      let v = parseInt(s.cdVal) || 2; if (v < 10) v++; s.cdVal = '' + v; await setGuildSetting(s.gid, 'ping_cooldown', s.cdVal).catch(() => {});
      await i.editReply(buildMainPanel(s));
    } else if (i.customId === 's_notif') {
      const modes = ['both', 'channel', 'dm'];
      s.notifMode = modes[(modes.indexOf(s.notifMode) + 1) % 3]; await setNotifMode(s.gid, s.uid, s.notifMode).catch(() => {});
      await i.editReply(buildMainPanel(s));
    } else if (i.customId.startsWith('s_cat_') && i.customId !== 's_cat_sel') {
      const cat = i.customId.replace('s_cat_', '');
      if (cat && SS_CATS[cat]) {
        if (s.cats.has(cat)) { s.cats.delete(cat); await removeCategorySub(s.gid, s.uid, cat).catch(() => {}); }
        else { s.cats.add(cat); await addCategorySub(s.gid, s.uid, cat).catch(() => {}); }
        await i.editReply(buildMainPanel(s));
      }
    } else if (i.customId === 's_browse') {
      if (!s.allItems || !s.allItems.length) s.allItems = await getAllItems().catch(() => []);
      s.page = 'items'; s.browseCat = 'seed'; s.browsePage = 0;
      await i.editReply(buildItemsPanel(s));
    } else if (i.customId === 's_main') {
      s.page = 'main'; await i.editReply(buildMainPanel(s));
    } else if (i.customId === 's_done') {
      settingsSessions.delete(i.user.id); await i.editReply({ components: [] });
    } else if (i.customId === 's_cat_sel') {
      s.browseCat = i.values[0]; s.browsePage = 0; await i.editReply(buildItemsPanel(s));
    } else if (i.customId === 's_item_sel') {
      s.pending = i.values;
    } else if (i.customId === 's_page_prev') {
      if (s.browsePage > 0) s.browsePage--; await i.editReply(buildItemsPanel(s));
    } else if (i.customId === 's_page_next') {
      const totalPages = Math.max(1, Math.ceil(s.allItems.filter(it => it.category === s.browseCat).length / 25));
      if (s.browsePage < totalPages - 1) s.browsePage++; await i.editReply(buildItemsPanel(s));
    } else if (i.customId === 's_sub_sel') {
      for (const itemId of s.pending) { if (!s.items.has(itemId)) { s.items.add(itemId); await addUserItem(s.gid, s.uid, itemId).catch(() => {}); } }
      s.pending = []; await i.editReply(buildItemsPanel(s));
    } else if (i.customId === 's_unsub_sel') {
      for (const itemId of s.pending) { if (s.items.has(itemId)) { s.items.delete(itemId); await removeUserItem(s.gid, s.uid, itemId).catch(() => {}); } }
      s.pending = []; await i.editReply(buildItemsPanel(s));
    } else if (i.customId === 's_sub_all') {
      const pageItems = s.allItems.filter(it => it.category === s.browseCat).slice(s.browsePage * 25, (s.browsePage + 1) * 25);
      for (const it of pageItems) { if (!s.items.has(it.id)) { s.items.add(it.id); await addUserItem(s.gid, s.uid, it.id).catch(() => {}); } }
      await i.editReply(buildItemsPanel(s));
    } else if (i.customId === 's_unsub_all') {
      const pageItems = s.allItems.filter(it => it.category === s.browseCat).slice(s.browsePage * 25, (s.browsePage + 1) * 25);
      for (const it of pageItems) { if (s.items.has(it.id)) { s.items.delete(it.id); await removeUserItem(s.gid, s.uid, it.id).catch(() => {}); } }
      await i.editReply(buildItemsPanel(s));
    }
  } catch (e) { console.error('[Settings] Interaction error:', e.message); }
}

const cmdSettings = {
  data: new SlashCommandBuilder().setName('settings').setDescription('View and change settings'),
  async execute(i) {
    // Defer immediately to prevent interaction timeout
    await i.deferReply({ ephemeral: true });
    const gid = i.guild.id, uid = i.user.id;

    // Load all data — these can take time, but deferReply already acknowledged
    const [dbDash, dbCd, dbNotif, dbCats, dbItems] = await Promise.all([
      getGuildSetting(gid, 'dashboard').catch(() => null),
      getGuildSetting(gid, 'ping_cooldown').catch(() => null),
      getNotifMode(gid, uid).catch(() => 'both'),
      getCategorySubs(gid, uid).catch(() => []),
      getUserItems(gid, uid).catch(() => [])
    ]);

    const session = {
      uid, gid,
      dashOn: dbDash !== 'off',
      cdVal: dbCd || '2',
      notifMode: dbNotif || 'both',
      cats: new Set(dbCats),
      items: new Set(dbItems),
      allItems: null,
      page: 'main',
      browseCat: 'seed',
      browsePage: 0,
      pending: []
    };
    settingsSessions.set(uid, session);

    await i.editReply(buildMainPanel(session));

    // Auto-expire after 2 minutes
    setTimeout(() => {
      if (settingsSessions.get(uid) === session) {
        settingsSessions.delete(uid);
        i.editReply({ components: [] }).catch(() => {});
      }
    }, 120000);
  }
};
const cmdDeploy = {
  data: new SlashCommandBuilder().setName('deploy').setDescription('Force-reload all commands (instant)').setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  async execute(i) {
    await i.deferReply({ ephemeral: true });
    const ok = await doDeploy(i.client);
    await i.editReply(ok ? '\u2705 Commands deployed to **' + i.client.guilds.cache.size + '** guild(s). They should appear immediately.' : '\u274C Failed to deploy commands. Check bot console.');
  }
};
const cmdUnsubSell = {
  data: new SlashCommandBuilder().setName('unsubsell').setDescription('Unsubscribe from sell crop').addStringOption(o => o.setName('crop').setDescription('Crop').setRequired(true).setAutocomplete(true)),
  async autocomplete(i) {
    const f = i.options.getFocused().toLowerCase();
    const items = (await getSellSubs(i.guild.id, i.user.id)).filter(x => x.includes(f));
    await i.respond(items.map(x => ({ name: x, value: x })).slice(0, 25));
  },
  async execute(i) {
    const k = i.options.getString('crop');
    const removed = await removeSellSub(i.guild.id, i.user.id, k);
    if (removed) {
      const rn = 'gag2-' + k;
      const role = i.guild.roles.cache.find(r => r.name === rn);
      if (role && i.member) await i.member.roles.remove(role.id).catch(() => {});
    }
    return i.reply({ content: removed ? '\u2705 Unsubscribed' : 'Not subscribed.', ephemeral: true });
  }
};

// ── Bot setup ──
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
client.commands = new Collection();
for (const c of [cmdSetup, cmdStock, cmdSub, cmdUnsub, cmdList, cmdWeather, cmdSubWeather, cmdUnsubWeather, cmdSell, cmdSubSell, cmdUnsubSell, cmdGraph, cmdStats, cmdCleanup, cmdSubCategory, cmdUnsubCategory, cmdSnooze, cmdUnsnooze, cmdInfo, cmdAlerts, cmdCompare, cmdWish, cmdUnwish, cmdWishlist, cmdNotif, cmdSettings, cmdDeploy]) client.commands.set(c.data.name, c);

async function doDeploy(client) {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  const appId = client.user.id;
  const cmds = client.commands.map(c => c.data);
  // Clear global commands first
  try { await rest.put(Routes.applicationCommands(appId), { body: [] }); } catch {}
  let ok = 0;
  for (const [, g] of client.guilds.cache) {
    try {
      await rest.put(Routes.applicationGuildCommands(appId, g.id), { body: cmds });
      ok++;
    } catch (e) { console.error('[Deploy] Fail on ' + g.name + ':', e.message); }
  }
  console.log('[Deploy] ' + cmds.length + ' commands to ' + ok + '/' + client.guilds.cache.size + ' guilds.');
  return ok > 0;
}

client.once('ready', async () => {
  console.log('Logged in as ' + client.user.tag);
  // Deploy commands (retry once if fails)
  const deployed = await doDeploy(client);
  if (!deployed) { setTimeout(async () => { console.log('[Deploy] Retrying...'); await doDeploy(client); }, 10000); }
  // Fetch immediately, then every 15s
  await refreshData();
  // Pre-cache all items so getAllItems() is instant for first user
  getAllItems().catch(() => {});
  // Periodically refresh item cache in background
  setInterval(() => getAllItems().catch(() => {}), 300000);
  // Stock snapshot every 10 minutes for graph history
  setInterval(() => {
    const data = latestData;
    if (!data?.stock) return;
    const now = Date.now();
    for (const cat of data.stock) {
      for (const it of cat.items) {
        // Always save to in-memory history (zero DB dependency)
        if (!stockHistory[it.key]) stockHistory[it.key] = [];
        const arr = stockHistory[it.key];
        arr.push({ ts: now, qty: it.quantity, name: it.name });
        if (arr.length > MAX_HISTORY) arr.shift();
        // Best-effort save to MySQL too
        q('INSERT INTO restock_history (item_key, item_name, quantity, rarity, category, ts) VALUES (?,?,?,?,?,?)',
          [it.key, it.name, it.quantity, it.rarity, cat.category, now]).catch(() => {});
      }
    }
  }, 600000);
  // Watch for stock changes every 3s
  onData((data) => refreshTracker(client));
  setInterval(() => refreshTracker(client), 3000);
  // Dashboard auto-update every 15s
  setInterval(() => {
    if (latestData && Date.now() - lastDashboardUpdate > 14000) { lastDashboardUpdate = Date.now(); updateDashboard(client).catch(() => {}); }
  }, 3000);
  // Also update immediately on first data
  const dashOnData = (data) => { if (data?.stock) { updateDashboard(client).catch(() => {}); } };
  onData(dashOnData);
  // Heartbeat every 5 min
  setInterval(() => { console.log('[Heartbeat] Alive, ' + client.guilds.cache.size + ' guilds, ' + Object.keys(activePings).length + ' active pings'); }, 300000);
  // Note: no auto-cleanup — bot never deletes anything unless explicitly told to
  // Data retention: purge history older than 30 days every hour
  setInterval(async () => {
    const cutoff = Date.now() - 2592000000;
    try {
      const [r1] = await q('DELETE FROM restock_history WHERE ts < ?', [cutoff]);
      const [r2] = await q('DELETE FROM sell_history WHERE ts < ?', [cutoff]);
      const [r3] = await q('DELETE FROM weather_history WHERE ts < ?', [cutoff]);
      if (r1.affectedRows || r2.affectedRows || r3.affectedRows) console.log('[Retention] Purged ' + r1.affectedRows + ' restock, ' + r2.affectedRows + ' sell, ' + r3.affectedRows + ' weather rows.');
    } catch (e) { console.error('[Retention] Error:', e.message); }
  }, 3600000);
});

client.on('interactionCreate', async i => {
  try {
    if (i.isAutocomplete()) { const c = client.commands.get(i.commandName); if (c?.autocomplete) await c.autocomplete(i); return; }
    if (i.isButton() || i.isStringSelectMenu()) {
      if (i.customId.startsWith('s_')) { await handleSettingsInteraction(i); return; }
      return;
    }
    if (!i.isChatInputCommand()) return;
    const c = client.commands.get(i.commandName);
    if (!c) return;
    const to = setTimeout(() => { if (!i.replied) i.deferReply({ ephemeral: true }).then(() => i.editReply('Command timed out (15s).').catch(() => {})).catch(() => {}); else if (i.deferred) i.editReply('Command timed out (15s).').catch(() => {}); else i.followUp('Command timed out.').catch(() => {}); }, 15000);
    try { await c.execute(i); clearTimeout(to); } catch (e) { clearTimeout(to); throw e; }
  } catch (e) {
    console.error('[Cmd] Error:', e.message);
    if (i.deferred) await i.editReply({ content: 'Error: ' + e.message });
    else if (i.replied) await i.followUp({ content: 'Error: ' + e.message, ephemeral: true });
    else await i.reply({ content: 'Error: ' + e.message, ephemeral: true });
  }
});

client.on('guildCreate', async guild => {
  try {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    await rest.put(Routes.applicationGuildCommands(guild.client.user.id, guild.id), { body: client.commands.map(c => c.data) });
    console.log('[Guild] Deployed commands to ' + guild.name);
  } catch (e) { console.error('[Guild] Deploy fail:', e.message); }
});

process.on('unhandledRejection', (reason, p) => { console.error('[CRASH] Unhandled Rejection:', reason); });
process.on('uncaughtException', err => { console.error('[CRASH] Uncaught Exception:', err.message); });
client.on('error', err => { console.error('[Client] Error:', err.message); });

// ── Web server for live charts ──
(async () => {
  try { await initDB(); } catch (e) { console.error('[DB] Connection failed:', e.message); }
  client.login(process.env.DISCORD_TOKEN);
})();
