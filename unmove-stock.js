// unmove-stock.js - move UNSOLD codes from the ONLINE-sale stock back to the MANUAL (printed) stock
//   node unmove-stock.js 22h          preview: how many would move for that plan (changes nothing)
//   node unmove-stock.js all          preview for all three plans
//   node unmove-stock.js 22h --apply  do it (a backup is saved first). Use 7d, 30d or all as well.
// Codes already SOLD online are not touched. Stop server.js before --apply (pm2 stop portal), start it after.
const fs = require('fs');
const path = require('path');
console.log('🕒 Checked at ' + new Date().toISOString().replace('T', ' ').slice(0, 19) + ' (Ghana time)');
const DB_PATH = path.join(__dirname, 'vouchers.json');
const NAMES = { '22h': '22 Hours Access', '7d': '7-Days Access', '30d': '30 Days Access' };
const which = String(process.argv[2] || '').toLowerCase();
const APPLY = process.argv.includes('--apply');
const plans = which === 'all' ? Object.values(NAMES) : (NAMES[which] ? [NAMES[which]] : []);
if (!plans.length) { console.log('Usage: node unmove-stock.js 22h|7d|30d|all [--apply]'); process.exit(1); }
const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
if (!db.manual) db.manual = {};
let total = 0;
plans.forEach(p => {
    const online = Array.isArray(db[p]) ? db[p] : [];
    if (!Array.isArray(db.manual[p])) db.manual[p] = [];
    const have = new Set(db.manual[p].map(v => String(v).trim()));
    const moving = online.filter(v => !have.has(String(v).trim()));
    console.log(`${p}: ${online.length} online codes -> ${moving.length} move to manual (${online.length - moving.length} already in manual, dropped from online)`);
    total += online.length;
    if (APPLY) { db.manual[p].push(...moving); db[p] = []; }
});
if (!APPLY) { console.log('\nPreview only. Add --apply to do it.'); process.exit(0); }
fs.copyFileSync(DB_PATH, path.join(__dirname, `vouchers-backup-${Date.now()}.json`));
const tmp = DB_PATH + '.tmp';
fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
fs.renameSync(tmp, DB_PATH);
fs.appendFileSync(path.join(__dirname, 'activity.log'), `${new Date().toISOString()} | UNMOVE-STOCK | plans=${which} codes=${total}\n`);
console.log('\n✅ Done. Online stock is empty for the chosen plan(s). Run "node check-stock.js" to confirm.');
