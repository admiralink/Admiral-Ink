// reset-vouchers.js
// Preview (changes nothing):  node reset-vouchers.js
// Wipe and start fresh:       node reset-vouchers.js --confirm
// STOP server.js before using --confirm.

const fs = require('fs');
const path = require('path');
console.log('🕒 Checked at ' + new Date().toISOString().replace('T', ' ').slice(0, 19) + ' (Ghana time)');

const DB_PATH = path.join(__dirname, 'vouchers.json');
const CONFIRM = process.argv.includes('--confirm');

const fresh = {
    "22 Hours Access": [],
    "7-Days Access": [],
    "30 Days Access": [],
    "manual": { "22 Hours Access": [], "7-Days Access": [], "30 Days Access": [] },
    "sales_history": [],
    "redeemed": {}
};

const len = (x) => (Array.isArray(x) ? x.length : 0);

if (fs.existsSync(DB_PATH)) {
    let old = {};
    try { old = JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); } catch (e) { console.log('⚠️  Existing vouchers.json could not be parsed. It will still be archived as-is.'); }

    const online = ['22 Hours Access', '7-Days Access', '30 Days Access'].reduce((n, p) => n + len(old[p]), 0);
    const manual = old.manual ? Object.values(old.manual).reduce((n, l) => n + len(l), 0) : 0;
    const redeemed = old.redeemed ? Object.keys(old.redeemed).length : 0;

    console.log('Current vouchers.json contains:');
    console.log(`  online stock codes : ${online}`);
    console.log(`  manual stock codes : ${manual}`);
    console.log(`  sales records      : ${len(old.sales_history)}`);
    console.log(`  activated codes    : ${redeemed}`);
}

if (!CONFIRM) {
    console.log('\nPreview only. Nothing was changed.');
    console.log('Run "node reset-vouchers.js --confirm" to archive the current file and start fresh.');
    process.exit(0);
}

if (fs.existsSync(DB_PATH)) {
    const archive = path.join(__dirname, `vouchers-archive-${Date.now()}.json`);
    fs.copyFileSync(DB_PATH, archive);
    console.log(`\n💾 Old data archived to: ${path.basename(archive)}`);
}

fs.writeFileSync(DB_PATH, JSON.stringify(fresh, null, 2), 'utf8');
console.log('✅ vouchers.json reset. All old stock, sales records and activations are cleared.');
console.log('Next: import your new batches with import-csv.js, then start server.js.');
