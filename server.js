console.log('🚀 [1/3] Starting portal backend server...');
require('dotenv').config();

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const https = require('https');

const app = express();
const DB_PATH = path.join(__dirname, 'vouchers.json');

// ---------- Config (secrets come ONLY from .env) ----------
const OMADA_URL = process.env.OMADA_URL || 'https://127.0.0.1:8043';
const OMADA_SITE = process.env.OMADA_SITE || '';
const OMADA_CONTROLLER_ID = process.env.OMADA_CONTROLLER_ID;
const OMADA_OPERATOR_NAME = process.env.OMADA_OPERATOR_NAME;
const OMADA_OPERATOR_PASSWORD = process.env.OMADA_OPERATOR_PASSWORD;
const OMADA_SSID = (process.env.OMADA_SSID || '').trim();
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;

const missing = ['OMADA_CONTROLLER_ID', 'OMADA_OPERATOR_NAME', 'OMADA_OPERATOR_PASSWORD', 'PAYSTACK_SECRET_KEY']
    .filter(k => !process.env[k]);
if (missing.length) {
    console.error('❌ Missing required .env variables:', missing.join(', '));
    process.exit(1);
}

// Prices are in pesewas and MUST match the prices shown in index.html
const PLANS = {
    '22 Hours Access': { price: 210, durationMs: 22 * 60 * 60 * 1000 },
    '7-Days Access': { price: 1250, durationMs: 7 * 24 * 60 * 60 * 1000 },
    '30 Days Access': { price: 4800, durationMs: 30 * 24 * 60 * 60 * 1000 }
};

// ---------- Flood protection (per device IP, in memory) ----------
// Stops anyone hammering the portal and, through it, the Omada controller and your network.
//   every request            : 240 per minute          (a normal phone uses about 10 to open the page)
//   POST /activate           : 15 per minute
//   POST /verify             : 20 per minute
//   POST /intent             : 10 per minute
//   POST /retrieve           : 10 per minute
//   GET  /status             : 30 per minute
// A device that goes far past a limit (3x) is cut off for 10 minutes, rejected before any work is done.
const FLOOD_WINDOW_MS = 60 * 1000;
const FLOOD_LIMITS = { all: 240, 'POST /activate': 15, 'POST /verify': 20, 'POST /intent': 10, 'POST /retrieve': 10, 'GET /status': 30 };
const FLOOD_CUTOFF_MS = 10 * 60 * 1000;
const floodHits = new Map();     // "ip|bucket" -> { start, n }
const floodCut = new Map();      // ip -> until (ms)
const floodLogged = new Map();   // ip -> last log time
const MAX_IN_FLIGHT_ACTIVATE = 25;   // activations being processed at once (protects the Omada controller)
let activateInFlight = 0;
function floodLog(ip, why, force) {
    if (!force && Date.now() - (floodLogged.get(ip) || 0) < 5 * 60 * 1000) return;
    floodLogged.set(ip, Date.now());
    try { logEvent('RATE-LIMITED', `ip=${ip} ${why}`); } catch (e) { /* ignore */ }
}
function floodGuard(req, res, next) {
    const ip = req.ip || '';
    if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return next();   // this laptop is never limited
    const now = Date.now();
    const cut = floodCut.get(ip) || 0;
    if (cut > now) {
        res.set('Retry-After', String(Math.ceil((cut - now) / 1000)));
        return res.status(429).end();
    }
    const route = `${req.method} ${req.path}`;
    for (const bucket of ['all', route]) {
        const max = FLOOD_LIMITS[bucket];
        if (!max) continue;
        const key = `${ip}|${bucket}`;
        let h = floodHits.get(key);
        if (!h || now - h.start >= FLOOD_WINDOW_MS) { h = { start: now, n: 0 }; floodHits.set(key, h); }
        h.n++;
        if (h.n > max) {
            if (h.n > max * 3) {
                floodCut.set(ip, now + FLOOD_CUTOFF_MS);
                floodLog(ip, `cut off for ${FLOOD_CUTOFF_MS / 60000}min (flooding ${bucket})`, true);
            } else floodLog(ip, `too many requests (${bucket})`);
            res.set('Retry-After', '60');
            if (route === 'POST /activate' || route === 'POST /verify' || route === 'POST /intent' || route === 'POST /retrieve') {
                return res.status(429).json({ success: false, error: 'Too many requests. Please wait a minute and try again.' });
            }
            return res.status(429).send('Too many requests. Please wait a minute and try again.');
        }
    }
    next();
}
setInterval(() => {   // forget old counters so memory stays small
    const now = Date.now();
    for (const [k, h] of floodHits) if (now - h.start >= FLOOD_WINDOW_MS) floodHits.delete(k);
    for (const [ip, t] of floodCut) if (t <= now) floodCut.delete(ip);
    for (const [ip, t] of floodLogged) if (now - t > 30 * 60 * 1000) floodLogged.delete(ip);
}, 60 * 1000).unref();
app.use(floodGuard);
app.use(express.json({ limit: '20kb' }));   // tiny bodies only: nobody needs to send us big data
// Serve ONLY the public folder (put index.html inside ./public)
app.get(['/', '/index.html'], servePortalPage);
app.use(express.static(path.join(__dirname, 'public')));

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

// ---------- Omada session cache ----------
let omadaToken = null;
let omadaCookie = null;
let tokenExpiry = null;

function clearOmadaSession() {
    omadaToken = null;
    omadaCookie = null;
    tokenExpiry = null;
}

/** Formats MAC addresses into hyphenated uppercase (00-11-22-33-44-55) */
function formatHyphenMac(mac) {
    if (!mac) return '';
    const clean = mac.replace(/[^a-fA-F0-9]/g, '');
    if (clean.length !== 12) return mac.toUpperCase();
    return clean.match(/.{1,2}/g).join('-').toUpperCase();
}

/** Authenticate with the Omada Hotspot API using the Controller ID route */
let omadaLoginPromise = null;

async function getOmadaToken(forceRefresh = false) {
    if (!forceRefresh && omadaToken && omadaCookie && tokenExpiry && Date.now() < tokenExpiry) {
        return { token: omadaToken, cookie: omadaCookie };
    }

    // If a login is already running, wait for it instead of starting a second one
    if (omadaLoginPromise) return omadaLoginPromise;

    omadaLoginPromise = (async () => {
        clearOmadaSession();

        const operatorLoginUrl = `${OMADA_URL}/${OMADA_CONTROLLER_ID}/api/v2/hotspot/login`;
        console.log('🔑 Logging into Omada Hotspot API at:', operatorLoginUrl);

        const response = await axios.post(
            operatorLoginUrl,
            { name: OMADA_OPERATOR_NAME, password: OMADA_OPERATOR_PASSWORD },
            { httpsAgent, timeout: 10000, headers: { 'Content-Type': 'application/json' } }
        );

        const token = response.data?.result?.token || response.headers['csrf-token'];
        const rawCookies = response.headers['set-cookie'];
        const cookie = rawCookies ? rawCookies.map(c => c.split(';')[0]).join('; ') : '';

        if (response.data && response.data.errorCode === 0 && token) {
            omadaToken = token;
            omadaCookie = cookie;
            tokenExpiry = Date.now() + (50 * 60 * 1000);
            console.log('✅ Hotspot Operator authenticated successfully!');
            return { token: omadaToken, cookie: omadaCookie };
        }

        throw new Error(`Hotspot Operator login failed: ${response.data?.msg || 'Invalid Credentials'}`);
    })().finally(() => { omadaLoginPromise = null; });

    return omadaLoginPromise;
}

