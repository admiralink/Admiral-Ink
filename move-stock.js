// move-stock.js
// Moves codes from the MANUAL (printed) list into the ONLINE-SALE list.
// Preview:  node move-stock.js 22h 500
// Apply:    node move-stock.js 22h 500 --apply
// Tiers: 22h | 7d | 30d      STOP server.js before using --apply.

const fs = require('fs');
const path = require('path');
console.log('🕒 Checked at ' + new Date().toISOString().replace('T', ' ').slice(0, 19) + ' (Ghana time)');

const DB_PATH = path.join(__dirname, 'vouchers.json');
const TIERS = { '22h': '22 Hours Access', '7d': '7-Days Access', '30d': '30 Days Access' };

const plan = TIERS[String(process.argv[2]).toLowerCase()];
const count = parseInt(process.argv[3], 10);
const APPLY = process.argv.includes('--apply');

if (!plan || !count || count < 1) {
    console.log('Usage: node move-stock.js <22h|7d|30d> <how many> [--apply]');
    process.exit(1);
}

const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
if (!Array.isArray(db[plan])) db[plan] = [];
const manual = (db.manual && db.manual[plan]) || [];

if (manual.length < count) {
    console.log(`❌ Only ${manual.length} manual codes available for ${plan}.`);
    process.exit(1);
}

console.log(`${plan}: manual ${manual.length} -> ${manual.length - count}, online ${db[plan].length} -> ${db[plan].length + count}`);

if (!APPLY) {
    console.log('Preview only. Add --apply to do it.');
    process.exit(0);
}

const backup = path.join(__dirname, `vouchers-backup-${Date.now()}.json`);
fs.copyFileSync(DB_PATH, backup);
console.log('💾 Backup saved:', path.basename(backup));

// Take from the END so the first codes stay in the printed/manual batch
const moved = manual.splice(manual.length - count, count);
db[plan].push(...moved);
db.manual[plan] = manual;

fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
console.log(`✅ Moved ${count} codes to online sale. Run "node check-stock.js" to confirm.`);
