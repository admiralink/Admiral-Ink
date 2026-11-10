// ban.js - manage blocked devices (banned.json)
//   node ban.js                          show banned devices and devices with strikes
//   node ban.js add AA-BB-CC-DD-EE-FF    ban a device by hand
//   node ban.js remove AA-BB-CC-DD-EE-FF unban a device (also clears its strikes)
// Safe to run while server.js is running (the server reads banned.json on every attempt).

const fs = require('fs');
const path = require('path');
console.log('🕒 Checked at ' + new Date().toISOString().replace('T', ' ').slice(0, 19) + ' (Ghana time)');

const BAN_PATH = path.join(__dirname, 'banned.json');
const norm = (m) => String(m || '').toUpperCase().replace(/[^0-9A-F]/g, '');
const pretty = (m) => (m.match(/.{2}/g) || []).join('-');

/** Finds the last IP address and device name seen for a device in activity.log */
function lastInfoFor(mac) {
    const info = { ip: '', device: '' };
    try {
        const lines = fs.readFileSync(path.join(__dirname, 'activity.log'), 'utf8').split('\n');
        for (let i = lines.length - 1; i >= 0 && !(info.ip && info.device); i--) {
            const l = lines[i];
            if (!(l.includes(`mac=${pretty(mac)}`) || l.includes(`mac=${mac}`))) continue;
            if (!info.ip) { const m = l.match(/ip=([\d.]+)/); if (m) info.ip = m[1]; }
            if (!info.device) { const m = l.match(/device="?([^"\n]+?)"?\s*$/); if (m) info.device = m[1].trim(); }
        }
    } catch (e) { /* no log yet */ }
    return info;
}

let data = { banned: {}, strikes: {} };
try {
    const b = JSON.parse(fs.readFileSync(BAN_PATH, 'utf8'));
    data = { banned: b.banned || {}, strikes: b.strikes || {} };
} catch (e) { /* no file yet */ }

const RESTR_PATH = path.join(__dirname, 'restrictions.json');
let restr = { onlineOnly: {}, day: {} };
try { const r = JSON.parse(fs.readFileSync(RESTR_PATH, 'utf8')); restr = { onlineOnly: r.onlineOnly || {}, day: r.day || {} }; } catch (e) { /* none yet */ }
const action = process.argv[2];
const mac = norm(process.argv[3]);

if (action === 'add' || action === 'remove') {
    if (mac.length !== 12) { console.log('Give the MAC like AA-BB-CC-DD-EE-FF'); process.exit(1); }
    const { ip, device } = lastInfoFor(mac);
    if (action === 'add') {
        data.banned[mac] = { since: new Date().toISOString(), reason: 'banned by hand', lastIp: ip, device };
        console.log('🚫 Banned', pretty(mac), ip ? `(last IP ${ip}, device ${device || 'unknown'})` : '(no IP or device found in the log)');
    } else {
        delete data.banned[mac];
        delete data.strikes[mac];
        delete restr.onlineOnly[mac];
        delete restr.day[mac];
        fs.writeFileSync(RESTR_PATH, JSON.stringify(restr, null, 2), 'utf8');
        console.log('✅ Unbanned', pretty(mac), '(stripped page and daily strikes cleared too)');
    }
    fs.writeFileSync(BAN_PATH, JSON.stringify(data, null, 2), 'utf8');
    fs.appendFileSync(path.join(__dirname, 'activity.log'),
        `${new Date().toISOString()} | ${action === 'add' ? 'BAN-MANUAL' : 'UNBAN'}     | mac=${pretty(mac)} ip=${ip || 'unknown'} device=${device || 'unknown'}\n`);
    process.exit(0);
}

const banned = Object.keys(data.banned);
console.log(`\nBANNED DEVICES (${banned.length})`);
banned.forEach(m => {
    const e = data.banned[m], info = lastInfoFor(m);
    console.log(`  ${pretty(m)}  since ${e.since}  last IP ${e.lastIp || info.ip || 'unknown'}  device ${e.device || info.device || 'unknown'}  (${e.reason})`);
});

const strikes = Object.keys(data.strikes).filter(m => !data.banned[m]);
console.log(`\nDEVICES WITH LOCKOUT STRIKES (${strikes.length})`);
strikes.forEach(m => {
    const e = data.strikes[m], info = lastInfoFor(m);
    console.log(`  ${pretty(m)}  ${e.count} lockout(s), last ${new Date(e.last).toLocaleString()}  last IP ${e.lastIp || info.ip || 'unknown'}  device ${e.lastDevice || info.device || 'unknown'}`);
});
const now = Date.now();
const stripped = Object.keys(restr.onlineOnly).filter(m => restr.onlineOnly[m] > now && !data.banned[m]);
console.log(`\nSTRIPPED PAGE RIGHT NOW (${stripped.length})`);
stripped.forEach(m => {
    const info = lastInfoFor(m), left = restr.onlineOnly[m] - now;
    console.log(`  ${pretty(m)}  ${Math.floor(left / 3600000)}h ${Math.round(left % 3600000 / 60000)}m left  level ${(restr.day[m] || {}).level || '-'}  last IP ${info.ip || 'unknown'}  device ${info.device || 'unknown'}`);
});
console.log('\nUsage: node ban.js add <MAC> | node ban.js remove <MAC>\n');