/** Log in ahead of time so the first customer after a start or idle period doesn't wait for the login */
async function warmOmadaSession() {
    try {
        await getOmadaToken(true);
    } catch (err) {
        console.log('⚠️ Omada warm-up login failed (it will retry on the next activation):', err.message);
    }
}

// ---------- Database ----------
function emptyDB() {
    return { "22 Hours Access": [], "7-Days Access": [], "30 Days Access": [], "sales_history": [], "redeemed": {} };
}

function getDB() {
    if (!fs.existsSync(DB_PATH)) return emptyDB();
    try {
        return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    } catch (err) {
        return emptyDB();
    }
}

function saveDB(data) {
    const tempPath = `${DB_PATH}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tempPath, DB_PATH);
}

let isDbLocked = false;
async function withDbLock(action) {
    while (isDbLocked) await new Promise(res => setTimeout(res, 30));
    isDbLocked = true;
    try {
        const db = getDB();
        const result = await action(db);
        saveDB(db);
        return result;
    } finally {
        isDbLocked = false;
    }
}

function normalizePhone(phone) {
    if (!phone) return '';
    const digits = String(phone).replace(/\D/g, '');
    return digits.length >= 9 ? digits.slice(-9) : digits;
}

// ---------- PIN hashing ----------
function hashPin(pin, salt) {
    return crypto.scryptSync(String(pin), salt, 32).toString('hex');
}

function pinMatches(record, pin) {
    if (record.pinHash && record.pinSalt) {
        const a = Buffer.from(hashPin(pin, record.pinSalt), 'hex');
        const b = Buffer.from(record.pinHash, 'hex');
        return a.length === b.length && crypto.timingSafeEqual(a, b);
    }
    // Legacy records saved before hashing was added
    return String(record.pin || '').trim() === String(pin).trim();
}

// ---------- Simple in-memory rate limiter ----------
const attemptLog = new Map();
function tooManyAttempts(key, max = 10, windowMs = 15 * 60 * 1000) {
    const now = Date.now();
    const recent = (attemptLog.get(key) || []).filter(t => now - t < windowMs);
    recent.push(now);
    attemptLog.set(key, recent);
    return recent.length > max;
}

// Failed-attempt limiter (used by /activate): only FAILED tries are counted
const failLog = new Map();
function isBlocked(key, max, windowMs = 15 * 60 * 1000) {
    const now = Date.now();
    const recent = (failLog.get(key) || []).filter(t => now - t < windowMs);
    failLog.set(key, recent);
    return recent.length >= max;
}
function recordFail(key) {
    const list = failLog.get(key) || [];
    list.push(Date.now());
    failLog.set(key, list);
}

// ---------- Guess protection: lockouts and permanent bans ----------
// 3 wrong codes in 15 minutes -> locked for 30 minutes (per device AND per IP address).
// 3 DIFFERENT wrong codes within 5 minutes -> online-bought codes only for 6 hours (not a permanent ban).
// 5 expired codes within 1 hour -> online-bought codes only for 6 hours.
// 3 lockouts within 7 days -> the device is banned for good (saved in banned.json).
const BAN_PATH = path.join(__dirname, 'banned.json');
const LOCK_AFTER_FAILS = 6;   // must stay above WRONG_BEFORE_STRIP so the stripped page always comes first
const LOCK_WINDOW_MS = 15 * 60 * 1000;
const LOCK_MS = 30 * 60 * 1000;
const BAN_AFTER_LOCKS = 3;
const STRIKE_MEMORY_MS = 7 * 24 * 60 * 60 * 1000;
const BAN_DISTINCT_CODES = 3;
const WRONG_BEFORE_STRIP = 5;
const BAN_DISTINCT_WINDOW_MS = 5 * 60 * 1000;
const DISTINCT_RESTRICT_MS = 6 * 60 * 60 * 1000;
const EXPIRED_LIMIT = 5;
const EXPIRED_WINDOW_MS = 60 * 60 * 1000;
const EXPIRED_RESTRICT_MS = 6 * 60 * 60 * 1000;
const recentCodes = new Map();      // mac -> [{ t, code }] of wrong codes
const expiredTries = new Map();     // mac -> [timestamps] of expired-code tries
// "Stripped page" state is kept in restrictions.json so it survives restarts:
//   onlineOnly: { mac: untilMs }   device can only use vouchers bought online until then (and gets the stripped page)
//   day:        { mac: { day, level, wrong } }   today's escalation ladder for that device
const RESTR_PATH = path.join(__dirname, 'restrictions.json');
const todayStr = () => new Date().toISOString().slice(0, 10);   // Ghana time = UTC
function loadRestr() {
    try {
        const r = JSON.parse(fs.readFileSync(RESTR_PATH, 'utf8'));
        return { onlineOnly: r.onlineOnly || {}, day: r.day || {} };
    } catch (e) { return { onlineOnly: {}, day: {} }; }
}
function saveRestr(r) {
    const now = Date.now(), today = todayStr();
    Object.keys(r.onlineOnly).forEach(m => { if (r.onlineOnly[m] <= now) delete r.onlineOnly[m]; });
    Object.keys(r.day).forEach(m => { if (r.day[m].day !== today && !r.onlineOnly[m]) delete r.day[m]; });
    fs.writeFileSync(RESTR_PATH, JSON.stringify(r, null, 2), 'utf8');
}
const onlineUntil = (mac) => (mac && loadRestr().onlineOnly[mac]) || 0;
function setOnlineOnly(mac, until) { const r = loadRestr(); r.onlineOnly[mac] = until; saveRestr(r); }
const lockedUntil = new Map();

function prettyMac(mac) { return (String(mac || '').match(/.{2}/g) || []).join('-'); }
function normMac(mac) { return String(mac || '').toUpperCase().replace(/[^0-9A-F]/g, ''); }

function loadBans() {
    try {
        const b = JSON.parse(fs.readFileSync(BAN_PATH, 'utf8'));
        return { banned: b.banned || {}, strikes: b.strikes || {} };
    } catch (e) {
        return { banned: {}, strikes: {} };
    }
}
function saveBans(bans) { fs.writeFileSync(BAN_PATH, JSON.stringify(bans, null, 2), 'utf8'); }
function isBanned(mac) { return !!(mac && loadBans().banned[mac]); }

/** Counts one wrong code. Returns null, or { banned } when this failure triggered a lockout. */
// Last tries per device, used in the alert emails
const attemptTrail = new Map();
function addTrail(mac, code, why) {
    const t = (attemptTrail.get(mac) || []).filter(x => Date.now() - x.t < 60 * 60 * 1000);
    t.push({ t: Date.now(), code, why });
    attemptTrail.set(mac, t.slice(-8));
}
/** Emails you when a device hits a limit (not more than once an hour per device and kind). */
function alertAbuse(kind, headline, mac, ip, device, extra) {
    const pretty = (mac.match(/.{2}/g) || []).join('-');
    const trail = (attemptTrail.get(mac) || [])
        .map(x => `  ${new Date(x.t).toISOString().slice(11, 19)}  code ${x.code}  (${x.why})`).join('\n');
    sendAlert(`abuse:${mac}:${kind}`, `${headline} - ${device || 'unknown device'}`,
        `${headline}\n\nDevice (MAC): ${pretty}\nIP address: ${ip}\nPhone/browser: ${device || 'unknown'}\n${extra}\n\nRecent tries (Ghana time):\n${trail || '  (none recorded)'}\n\nMore detail: search activity.log for ${pretty}. Run "node ban.js" to see strikes and bans.`,
        60 * 60 * 1000);
}

function registerFailure(mac, ip, code, device) {
    // Already banned: they can only use online-bought codes anyway, so no lockout is needed
    if (isBanned(mac) || onlineUntil(mac) > Date.now()) return null;

    // Daily ladder (resets at 00:00 Ghana time):
    //   level 0: a wrong/guessed code                      -> stripped page for 6 hours
    //   level 1: after the page comes back, 3 wrong attempts -> stripped page for 6 hours
    //   level 2: after that, any further wrong attempt       -> stripped page for 24 hours
    // WRONG_BEFORE_STRIP = how many wrong codes the first strip needs (1 = the very first wrong code)
    const now0 = Date.now();
    addTrail(mac, code, 'wrong code');
    const list = (recentCodes.get(mac) || []).filter(x => now0 - x.t < BAN_DISTINCT_WINDOW_MS);
    list.push({ t: now0, code });
    recentCodes.set(mac, list);
    const distinct = new Set(list.map(x => x.code)).size;

    const r = loadRestr();
    let st = r.day[mac];
    if (!st || st.day !== todayStr()) st = { day: todayStr(), level: 0, wrong: 0 };
    st.wrong++;
    let hours = 0, level = st.level;
    if (st.level === 0 && st.wrong >= WRONG_BEFORE_STRIP) { hours = 6; level = 1; }
    else if (st.level === 1 && st.wrong >= 3) { hours = 6; level = 2; }
    else if (st.level >= 2) { hours = 24; level = 3; }

    if (hours) {
        st.level = level; st.wrong = 0;
        r.day[mac] = st;
        r.onlineOnly[mac] = now0 + hours * 3600000;
        saveRestr(r);
        recentCodes.delete(mac);
        failLog.delete(`fail-mac:${mac}`);
        failLog.delete(`fail-ip:${ip}`);
        logEvent('ONLINE-ONLY', `mac=${prettyMac(mac)} ip=${ip} reason=wrong-codes level=${level} stripped page for ${hours}h`);
        const heads = { 1: 'Device entered a wrong code: 6 hour strip', 2: 'Device came back and made 3 more wrong attempts', 3: 'Device kept guessing: 24 hour strip' };
        alertAbuse(`restricted${level}`, heads[level], mac, ip, device,
            `Action taken: stripped splash page (no voucher box) and online-bought codes only for ${hours} hours.`);
        return { restricted: true, hours, level };
    }
    r.day[mac] = st;
    saveRestr(r);
    const warnNow = (st.level === 0 && st.wrong === WRONG_BEFORE_STRIP - 1) || (st.level === 1 && st.wrong === 2);

    const macKey = `fail-mac:${mac}`, ipKey = `fail-ip:${ip}`;
    recordFail(macKey);
    recordFail(ipKey);
    const hit = isBlocked(macKey, LOCK_AFTER_FAILS, LOCK_WINDOW_MS) || isBlocked(ipKey, LOCK_AFTER_FAILS, LOCK_WINDOW_MS);
    if (!hit) return warnNow ? { warn: true } : null;

    const until = Date.now() + LOCK_MS;
    lockedUntil.set(macKey, until);
    lockedUntil.set(ipKey, until);
    failLog.delete(macKey);
    failLog.delete(ipKey);

    const bans = loadBans();
    const old = bans.strikes[mac];
    const strike = (old && Date.now() - old.last < STRIKE_MEMORY_MS) ? old : { count: 0 };
    strike.count += 1;
    strike.last = Date.now();
    strike.lastIp = ip;
    strike.lastDevice = device;
    bans.strikes[mac] = strike;

    let banned = false;
    if (strike.count >= BAN_AFTER_LOCKS && !bans.banned[mac]) {
        bans.banned[mac] = { since: new Date().toISOString(), lastIp: ip, device, reason: `${strike.count} lockouts for wrong codes` };
        banned = true;
    }
    saveBans(bans);
    logEvent(banned ? 'BANNED' : 'LOCKED-OUT', `mac=${prettyMac(mac)} ip=${ip} lockout=${strike.count}/${BAN_AFTER_LOCKS}`);
    alertAbuse(banned ? 'banned' : 'locked',
        banned ? 'Device BANNED (3 lockouts)' : `Device locked out for too many wrong codes (${strike.count}/${BAN_AFTER_LOCKS})`,
        mac, ip, device,
        banned ? 'Action taken: banned for good. It can only use vouchers bought online.' : `Action taken: locked out for ${LOCK_MS / 60000} minutes. A device is banned at ${BAN_AFTER_LOCKS} lockouts.`);
    return { banned };
}

/** Counts one expired-code try. Returns true when this try started the 6-hour online-only period. */
function registerExpired(mac, ip, code, device) {
    const now = Date.now();
    addTrail(mac, code, 'expired code');
    const list = (expiredTries.get(mac) || []).filter(t => now - t < EXPIRED_WINDOW_MS);
    list.push(now);
    expiredTries.set(mac, list);
    if (list.length < EXPIRED_LIMIT) return false;
    expiredTries.delete(mac);
    setOnlineOnly(mac, now + EXPIRED_RESTRICT_MS);
    logEvent('EXPIRED-LIMIT', `mac=${prettyMac(mac)} ip=${ip} online-only for ${EXPIRED_RESTRICT_MS / 3600000}h`);
    alertAbuse('expired', `Device tried ${EXPIRED_LIMIT} expired codes`, mac, ip, device,
        `Action taken: this device can only use vouchers bought online for ${EXPIRED_RESTRICT_MS / 3600000} hours.`);
    return true;
}

// ---------- Banned / online-only devices that keep trying ----------
// More than 10 tries in an hour -> the device is paused for 2 hours (you get an email).
const ONLINE_ONLY_ERROR = 'This device can only use vouchers bought online.';
const BANNED_TRY_LIMIT = 10;
const BANNED_TRY_WINDOW_MS = 60 * 60 * 1000;
const BANNED_PAUSE_MS = 2 * 60 * 60 * 1000;
const bannedTries = new Map();

/** Counts one try from a banned/online-only device. Returns true when it starts a pause. */
function registerBannedTry(mac, ip, code, device) {
    addTrail(mac, code, 'banned device');
    const now = Date.now();
    const list = (bannedTries.get(mac) || []).filter(t => now - t < BANNED_TRY_WINDOW_MS);
    list.push(now);
    bannedTries.set(mac, list);
    if (list.length < BANNED_TRY_LIMIT) return false;
    bannedTries.delete(mac);
    lockedUntil.set(`banned-mac:${mac}`, now + BANNED_PAUSE_MS);
    logEvent('BANNED-PAUSED', `mac=${prettyMac(mac)} ip=${ip} paused for ${BANNED_PAUSE_MS / 3600000}h after ${BANNED_TRY_LIMIT} tries`);
    alertAbuse('bannedspam', `Banned device keeps trying (${BANNED_TRY_LIMIT} tries in an hour)`, mac, ip, device,
        `Action taken: this device is paused for ${BANNED_PAUSE_MS / 3600000} hours. Nothing it tried worked, because banned devices can only use vouchers bought online.`);
    return true;
}

// Banned or online-only devices get a splash page WITHOUT the voucher box (they can only buy online)
const restrictedViewLogged = new Map();
function servePortalPage(req, res, next) {
    const mac = normMac(req.query.clientMac);
    const permanent = isBanned(mac), until = onlineUntil(mac);
    if (!mac || !(permanent || until > Date.now())) return next();
    try {
        let html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
        const inject = `<style>#voucherInput,#activateBtn{display:none!important}</style>
<script>window.addEventListener('DOMContentLoaded',function(){var i=document.getElementById('voucherInput');var d=i&&i.previousElementSibling;if(d)d.style.display='none';var w=document.querySelector('.welcome');if(w)w.innerText=${JSON.stringify(permanent ? 'This device can only get access by buying online.' : 'Voucher entry is paused for about ' + Math.max(1, Math.ceil((until - Date.now()) / 3600000)) + ' hour(s). You can buy access online anytime.')};});</script>`;
        html = html.includes('</body>') ? html.replace('</body>', inject + '</body>') : html + inject;
        if (Date.now() - (restrictedViewLogged.get(mac) || 0) > 10 * 60 * 1000) {
            restrictedViewLogged.set(mac, Date.now());
            logEvent('RESTRICTED-VIEW', `mac=${prettyMac(mac)} ip=${req.ip} page=buy-only device=${shortDevice(req.headers['user-agent'])}`);
        }
        res.set('Cache-Control', 'no-store');
        return res.type('html').send(html);
    } catch (e) {
        return next();
    }
}

// ---------- Permanent activity log (activity.log, kept even when the server is off) ----------
const LOG_PATH = path.join(__dirname, 'activity.log');
/** Turns a long browser string into a short label, e.g. "iPhone iOS17", "Android SM-A156B", "Windows" */
const IPHONE_BY_SCREEN = {
    '320x568@2': 'iPhone 5/5s/SE1',
    '375x667@2': 'iPhone 6/7/8/SE2/SE3',
    '414x736@3': 'iPhone 6/7/8 Plus',
    '375x812@3': 'iPhone X/XS/11Pro/mini',
    '360x780@3': 'iPhone 12/13 mini',
    '414x896@2': 'iPhone XR/11',
    '414x896@3': 'iPhone XS Max/11PM',
    '390x844@3': 'iPhone 12/13/14/16e',
    '428x926@3': 'iPhone 12/13PM/14Plus',
    '393x852@3': 'iPhone 14Pro/15/16',
    '430x932@3': 'iPhone 14PM/15Plus/15PM/16Plus',
    '402x874@3': 'iPhone 16 Pro',
    '440x956@3': 'iPhone 16 Pro Max'
};
/** screen = "390x844@3" sent by the page. iPhones hide their model, so the screen size narrows it to a few models. */
function shortDevice(ua, screen) {
    ua = String(ua || '');
    let m;
    if (/CaptiveNetworkSupport/i.test(ua)) return 'Apple captive';
    if (/iPhone/.test(ua)) {
        const sm = String(screen || '').match(/^(\d+)x(\d+)@(\d+)/);
        if (sm) {
            const key = `${Math.min(+sm[1], +sm[2])}x${Math.max(+sm[1], +sm[2])}@${sm[3]}`;
            if (IPHONE_BY_SCREEN[key]) return IPHONE_BY_SCREEN[key];
        }
        return (m = ua.match(/OS (\d+)[_.]/)) ? `iPhone iOS${m[1]}` : 'iPhone';
    }
    if (/iPad/.test(ua)) return 'iPad';
    if (/Android/.test(ua)) {
        m = ua.match(/Android [\d.]+; ([^;)]+?)(?: Build|\)|;)/);
        return m && m[1].trim().length > 1 ? `Android ${m[1].trim()}`.slice(0, 24) : 'Android';
    }
    if (/Windows/.test(ua)) return 'Windows';
    if (/Macintosh|Mac OS/.test(ua)) return 'Mac';
    if (/Linux/.test(ua)) return 'Linux';
    return ua ? ua.slice(0, 14) : 'unknown';
}

function logEvent(type, details) {
    const line = `${new Date().toISOString()} | ${type.padEnd(12)} | ${details}\n`;
    fs.appendFile(LOG_PATH, line, (err) => { if (err) console.log('⚠️ Could not write activity.log:', err.message); });
}

// ---------- Low online-stock warning ----------
const LOW_STOCK = {
    '22 Hours Access': 50,
    '7-Days Access': 5,
    '30 Days Access': 3
};
function checkLowStock() {
    try {
        const db = getDB();
        Object.keys(LOW_STOCK).forEach(plan => {
            const left = Array.isArray(db[plan]) ? db[plan].length : 0;
            if (left <= LOW_STOCK[plan]) {
                const msg = `⚠️ LOW STOCK: ${plan} has only ${left} online voucher(s) left (limit ${LOW_STOCK[plan]}). Add more with move-stock.js or import-csv.js!`;
                for (let i = 0; i < 3; i++) console.log(msg);
                logEvent('LOW-STOCK', `plan=${plan} left=${left} limit=${LOW_STOCK[plan]}`);
                sendAlert(`low:${plan}`, `Low stock: ${plan} (${left} left)`,
                    `${plan} has only ${left} online voucher(s) left (alert limit ${LOW_STOCK[plan]}).\n\nAdd more with move-stock.js or import-csv.js before customers hit "Insufficient voucher stock".`);
            }
        });
    } catch (err) {
        console.log('Stock check failed:', err.message);
    }
}

// ---------- Routes ----------
// ---------- Purchases ----------
// The server writes down every purchase BEFORE the customer pays (/intent). If the phone then loses the
// page (a call comes in, the wifi drops...), the server still knows what was bought, checks Paystack by
// itself and issues the code. The customer can reopen the page, or use Retrieve with phone + PIN.
const PENDING_KEEP_MS = 24 * 60 * 60 * 1000;
const PENDING_MAX = 2000;

app.post('/intent', async (req, res) => {
    const { plan, quantity, pin, phone, clientMac, apMac, ssidName, radioId, site } = req.body || {};
    const qty = parseInt(quantity, 10);
    const cleanPin = String(pin || '').trim();
    const cleanPhone = normalizePhone(String(phone || '').trim());
    if (!PLANS[plan] || !Number.isInteger(qty) || qty < 1 || qty > 10) return res.status(400).json({ success: false, error: 'Invalid purchase request.' });
    if (!/^\d{4}$/.test(cleanPin)) return res.status(400).json({ success: false, error: 'PIN must be exactly 4 digits.' });
    if (!cleanPhone) return res.status(400).json({ success: false, error: 'Enter your phone number.' });

    const reference = 'ADM-' + Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex');
    const result = await withDbLock(async (db) => {
        if (!db.pending) db.pending = {};
        const cutoff = Date.now() - 3 * PENDING_KEEP_MS;
        Object.keys(db.pending).forEach(r => { if (db.pending[r].t < cutoff) delete db.pending[r]; });
        if (Object.keys(db.pending).length >= PENDING_MAX) return { error: 'The system is busy. Please try again later.' };
        db.pending[reference] = {
            plan, qty, pin: cleanPin, phone: cleanPhone, t: Date.now(),
            mac: clientMac ? formatHyphenMac(clientMac) : '', ip: req.ip
        };
        return { ok: true };
    });
    if (result.error) return res.status(503).json({ success: false, error: result.error });
    logEvent('PURCHASE-START', `ref=${reference} plan=${plan} qty=${qty} phone=${cleanPhone} pin=${cleanPin} mac=${clientMac ? formatHyphenMac(clientMac) : 'unknown'} ip=${req.ip}`);
    return res.json({ success: true, reference });
});

/**
 * Checks the payment with Paystack and, if it is genuine, issues the codes (once per reference).
 * Returns { vouchers, fresh } or { status, error, notPaid?, noStock? }. Throws if Paystack cannot be reached.
 */
const noStockLogged = new Set();
async function fulfillPayment(reference, plan, qtyNeeded, userPin, ip, source) {
    const planInfo = PLANS[plan];
    const paystackRes = await axios.get(
        `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
        { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` }, timeout: 15000 }
    );
    const txData = paystackRes.data.data;
    if (txData.status !== 'success') return { status: 400, error: 'Payment failed', notPaid: true };

    // The amount paid must match the plan and quantity (never trust the browser)
    if (txData.currency !== 'GHS' || txData.amount !== planInfo.price * qtyNeeded) {
        console.log(`❌ Amount mismatch for ${reference}: paid ${txData.amount} ${txData.currency}, expected ${planInfo.price * qtyNeeded}`);
        logEvent('PURCHASE-FAIL', `ref=${reference} plan=${plan} qty=${qtyNeeded} error=Amount mismatch (paid ${txData.amount} ${txData.currency}) source=${source}`);
        return { status: 400, error: 'Payment amount does not match the selected plan.', mismatch: true };
    }

    const customerPhone = txData.metadata?.custom_fields?.find(f => f.variable_name === 'mobile_number')?.value || '';

    const result = await withDbLock(async (db) => {
        if (!db.sales_history) db.sales_history = [];
        if (!db.pending) db.pending = {};

        // A reference can only ever produce one set of vouchers
        const existing = db.sales_history.find(s => s.reference === reference);
        if (existing) { delete db.pending[reference]; return { vouchers: [].concat(existing.vouchers), fresh: false }; }

        const availableCodes = db[plan] || [];
        if (availableCodes.length < qtyNeeded) return { error: 'Insufficient voucher stock in database.' };

        const pulledVouchers = availableCodes.splice(0, qtyNeeded);
        const pinSalt = crypto.randomBytes(16).toString('hex');
        db.sales_history.push({
            reference,
            phone: String(customerPhone).trim(),
            pinSalt,
            pinHash: hashPin(userPin, pinSalt),
            pin: String(userPin).trim(), // plain copy kept for admin support (owner's choice)
            plan,
            vouchers: pulledVouchers,
            date: new Date().toISOString()
        });
        delete db.pending[reference];
        return { vouchers: pulledVouchers, fresh: true };
    });

    if (result.error) {
        if (!noStockLogged.has(reference)) {   // log once per payment, not on every re-check
            noStockLogged.add(reference);
            logEvent('PURCHASE-FAIL', `ref=${reference} plan=${plan} qty=${qtyNeeded} ip=${ip} error=${result.error} source=${source}`);
        }
        return { status: 400, error: result.error, noStock: true };
    }
    if (result.fresh) {
        logEvent('PURCHASE', `ref=${reference} plan=${plan} qty=${qtyNeeded} ip=${ip} pin=${userPin} codes=${[].concat(result.vouchers).join(',')} source=${source}`);
        checkLowStock();
    }
    return { vouchers: result.vouchers, fresh: result.fresh };
}

app.post('/verify', async (req, res) => {
    const { reference, plan: bodyPlan, quantity, pin } = req.body || {};
    if (!reference || typeof reference !== 'string' || reference.length > 100) {
        return res.status(400).json({ success: false, error: 'Invalid purchase request.' });
    }
    // Already completed (by this page earlier or by the server's own recovery): hand the same code(s) back
    const done = (getDB().sales_history || []).find(x => x.reference === reference);
    if (done) return res.json({ success: true, vouchers: [].concat(done.vouchers) });

    // If the server wrote this purchase down before payment, its own record is the truth (not the browser)
    const pend = (getDB().pending || {})[reference];
    const plan = pend ? pend.plan : bodyPlan;
    const qtyNeeded = pend ? pend.qty : parseInt(quantity, 10);
    const userPin = pend ? pend.pin : String(pin || '').trim();

    if (!PLANS[plan] || !Number.isInteger(qtyNeeded) || qtyNeeded < 1 || qtyNeeded > 10) {
        return res.status(400).json({ success: false, error: 'Invalid purchase request.' });
    }
    if (!/^\d{4}$/.test(userPin)) {
        return res.status(400).json({ success: false, error: 'PIN must be exactly 4 digits.' });
    }

    try {
        const r = await fulfillPayment(reference, plan, qtyNeeded, userPin, req.ip, 'page');
        if (r.vouchers) return res.json({ success: true, vouchers: r.vouchers });
        return res.status(r.status || 400).json({ success: false, error: r.error });
    } catch (err) {
        if (err.response && err.response.status === 404) {
            return res.status(400).json({ success: false, error: 'Payment not found yet.', notFound: true });
        }
        console.error('💥 Verify Error:', err.response ? err.response.data : err.message);
        return res.status(500).json({ success: false, error: 'Verification processing failed.' });
    }
});

// Background recovery: finishes purchases whose phone never came back to the page.
// Checks pending purchases: every 10 s for the first 5 minutes, every 30 s until 20 minutes, then every 5 minutes up to 24 h.
const pendingLastTry = new Map();
let reconcileBusy = false;
async function reconcilePending() {
    if (reconcileBusy) return;
    reconcileBusy = true;
    try {
        const pend = getDB().pending || {};
        const now = Date.now();
        let checked = 0;
        for (const [ref, p] of Object.entries(pend)) {
            if (checked >= 20) break;
            const age = now - p.t;
            if (age < 15 * 1000) continue;   // let the customer's own page go first
            // check every 10 s for the first 5 minutes, every 30 s until 20 minutes, then every 5 minutes
            const every = age < 5 * 60 * 1000 ? 10 * 1000 : age < 20 * 60 * 1000 ? 30 * 1000 : 5 * 60 * 1000;
            if (now - (pendingLastTry.get(ref) || 0) < every - 1000) continue;
            pendingLastTry.set(ref, now);
            checked++;
            const drop = async (why) => {
                await withDbLock(async (db) => { if (db.pending) delete db.pending[ref]; });
                pendingLastTry.delete(ref);
                logEvent('PURCHASE-DROPPED', `ref=${ref} plan=${p.plan} qty=${p.qty} phone=${p.phone} reason=${why}`);
            };
            try {
                const r = await fulfillPayment(ref, p.plan, p.qty, p.pin, p.ip || 'server', 'auto-recovery');
                if (r.vouchers) {
                    pendingLastTry.delete(ref);
                    if (r.fresh) {
                        sendAlert(`recovered:${ref}`, `Payment recovered automatically (${p.plan} x${p.qty})`,
                            `A customer paid but their phone never finished the purchase. The server completed it by itself.\n\nPhone: ${p.phone}\nPIN: ${p.pin}\nPlan: ${p.plan} x${p.qty}\nReference: ${ref}\nCode(s): ${[].concat(r.vouchers).join(', ')}\n\nThe customer can reopen the splash page (the code appears), or tap "Retrieve my voucher" with their phone number and PIN.`,
                            60 * 1000);
                    }
                } else if (r.mismatch) {
                    await drop('amount does not match plan');
                    sendAlert(`mismatch:${ref}`, `Payment amount does not match (${p.plan} x${p.qty})`,
                        `A payment came in for a different amount than the purchase that was started, so no code was issued.\n\nPhone: ${p.phone}\nReference: ${ref}\nExpected: ${p.plan} x${p.qty}\n\nCheck the payment in your Paystack dashboard. If it is genuine, issue the code by hand: node reconcile-payments.js (it lists it).`, 60 * 60 * 1000);
                } else if (r.noStock) {
                    sendAlert(`nostock:${ref}`, `PAID but no stock for ${p.plan} x${p.qty}`,
                        `A customer paid but there are not enough ${p.plan} codes in online stock to give them.\n\nPhone: ${p.phone}\nReference: ${ref}\n\nAdd stock (node move-stock.js or import-csv.js). The server will issue the code automatically on its next check.`, 60 * 60 * 1000);
                } else if (age > PENDING_KEEP_MS) {
                    await drop(r.notPaid ? 'never paid' : 'rejected');
                }
            } catch (e) {
                if (age > PENDING_KEEP_MS) await drop(e.response && e.response.status === 404 ? 'payment never started' : 'unreachable for 24h');
                // otherwise Paystack/network hiccup: try again on a later tick
            }
        }
    } catch (e) {
        console.log('⚠️ Payment recovery check failed:', e.message);
    } finally {
        reconcileBusy = false;
    }
}

// Safety net: successful Paystack payments with a plan price that have NO code and NO pending record
// (for example from an old page version) are e-mailed to you, once each.
const noCodeNotified = new Set();
async function scanUnmatchedPayments() {
    try {
        const from = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
        const r = await axios.get('https://api.paystack.co/transaction', {
            headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` },
            params: { status: 'success', perPage: 100, from }, timeout: 20000
        });
        const db = getDB();
        const known = new Set((db.sales_history || []).map(s => s.reference));
        const keys = { '22 Hours Access': '22h', '7-Days Access': '7d', '30 Days Access': '30d' };
        for (const t of (r.data.data || [])) {
            if (t.currency !== 'GHS' || known.has(t.reference) || (db.pending || {})[t.reference] || noCodeNotified.has(t.reference)) continue;
            if (Date.now() - Date.parse(t.paid_at || t.created_at) < 3 * 60 * 1000) continue;   // give the normal flow time
            let guess = null;
            for (const [name, p] of Object.entries(PLANS)) for (let q = 1; q <= 10; q++) if (p.price * q === t.amount) guess = { name, q };
            if (!guess) continue;   // not a wifi price: not ours
            noCodeNotified.add(t.reference);
            const phone = (t.metadata?.custom_fields || []).find(f => f.variable_name === 'mobile_number')?.value || t.customer?.phone || 'unknown';
            logEvent('PAID-NO-CODE', `ref=${t.reference} phone=${phone} amount=${(t.amount / 100).toFixed(2)} looks-like=${guess.name} x${guess.q}`);
            sendAlert(`nocode:${t.reference}`, `Paid but no code: GHS ${(t.amount / 100).toFixed(2)} (${phone})`,
                `A customer paid on Paystack but never received a code.\n\nPhone: ${phone}\nAmount: GHS ${(t.amount / 100).toFixed(2)} (looks like ${guess.name} x${guess.q})\nReference: ${t.reference}\n\nTo give them their code, run:\nnode reconcile-payments.js --issue ${t.reference} --plan ${keys[guess.name]} --qty ${guess.q} --pin 1234\n(replace 1234 with a PIN you tell the customer)`, 24 * 60 * 60 * 1000);
        }
    } catch (e) { /* Paystack unreachable: try again next time */ }
}

