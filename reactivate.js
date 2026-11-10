// reactivate.js - put a used code back so it can be used again (fresh full time, any device)
//   node reactivate.js 123456            puts the code back (a backup of vouchers.json is saved first)
//   node reactivate.js add 123456        same thing
//   node reactivate.js 123456 --online   puts it back in the ONLINE-SALE stock instead of the manual (printed) stock
// Safe to run while server.js is running (the server reads vouchers.json on every request).
//
// Where the code goes back to:
//   - bought online by a customer: it goes back to that customer (they can use or retrieve it again)
//   - printed/manual code (default): back into the manual stock for its plan, so it can be entered again
//   - with --online: back into the online-sale stock, so it can be sold on the splash page again
// NOTE: the device that used it STAYS connected until its time runs out. To cut it off now, open the
//       Omada controller > Clients, find the device (MAC is printed below) and click Unauthorize.

const fs = require('fs');
const path = require('path');
console.log('🕒 Checked at ' + new Date().toISOString().replace('T', ' ').slice(0, 19) + ' (Ghana time)');

const DB_PATH = path.join(__dirname, 'vouchers.json');
const LOG_PATH = path.join(__dirname, 'activity.log');
const args = process.argv.slice(2).filter(a => a.toLowerCase() !== 'add');
const ONLINE = args.includes('--online');
const code = (args.find(a => !a.startsWith('--')) || '').replace(/\s+/g, '').replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
const PLANS = ['22 Hours Access', '7-Days Access', '30 Days Access'];

if (!code) {
    console.log('Usage: node reactivate.js 123456   (add --online to return it to the online-sale stock)');
    process.exit(1);
}
if (!fs.existsSync(DB_PATH)) { console.error('❌ vouchers.json not found next to this script.'); process.exit(1); }

const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
const has = (list) => Array.isArray(list) && list.some(v => String(v).trim() === code);
const inStock = PLANS.some(p => has(db[p]) || (db.manual && has(db.manual[p])));
const soldTo = (db.sales_history || []).find(s => [].concat(s.vouchers).some(v => String(v).trim() === code));
const rec = db.redeemed && db.redeemed[code];

if (!rec) {
    if (inStock) console.log(`✅ ${code} is already unused and valid. Nothing to do.`);
    else if (soldTo) console.log(`✅ ${code} was bought online and has not been used yet, so it is already valid. Nothing to do.`);
    else console.log(`❌ ${code} is not in the database at all.`);
    process.exit(0);
}

const plan = rec.plan;
const left = rec.expiresAt - Date.now();
console.log(`Code ${code} | plan ${plan} | used on device ${rec.clientMac} | ${left > 0 ? Math.floor(left / 60000 / 60) + 'h ' + (Math.floor(left / 60000) % 60) + 'm of its time were left' : 'its time had already run out'}`);

// Backup first
const dir = path.join(__dirname, 'backups');
try {
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(DB_PATH, path.join(dir, `vouchers-before-reactivate-${Date.now()}.json`));
} catch (e) { console.log('⚠️  Could not save a backup:', e.message); }

// Re-read right before changing so we do not overwrite a sale that just happened
const fresh = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
delete fresh.redeemed[code];
let where;
if (soldTo) {
    where = 'the hands of the customer who bought it online (it was never in stock)';
} else if (ONLINE) {
    if (!Array.isArray(fresh[plan])) fresh[plan] = [];
    if (!has(fresh[plan])) fresh[plan].push(code);
    where = `the ONLINE-SALE stock (${plan})`;
} else {
    if (!fresh.manual) fresh.manual = {};
    if (!Array.isArray(fresh.manual[plan])) fresh.manual[plan] = [];
    if (!has(fresh.manual[plan])) fresh.manual[plan].push(code);
    where = `the MANUAL (printed) stock (${plan})`;
}
const tmp = DB_PATH + '.tmp';
fs.writeFileSync(tmp, JSON.stringify(fresh, null, 2), 'utf8');
fs.renameSync(tmp, DB_PATH);

fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} | REACTIVATE   | code=${code} plan=${plan} was-mac=${rec.clientMac} returned-to=${soldTo ? 'buyer' : ONLINE ? 'online-stock' : 'manual-stock'}\n`);
console.log(`✅ ${code} is valid again is now in ${where}. It will get its full time when it is next used.`);
if (left > 0) console.log(`⚠️  Device ${rec.clientMac} is still online until its old time ends. To cut it off now: Omada > Clients > find that MAC > Unauthorize.\n`);
