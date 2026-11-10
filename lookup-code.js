// lookup-code.js
// Look up a code:             node lookup-code.js CODE
// Move it to a new device:    node lookup-code.js CODE --rebind AA-BB-CC-DD-EE-FF --apply
// (rebinding keeps the time that is left; STOP server.js before using --apply)

const fs = require('fs');
const path = require('path');
console.log('🕒 Checked at ' + new Date().toISOString().replace('T', ' ').slice(0, 19) + ' (Ghana time)');

const DB_PATH = path.join(__dirname, 'vouchers.json');
const LOG_PATH = path.join(__dirname, 'activity.log');
const code = (process.argv[2] || '').trim();
const rebindIdx = process.argv.indexOf('--rebind');
const newMac = rebindIdx !== -1 ? String(process.argv[rebindIdx + 1] || '') : '';
const APPLY = process.argv.includes('--apply');

if (!code) {
    console.log('Usage: node lookup-code.js CODE [--rebind AA-BB-CC-DD-EE-FF --apply]');
    process.exit(1);
}

const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
const PLANS = ['22 Hours Access', '7-Days Access', '30 Days Access'];

function fmtLeft(ms) {
    const m = Math.floor(ms / 60000);
    return `${Math.floor(m / 60)}h ${m % 60}m`;
}

console.log(`\nCode: ${code}`);

const rec = (db.redeemed || {})[code];
if (rec) {
    const left = rec.expiresAt - Date.now();
    console.log('Status      : ACTIVATED');
    console.log('Plan        :', rec.plan);
    console.log('Bound device:', rec.clientMac);
    console.log('Expires     :', new Date(rec.expiresAt).toLocaleString());
    console.log('Time left   :', left > 0 ? fmtLeft(left) : 'EXPIRED');
} else {
    const inOnline = PLANS.find(p => (db[p] || []).some(v => String(v).trim() === code));
    const inManual = PLANS.find(p => ((db.manual || {})[p] || []).some(v => String(v).trim() === code));
    const sale = (db.sales_history || []).find(s => [].concat(s.vouchers).some(v => String(v).trim() === code));
    if (inManual) console.log(`Status      : NEVER USED (printed/manual stock, ${inManual})`);
    else if (inOnline) console.log(`Status      : NEVER USED (online stock, ${inOnline})`);
    else if (sale) console.log(`Status      : SOLD ONLINE, not activated yet (${sale.plan}, phone ${sale.phone})`);
    else console.log('Status      : NOT FOUND in the database');
}

if (fs.existsSync(LOG_PATH)) {
    const lines = fs.readFileSync(LOG_PATH, 'utf8').split('\n').filter(l => l.includes(`code=${code}`));
    console.log(`\nHistory in activity.log (${lines.length} lines):`);
    lines.slice(-15).forEach(l => console.log('  ' + l));
}

if (rebindIdx !== -1) {
    if (!rec) { console.log('\n❌ Nothing to rebind: this code has not been activated.'); process.exit(1); }
    const mac = newMac.toUpperCase().replace(/[^0-9A-F]/g, '');
    if (mac.length !== 12) { console.log('\n❌ Give the new MAC like AA-BB-CC-DD-EE-FF'); process.exit(1); }
    const formatted = mac.match(/.{2}/g).join('-');
    console.log(`\nWould change bound device ${rec.clientMac} -> ${formatted}`);
    if (!APPLY) { console.log('Preview only. Add --apply to do it.'); process.exit(0); }
    fs.copyFileSync(DB_PATH, path.join(__dirname, `vouchers-backup-${Date.now()}.json`));
    rec.clientMac = formatted;
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
    fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} | REBIND       | code=${code} newmac=${formatted}\n`);
    console.log('✅ Done. The customer can enter the code again on that device.');
}
console.log('');