app.post('/retrieve', (req, res) => {
    const { query, pin } = req.body || {};
    if (!query || !pin) return res.status(400).json({ success: false, error: 'Phone number and PIN required' });

    const searchPhone = normalizePhone(String(query).trim());
    const searchPin = String(pin).trim();

    if (tooManyAttempts(`ip:${req.ip}`) || tooManyAttempts(`phone:${searchPhone}`)) {
        logEvent('RETRIEVE-BLOCKED', `phone=${searchPhone} pin=${searchPin} ip=${req.ip}`);
        return res.status(429).json({ success: false, error: 'Too many attempts. Please try again later.' });
    }

    const history = getDB().sales_history || [];
    const matches = history.filter(record => {
        const dbPhone = normalizePhone(record.phone);
        return dbPhone && searchPhone && dbPhone === searchPhone && pinMatches(record, searchPin);
    });

    if (matches.length === 0) {
        logEvent('RETRIEVE-FAIL', `phone=${searchPhone} pin=${searchPin} ip=${req.ip}`);
        return res.status(404).json({ success: false, error: 'No matching records found for provided Phone and PIN.' });
    }

    const vouchers = matches.flatMap(m => Array.isArray(m.vouchers) ? m.vouchers : [m.vouchers]);
    logEvent('RETRIEVE', `phone=${searchPhone} pin=${searchPin} ip=${req.ip} codes=${vouchers.join(',')}`);
    return res.json({ success: true, vouchers });
});

