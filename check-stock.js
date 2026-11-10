const fs = require('fs');
const path = require('path');
console.log('🕒 Checked at ' + new Date().toISOString().replace('T', ' ').slice(0, 19) + ' (Ghana time)');

const JSON_DB = path.join(__dirname, 'vouchers.json');
const PLANS = ['22 Hours Access', '7-Days Access', '30 Days Access'];

function checkStock() {
    if (!fs.existsSync(JSON_DB)) {
        console.error("❌ Error: 'vouchers.json' not found.");
        return;
    }

    try {
        const db = JSON.parse(fs.readFileSync(JSON_DB, 'utf8'));
        const count = (list) => (Array.isArray(list) ? list.length : 0);

        let onlineTotal = 0;
        let manualTotal = 0;

        console.log('\n==============================================');
        console.log('   🎟️  LIVE UNREDEEMED VOUCHER STOCK');
        console.log('==============================================');
        console.log(`${'PLAN'.padEnd(18)} ${'ONLINE SALE'.padStart(12)} ${'MANUAL'.padStart(10)}`);
        console.log('----------------------------------------------');

        PLANS.forEach(plan => {
            const online = count(db[plan]);
            const manual = count(db.manual && db.manual[plan]);
            onlineTotal += online;
            manualTotal += manual;
            console.log(`${plan.padEnd(18)} ${online.toLocaleString().padStart(12)} ${manual.toLocaleString().padStart(10)}`);
        });

        console.log('----------------------------------------------');
        console.log(`${'TOTAL'.padEnd(18)} ${onlineTotal.toLocaleString().padStart(12)} ${manualTotal.toLocaleString().padStart(10)}`);

        // Sales and redemption activity
        const sales = Array.isArray(db.sales_history) ? db.sales_history : [];
        const codesSold = sales.reduce((n, s) => n + [].concat(s.vouchers || []).length, 0);

        const redeemed = db.redeemed && typeof db.redeemed === 'object' ? Object.values(db.redeemed) : [];
        const now = Date.now();
        const active = redeemed.filter(r => r.expiresAt > now).length;
        const expired = redeemed.length - active;

        console.log('\n--- ACTIVITY ---');
        console.log(`Online purchases     : ${sales.length.toLocaleString()} (${codesSold.toLocaleString()} codes sold)`);
        console.log(`Codes activated      : ${redeemed.length.toLocaleString()} (${active.toLocaleString()} active now, ${expired.toLocaleString()} expired)`);
        console.log('==============================================\n');

    } catch (err) {
        console.error("❌ Error reading vouchers.json:", err.message);
    }
}

checkStock();
