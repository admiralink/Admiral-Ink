// daily-report.js - vouchers used and money earned each day, 00:00 to 23:59 (Ghana time)
//   node daily-report.js                          today
//   node daily-report.js 2026-10-15               a specific day
//   node daily-report.js 2026-10-10 2026-10-16    every day from one date to another, plus a total
//   node daily-report.js all                      every day on record
// Safe to run while server.js is running (read-only).
//
// Online money  = what customers paid on Paystack, counted on the day of purchase.
// Manual money  = printed/stock codes counted at the store price (MANUAL_PRICE below) on the day they were used.

const fs = require('fs');
const path = require('path');
console.log('🕒 Checked at ' + new Date().toISOString().replace('T', ' ').slice(0, 19) + ' (Ghana time)');

const DB_PATH = path.join(__dirname, 'vouchers.json');
const HOUR = 60 * 60 * 1000;
// Online prices: must match PLANS in server.js (in pesewas, they include the Paystack charge)
const PLANS = {
    '22 Hours Access': { price: 210, durationMs: 22 * HOUR },
    '7-Days Access': { price: 1250, durationMs: 7 * 24 * HOUR },
    '30 Days Access': { price: 4800, durationMs: 30 * 24 * HOUR }
};

// Store prices for printed/manual vouchers (in pesewas): 22h = 2.00, 7-day = 12.00, 30-day = 48.00
const MANUAL_PRICE = { '22 Hours Access': 200, '7-Days Access': 1200, '30 Days Access': 4800 };

const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
const days = {};
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10); // Ghana time = UTC
const get = (d) => days[d] || (days[d] = { online: 0, manual: 0, onlineP: 0, manualP: 0 });

// Online sales: money counted on the purchase day
const soldOnline = new Set();
(db.sales_history || []).forEach(s => {
    const codes = [].concat(s.vouchers || []);
    codes.forEach(v => soldOnline.add(String(v).trim()));
    const plan = PLANS[s.plan];
    if (plan && s.date) get(String(s.date).slice(0, 10)).onlineP += plan.price * codes.length;
});

// Used vouchers: counted on the day of first use (expiry time minus plan length)
Object.entries(db.redeemed || {}).forEach(([code, rec]) => {
    const plan = PLANS[rec.plan];
    if (!plan || !rec.expiresAt) return;
    const x = get(dayOf(rec.expiresAt - plan.durationMs));
    if (soldOnline.has(String(code).trim())) x.online++;
    else { x.manual++; x.manualP += MANUAL_PRICE[rec.plan]; }
});

const ghs = (p) => (p / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmt = (d, x) => `${d} - ${x.online + x.manual} used vouchers (${x.online} online, ${x.manual} manual) | GHS ${ghs(x.onlineP + x.manualP)} (online ${ghs(x.onlineP)}, manual ${ghs(x.manualP)})`;
const empty = () => ({ online: 0, manual: 0, onlineP: 0, manualP: 0 });
const isDate = (x) => /^\d{4}-\d{2}-\d{2}$/.test(x || '');
const arg = process.argv[2], arg2 = process.argv[3];
const today = dayOf(Date.now());

if (arg === 'all') {
    const list = Object.keys(days).sort();
    if (!list.length) console.log('No vouchers have been used yet.');
    list.forEach(d => console.log(fmt(d, days[d])));
} else if (isDate(arg) && isDate(arg2)) {
    const [from, to] = arg <= arg2 ? [arg, arg2] : [arg2, arg];
    const total = empty();
    for (let t = Date.parse(from); t <= Date.parse(to); t += 24 * HOUR) {
        const d = dayOf(t), x = days[d] || empty();
        console.log(fmt(d, x));
        Object.keys(total).forEach(k => total[k] += x[k]);
    }
    console.log('-'.repeat(60));
    console.log(fmt(`${from} to ${to}`, total));
} else {
    const d = isDate(arg) ? arg : today;
    console.log(fmt(d, days[d] || empty()));
}
console.log('');