// Time left on an activated voucher (used by the countdown on the splash page)
app.get('/status', (req, res) => {
    const code = String(req.query.code || '').trim();
    const ipKey = `status-ip:${req.ip}`;
    if (!code) return res.status(400).json({ success: false, error: 'Code required.' });
    if (isBlocked(ipKey, 30)) return res.status(429).json({ success: false, error: 'Too many attempts.' });

    const rec = (getDB().redeemed || {})[code];
    if (!rec) {
        recordFail(ipKey);
        return res.status(404).json({ success: false, error: 'Unknown code.' });
    }
    const remainingMs = rec.expiresAt - Date.now();
    if (remainingMs <= 0) return res.json({ success: false, expired: true, error: 'Expired.' });
    return res.json({ success: true, remainingMs, plan: rec.plan });
});

app.post('/activate', async (req, res) => {
    if (activateInFlight >= MAX_IN_FLIGHT_ACTIVATE) {
        res.set('Retry-After', '5');
        return res.status(503).json({ success: false, error: 'The system is busy. Please try again in a few seconds.' });
    }
    activateInFlight++;
    let released = false;
    const release = () => { if (!released) { released = true; activateInFlight = Math.max(0, activateInFlight - 1); } };
    res.on('finish', release);
    res.on('close', release);   // also covers phones that disconnect mid-request
    const { voucherCode, clientMac, apMac, ssidName, radioId, site, redirectUrl, screen: screenInfo } = req.body || {};
    const t0 = Date.now();

    console.log('\n--- 🔍 NEW ACTIVATION REQUEST ---');

    if (!voucherCode || !clientMac) {
        console.log('❌ REJECTED: Missing voucherCode or clientMac in request body');
        logEvent('ACTIVATE-FAIL', `code=${String(voucherCode || '').trim()} mac=${clientMac || 'missing'} ip=${req.ip} error=Missing code or MAC device=${shortDevice(req.headers['user-agent'])}`);
        return res.status(400).json({ success: false, error: 'Voucher code and Client MAC are required.' });
    }

    // Guess protection: banned devices may only use vouchers bought online; locked devices must wait
    const macNorm = normMac(clientMac);
    const permBanned = isBanned(macNorm);
    const deviceBanned = permBanned || onlineUntil(macNorm) > Date.now();
    const deviceInfo = shortDevice(req.headers['user-agent'], screenInfo);
    const lockLeftMs = Math.max(lockedUntil.get(`fail-mac:${macNorm}`) || 0, lockedUntil.get(`fail-ip:${req.ip}`) || 0, lockedUntil.get(`banned-mac:${macNorm}`) || 0) - Date.now();
    if (lockLeftMs > 0) {
        console.log('⛔ Locked out (too many wrong codes):', req.ip, clientMac);
        logEvent('LOCKED-TRY', `code=${String(voucherCode).trim()} mac=${formatHyphenMac(clientMac)} ip=${req.ip} left=${Math.ceil(lockLeftMs / 60000)}min device=${deviceInfo}`);
        return res.status(429).json({ success: false, error: `Too many wrong codes. Try again in ${Math.ceil(lockLeftMs / 60000)} minute(s).` });
    }

    const formattedClientMac = formatHyphenMac(clientMac);
    const formattedApMac = apMac ? formatHyphenMac(apMac) : undefined;
    const targetSite = site || OMADA_SITE;
    const targetSsid = String(ssidName || OMADA_SSID).trim();
    const parsedRadioId = (radioId !== undefined && radioId !== null && radioId !== '') ? Number(radioId) : 0;
    // Clean typos: remove spaces and stray punctuation at the ends (e.g. ",825385" or "825385.")
    const code = String(voucherCode).replace(/[\s\-.,]+/g, '').replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');

    // Codes are exactly 6 digits. Anything else (a typed "2", letters, too short) cannot be a real code:
    // tell the customer, but do NOT count it as a guess (so honest mistakes never lead to the stripped page).
    if (!/^\d{6}$/.test(code)) {
        logEvent('BAD-FORMAT', `code=${code.slice(0, 20)} mac=${formattedClientMac} ip=${req.ip} device=${deviceInfo}`);
        return res.status(400).json({ success: false, error: 'A voucher code is 6 digits (numbers only). Please check it and try again.' });
    }

    // 1) Validate the voucher ourselves: Omada knows nothing about our voucher codes
    console.log('Voucher entered:', JSON.stringify(code));

    const check = await withDbLock(async (db) => {
        if (!db.redeemed) db.redeemed = {};
        let rec = db.redeemed[code];

        if (!rec) {
            let plan = null;

            // 1) Bought online: plan comes from the sale record
            const sale = (db.sales_history || []).find(s =>
                [].concat(s.vouchers).some(v => String(v).trim() === code));
            if (sale) {
                plan = sale.plan;
            } else {
                // Banned devices can only use codes bought online, never stock or printed codes
                if (deviceBanned) return { error: ONLINE_ONLY_ERROR };

                // 2) Unsold codes: online stock list OR the manual (pre-printed) list
                for (const p of Object.keys(PLANS)) {
                    const lists = [db[p] || [], (db.manual && db.manual[p]) || []];
                    for (const list of lists) {
                        const idx = list.findIndex(v => String(v).trim() === code);
                        if (idx !== -1) {
                            plan = p;
                            list.splice(idx, 1); // remove so it can't be reused or sold
                            break;
                        }
                    }
                    if (plan) break;
                }
            }

            if (!plan) return { error: 'Invalid voucher code.' };

            rec = db.redeemed[code] = {
                clientMac: formattedClientMac,
                plan,
                expiresAt: Date.now() + PLANS[plan].durationMs
            };
        }

        if (Date.now() >= rec.expiresAt) return { error: 'Voucher expired.' };

        // One code, one device: it stays locked to the first device that used it
        if (rec.clientMac !== formattedClientMac) return { error: 'Voucher already used on another device.' };

        return { remainingMs: rec.expiresAt - Date.now() };
    });

    const tCheck = Date.now();

    if (check.error) {
        logEvent(deviceBanned ? 'BANNED-TRY' : 'ACTIVATE-FAIL', `code=${code} mac=${formattedClientMac} ip=${req.ip} error=${check.error} device=${deviceInfo}`);
        console.log('❌ VOUCHER REJECTED:', check.error);
        let message = check.error;
        // Expired codes get a softer limit; wrong or already-used codes count as guesses
        if (check.error === 'Voucher expired.') {
            if (registerExpired(macNorm, req.ip, code, deviceInfo)) message = 'Too many expired codes. For the next 6 hours this device can only use a voucher bought online.';
        } else {
            const outcome = registerFailure(macNorm, req.ip, code, deviceInfo);
            if (deviceBanned && check.error === ONLINE_ONLY_ERROR && registerBannedTry(macNorm, req.ip, code, deviceInfo)) {
                message = 'Too many tries. This device is paused for 2 hours. You can still buy a voucher online.';
            }
            if (outcome && outcome.banned) message = 'This device has been blocked. Please contact support.';
            else if (outcome && outcome.restricted) message = `Wrong voucher code. Voucher entry is paused for ${outcome.hours} hours. You can buy your voucher online.`;
            else if (outcome && outcome.warn) message = 'One more wrong attempt gets you banned, unless access is bought online';
            else if (outcome) message = `Too many wrong codes. Try again in ${Math.round(LOCK_MS / 60000)} minutes.`;
        }
        return res.status(400).json({ success: false, error: message, restricted: /paused|blocked|only use/i.test(message) });
    }

    // 2) Tell Omada to authorize this client for the remaining time
    const payload = {
        clientMac: formattedClientMac,
        apMac: formattedApMac,
        ssidName: targetSsid,
        radioId: parsedRadioId,
        site: targetSite,
        time: check.remainingMs, // See note: confirm unit/meaning on your controller version
        authType: 4
    };

    console.log('Validated Auth Payload:', payload);

    const executeAuthorization = async (session) => {
        const authUrl = `${OMADA_URL}/${OMADA_CONTROLLER_ID}/api/v2/hotspot/extPortal/auth`;
        return await axios.post(authUrl, payload, {
            httpsAgent,
            timeout: 10000,
            params: { token: session.token },
            headers: {
                'Csrf-Token': session.token,
                'Cookie': session.cookie,
                'Content-Type': 'application/json'
            }
        });
    };

    try {
        let session = await getOmadaToken();
        const tLogin = Date.now();
        console.log('📡 Sending Authorization Request to Omada Controller...');

        let response;
        try {
            response = await executeAuthorization(session);
        } catch (apiErr) {
            if (apiErr.response && (apiErr.response.status === 401 || apiErr.response.status === 403)) {
                console.log('⚠️ Session expired. Refreshing token...');
                session = await getOmadaToken(true);
                response = await executeAuthorization(session);
            } else {
                throw apiErr;
            }
        }

        const tDone = Date.now();
        console.log(`⏱️ Timing: voucher check ${tCheck - t0}ms | omada login ${tLogin - tCheck}ms | omada authorize ${tDone - tLogin}ms | total ${tDone - t0}ms`);
        console.log('📩 Raw Omada API Response:', JSON.stringify(response.data, null, 2));

        if (response.data && response.data.errorCode === 0) {
            console.log('✅ AUTHENTICATION SUCCESSFUL!');
            logEvent('ACTIVATE', `code=${code} mac=${formattedClientMac} ip=${req.ip} remaining=${Math.round(check.remainingMs / 60000)}min device=${deviceInfo}`);
            return res.json({ success: true, redirectUrl: redirectUrl || 'https://www.google.com', remainingMs: check.remainingMs });
        }

        logEvent('OMADA-FAIL', `code=${code} mac=${formattedClientMac} error=${response.data?.errorCode} ${response.data?.msg}`);
        console.log(`❌ OMADA REJECTED (Code ${response.data?.errorCode}): ${response.data?.msg}`);
        return res.status(400).json({
            success: false,
            error: `Omada Error (${response.data?.errorCode}): ${response.data?.msg}`
        });
    } catch (err) {
        console.error('💥 Execution Error:', err.response ? err.response.data : err.message);
        const detail = err.response?.data?.msg || err.message || 'Internal server error.';
        logEvent('ERROR', `code=${code} mac=${formattedClientMac} error=${detail}`);
        return res.status(500).json({ success: false, error: detail });
    }
});

