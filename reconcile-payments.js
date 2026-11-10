// reconcile-payments.js - finds Paystack payments that never produced a voucher code
//   node reconcile-payments.js                 list paid but unfilled payments from the last 3 days
//   node reconcile-payments.js --days 7        look further back
//   node reconcile-payments.js --issue REFERENCE --plan 22h --qty 1 [--pin 1234]
//                                              give the customer their code(s) for that payment
// Safe to run while server.js is running (it asks the running server to issue the code).
// The server must be running for --issue.

const fs = require('fs');
const path = require('path');
console.log('🕒 Checked at ' + new Date().toISOString().replace('T', ' ').slice(0, 19) + ' (Ghana time)');
require('dotenv').config();
const axios = require('axios');

const KEY = process.env.PAYSTACK_SECRET_KEY;
if (!KEY) { console.log('❌ PAYSTACK_SECRET_KEY not found in .env'); process.exit(1); }

// Same prices as PLANS in server.js (pesewas)
const PLANS = {
    '22h': { name: '22 Hours Access', price: 210 },
    '7d': { name: '7-Days Access', price: 1250 },
    '30d': { name: '30 Days Access', price: 4800 }
};
const arg = (n) => { const i = process.argv.indexOf(n); return i === -1 ? null : process.argv[i + 1]; };
const ghs = (p) => (p / 100).toFixed(2);

/** Which plan/quantity combinations add up to this amount */
function guesses(amount) {
    const out = [];
    Object.entries(PLANS).forEach(([k, p]) => {
        for (let q = 1; q <= 10; q++) if (p.price * q === amount) out.push(`${k} x${q}`);
    });
    return out;
}

async function main() {
    const issueRef = arg('--issue');

    if (issueRef) {
        const plan = PLANS[String(arg('--plan') || '').toLowerCase()];
        const qty = parseInt(arg('--qty') || '1', 10);
        const pin = String(arg('--pin') || '0000');
        if (!plan || !qty) { console.log('❌ Use: --plan 22h|7d|30d --qty N'); process.exit(1); }
        const port = Number(process.env.PORT) || 3000;
        try {
            const r = await axios.post(`http://127.0.0.1:${port}/verify`,
                { reference: issueRef, plan: plan.name, quantity: qty, pin }, { timeout: 20000 });
            if (r.data.success) {
                console.log(`✅ Code(s) for ${issueRef}: ${[].concat(r.data.vouchers).join(', ')}`);
                console.log(`   PIN set to ${pin}. Give the code(s) to the customer directly.`);
            } else console.log('❌ Server said:', r.data.error);
        } catch (e) {
            console.log('❌ Failed:', e.response?.data?.error || e.message, '(is server.js running?)');
        }
        return;
    }

    const days = parseInt(arg('--days') || '3', 10);
    const from = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
    const db = JSON.parse(fs.readFileSync(path.join(__dirname, 'vouchers.json'), 'utf8'));
    const known = new Set((db.sales_history || []).map(s => s.reference));

    let all = [];
    for (let page = 1; page <= 10; page++) {
        const r = await axios.get('https://api.paystack.co/transaction', {
            headers: { Authorization: `Bearer ${KEY}` },
            params: { status: 'success', perPage: 100, page, from }, timeout: 20000
        });
        all = all.concat(r.data.data || []);
        if ((r.data.data || []).length < 100) break;
    }

    const ghsPaid = all.filter(t => t.currency === 'GHS');
    const missing = ghsPaid.filter(t => !known.has(t.reference));
    console.log(`Successful payments in the last ${days} day(s): ${ghsPaid.length}   |   with a code: ${ghsPaid.length - missing.length}   |   WITHOUT a code: ${missing.length}\n`);

    if (!missing.length) { console.log('✅ Every payment has a code. Nothing to fix.\n'); return; }

    missing.forEach(t => {
        const phone = (t.metadata?.custom_fields || []).find(f => f.variable_name === 'mobile_number')?.value
            || t.authorization?.mobile_money_number || t.customer?.phone || 'unknown';
        const g = guesses(t.amount);
        console.log(`${String(t.paid_at || t.created_at).replace('T', ' ').slice(0, 19)}  GHS ${ghs(t.amount)}  phone ${phone}`);
        console.log(`   reference: ${t.reference}`);
        console.log(`   could be : ${g.length ? g.join(' or ') : 'no matching plan price (check by hand)'}`);
        if (g.length) {
            const [pl, q] = g[0].split(' x');
            console.log(`   issue    : node reconcile-payments.js --issue ${t.reference} --plan ${pl} --qty ${q}`);
        }
        console.log('');
    });
    console.log('Contact the customer first to confirm what they bought, then run the issue line.\n');
}

main().catch(e => console.log('❌ Failed:', e.response?.data?.message || e.message));
