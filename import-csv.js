// import-csv.js
// Dry run (changes nothing):   node import-csv.js
// Apply (writes vouchers.json): node import-csv.js --apply
// STOP server.js before using --apply.

const fs = require('fs');
const path = require('path');
console.log('🕒 Checked at ' + new Date().toISOString().replace('T', ' ').slice(0, 19) + ' (Ghana time)');

// Optional: pass a CSV file name, e.g.  node import-csv.js batch-22h.csv --apply
const csvArg = process.argv.find(a => a.toLowerCase().endsWith('.csv'));
const CSV_PATH = path.join(__dirname, csvArg || 'omada_export.csv');
const DB_PATH = path.join(__dirname, 'vouchers.json');
const APPLY = process.argv.includes('--apply');
// --manual puts codes in a separate list that is NEVER sold online (for pre-printed / hand-sold vouchers)
const MANUAL = process.argv.includes('--manual');

function parseCSV(text) {
    const rows = [];
    let row = [], field = '', inQ = false;
    text = text.replace(/^\uFEFF/, '');
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inQ) {
            if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
            else if (c === '"') inQ = false;
            else field += c;
        } else if (c === '"') inQ = true;
        else if (c === ',') { row.push(field); field = ''; }
        else if (c === '\n' || c === '\r') {
            if (c === '\r' && text[i + 1] === '\n') i++;
            row.push(field); field = '';
            if (row.some(f => f !== '')) rows.push(row);
            row = [];
        } else field += c;
    }
    if (field !== '' || row.length) {
        row.push(field);
        if (row.some(f => f !== '')) rows.push(row);
    }
    return rows;
}

const DURATION_RE = /^\d+(\.\d+)?\s*(hours?|days?)$/i;

function planFromDuration(text) {
    const m = String(text).trim().match(/^(\d+(?:\.\d+)?)\s*(hours?|days?)$/i);
    if (!m) return null;
    const hours = parseFloat(m[1]) * (/^day/i.test(m[2]) ? 24 : 1);
    if (hours === 22) return '22 Hours Access';
    if (hours === 168) return '7-Days Access';
    if (hours === 720) return '30 Days Access';
    return null;
}

if (!fs.existsSync(CSV_PATH)) { console.error(`❌ ${path.basename(CSV_PATH)} not found next to this script.`); process.exit(1); }

const rows = parseCSV(fs.readFileSync(CSV_PATH, 'utf8'));
const header = rows[0].map(h => h.trim().toLowerCase());
const iCode = header.indexOf('code');
const iStatus = header.findIndex(h => h.includes('status'));

console.log('CSV columns:', rows[0].join(' | '));
if (iCode === -1) { console.error('❌ No "Code" column found.'); process.exit(1); }
if (iStatus === -1) console.log('⚠️  No status column found, so ALL rows will be treated as unused. Check this before using --apply.');

const db = fs.existsSync(DB_PATH) ? JSON.parse(fs.readFileSync(DB_PATH, 'utf8')) : {};
['22 Hours Access', '7-Days Access', '30 Days Access'].forEach(p => { if (!Array.isArray(db[p])) db[p] = []; });
if (!Array.isArray(db.sales_history)) db.sales_history = [];
if (!db.redeemed) db.redeemed = {};

const known = new Set();
['22 Hours Access', '7-Days Access', '30 Days Access'].forEach(p => db[p].forEach(v => known.add(String(v).trim())));
db.sales_history.forEach(s => [].concat(s.vouchers).forEach(v => known.add(String(v).trim())));
Object.keys(db.redeemed).forEach(k => known.add(k));
if (db.manual) Object.values(db.manual).forEach(list => list.forEach(v => known.add(String(v).trim())));

const added = { '22 Hours Access': [], '7-Days Access': [], '30 Days Access': [] };
let skippedDup = 0, skippedStatus = 0, skippedUnknown = 0;
const statusValues = {};

for (const row of rows.slice(1)) {
    const code = String(row[iCode] || '').trim();
    if (!code) continue;

    if (iStatus !== -1) {
        const st = String(row[iStatus] || '').trim().toLowerCase();
        statusValues[st] = (statusValues[st] || 0) + 1;
        if (!st.includes('unused')) { skippedStatus++; continue; }
    }

    const durationText = row.find(f => DURATION_RE.test(String(f).trim()));
    const plan = durationText ? planFromDuration(durationText) : null;
    if (!plan) { skippedUnknown++; continue; }

    if (known.has(code)) { skippedDup++; continue; }
    known.add(code);
    added[plan].push(code);
}

if (iStatus !== -1) console.log('Status values seen:', statusValues);
console.log(`\nWould add to the ${MANUAL ? 'MANUAL (never sold online)' : 'ONLINE-SALE'} list:`);
Object.keys(added).forEach(p => console.log(`  ${p}: ${added[p].length}`));
console.log(`Skipped: ${skippedDup} already in database, ${skippedStatus} not unused, ${skippedUnknown} unknown duration`);

if (!APPLY) {
    console.log('\nDry run only. Nothing was changed. Run "node import-csv.js --apply" to write.');
    process.exit(0);
}

if (fs.existsSync(DB_PATH)) {
    const backup = path.join(__dirname, `vouchers-backup-${Date.now()}.json`);
    fs.copyFileSync(DB_PATH, backup);
    console.log('\n💾 Backup saved:', path.basename(backup));
}

if (MANUAL) {
    if (!db.manual) db.manual = {};
    Object.keys(added).forEach(p => { db.manual[p] = (db.manual[p] || []).concat(added[p]); });
} else {
    Object.keys(added).forEach(p => db[p].push(...added[p]));
}
fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
console.log('✅ vouchers.json updated. Run "node check-stock.js" to confirm the counts.');