// ---------- Email alerts ----------
// Needs in .env:  ALERT_EMAIL_TO, ALERT_SMTP_USER, ALERT_SMTP_PASS   (optional: ALERT_SMTP_HOST, ALERT_SMTP_PORT)
// Default mail server is Gmail (use an App Password, not your normal password). If not set up, alerts are skipped.
let nodemailer = null;
try { nodemailer = require('nodemailer'); } catch (e) { /* run: npm install nodemailer */ }
const ALERT_TO = process.env.ALERT_EMAIL_TO;
const ALERT_USER = process.env.ALERT_SMTP_USER;
const ALERT_PASS = process.env.ALERT_SMTP_PASS;
const alertsOn = !!(nodemailer && ALERT_TO && ALERT_USER && ALERT_PASS);
const alertTransport = alertsOn ? nodemailer.createTransport({
    host: process.env.ALERT_SMTP_HOST || 'smtp.gmail.com',
    port: Number(process.env.ALERT_SMTP_PORT) || 465,
    secure: (Number(process.env.ALERT_SMTP_PORT) || 465) === 465,
    auth: { user: ALERT_USER, pass: ALERT_PASS }
}) : null;
const alertLastSent = new Map();

/** Sends an email. The same alert (same key) is not repeated before cooldownMs has passed. */
async function sendAlert(key, subject, body, cooldownMs = 6 * 60 * 60 * 1000) {
    if (!alertsOn) return;
    if (Date.now() - (alertLastSent.get(key) || 0) < cooldownMs) return;
    alertLastSent.set(key, Date.now());
    try {
        await alertTransport.sendMail({
            from: `"ADM WiFi Portal" <${ALERT_USER}>`,
            to: ALERT_TO,
            subject: `[ADM WiFi] ${subject}`,
            text: `${body}\n\nSent ${new Date().toISOString().replace('T', ' ').slice(0, 19)} (Ghana time)`
        });
        logEvent('EMAIL-SENT', `subject=${subject}`);
    } catch (err) {
        alertLastSent.delete(key); // try again next time
        console.log('⚠️ Could not send alert email:', err.message);
        logEvent('EMAIL-FAIL', `subject=${subject} error=${err.message}`);
    }
}

// ---------- Omada health check ----------
// Every 5 minutes: is the controller reachable and does the operator login work?
// Two failures in a row = OMADA-DOWN (loud warning); first success afterwards = OMADA-UP.
const HEALTH_EVERY_MS = 5 * 60 * 1000;
let healthFails = 0;
let omadaDownSince = null;

async function omadaHealthCheck() {
    try {
        // 1) Controller reachable? (any HTTP answer counts)
        await axios.get(`${OMADA_URL}/api/info`, { httpsAgent, timeout: 8000, validateStatus: () => true });
        // 2) Operator login works? (uses the saved session, logs in again only when it has expired)
        await getOmadaToken();

        if (omadaDownSince) {
            const mins = Math.round((Date.now() - omadaDownSince) / 60000);
            console.log(`🟢 OMADA IS BACK (was down about ${mins} min)`);
            sendAlert('omada-up', 'Omada is back', `The Omada controller is responding again. It was down for about ${mins} minute(s).`, 0);
            alertLastSent.delete('omada-down');
            logEvent('OMADA-UP', `back after about ${mins}min`);
        }
        healthFails = 0;
        omadaDownSince = null;
    } catch (err) {
        healthFails++;
        const reason = err.response?.data?.msg || err.message;
        if (healthFails >= 2) {
            if (!omadaDownSince) {
                omadaDownSince = Date.now();
                logEvent('OMADA-DOWN', `reason=${reason}`);
            }
            sendAlert('omada-down', 'PROBLEM: Omada is not responding',
                `Customers cannot connect.\n\nReason: ${reason}\n\nCheck that the Omada controller is running on the laptop and that the operator password in .env is correct. You will get a reminder every hour while this lasts.`,
                60 * 60 * 1000);
            console.log('\n🔴🔴🔴 OMADA IS NOT RESPONDING - customers cannot connect! 🔴🔴🔴');
            console.log(`   Reason: ${reason}`);
            console.log('   Check: is the Omada controller running? Is the operator password in .env correct?\n');
        } else {
            console.log(`⚠️ Omada health check failed once (${reason}). Checking again soon...`);
        }
    }
}

// ---------- Daily backup ----------
// Copies vouchers.json, banned.json and activity.log into backups/YYYY-MM-DD/ (refreshed every hour,
// so each day's folder ends up holding that day's last state). The newest 14 days are kept.
const BACKUP_DIR = path.join(__dirname, 'backups');
const BACKUP_KEEP_DAYS = 14;

async function runBackup() {
    try {
        const day = new Date().toISOString().slice(0, 10);
        const dir = path.join(BACKUP_DIR, day);
        const isNewDay = !fs.existsSync(dir);
        fs.mkdirSync(dir, { recursive: true });

        // Take vouchers.json under the lock so it is never copied halfway through a save
        await withDbLock(async (db) => {
            fs.writeFileSync(path.join(dir, 'vouchers.json'), JSON.stringify(db, null, 2), 'utf8');
        });
        for (const f of ['banned.json', 'restrictions.json', 'activity.log']) {
            const src = path.join(__dirname, f);
            if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, f));
        }

        if (isNewDay) {
            logEvent('BACKUP', `saved to backups/${day}`);
            console.log(`💾 Daily backup saved: backups/${day}`);
        }

        // Remove backups older than BACKUP_KEEP_DAYS
        const cutoff = new Date(Date.now() - BACKUP_KEEP_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        for (const name of fs.readdirSync(BACKUP_DIR)) {
            if (/^\d{4}-\d{2}-\d{2}$/.test(name) && name < cutoff) {
                fs.rmSync(path.join(BACKUP_DIR, name), { recursive: true, force: true });
            }
        }
    } catch (err) {
        console.log('⚠️ Backup failed:', err.message);
        logEvent('BACKUP-FAIL', err.message);
    }
}

const PORT = Number(process.env.PORT) || 3000;
const httpServer = app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Portal active on port ${PORT}`);
    warmOmadaSession();
    checkLowStock();
    setInterval(warmOmadaSession, 40 * 60 * 1000); // refresh before the 50-minute expiry
    console.log(alertsOn ? `📧 Email alerts ON -> ${ALERT_TO}` : '📧 Email alerts OFF (add ALERT_EMAIL_TO, ALERT_SMTP_USER, ALERT_SMTP_PASS to .env and run: npm install nodemailer)');
    runBackup();
    setInterval(runBackup, 60 * 60 * 1000);
    setTimeout(omadaHealthCheck, 15 * 1000); // first check shortly after startup
    setInterval(omadaHealthCheck, HEALTH_EVERY_MS);
    setInterval(reconcilePending, 5 * 1000);             // finish purchases whose phone dropped off the page
    setTimeout(scanUnmatchedPayments, 60 * 1000);          // payments with no code at all: e-mail me
    setInterval(scanUnmatchedPayments, 5 * 60 * 1000);
});
// Drop slow or stalled connections (protects against "slowloris" style attacks)
httpServer.headersTimeout = 10 * 1000;
httpServer.requestTimeout = 20 * 1000;
httpServer.keepAliveTimeout = 5 * 1000;
httpServer.maxConnections = 500;