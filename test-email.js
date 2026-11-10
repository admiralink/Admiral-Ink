// test-email.js - sends one test email using the ALERT_* settings in .env
//   node test-email.js
require('dotenv').config();
let nodemailer;
try { nodemailer = require('nodemailer'); } catch (e) { console.log('❌ Run first: npm install nodemailer'); process.exit(1); }

const { ALERT_EMAIL_TO, ALERT_SMTP_USER, ALERT_SMTP_PASS } = process.env;
if (!ALERT_EMAIL_TO || !ALERT_SMTP_USER || !ALERT_SMTP_PASS) {
    console.log('❌ Add ALERT_EMAIL_TO, ALERT_SMTP_USER and ALERT_SMTP_PASS to your .env file first.');
    process.exit(1);
}
const port = Number(process.env.ALERT_SMTP_PORT) || 465;
nodemailer.createTransport({
    host: process.env.ALERT_SMTP_HOST || 'smtp.gmail.com', port, secure: port === 465,
    auth: { user: ALERT_SMTP_USER, pass: ALERT_SMTP_PASS }
}).sendMail({
    from: `"ADM WiFi Portal" <${ALERT_SMTP_USER}>`,
    to: ALERT_EMAIL_TO,
    subject: '[ADM WiFi] Test email',
    text: 'If you can read this, email alerts are working.'
}).then(() => console.log('✅ Test email sent to', ALERT_EMAIL_TO))
  .catch(e => { console.log('❌ Failed:', e.message); process.exit(1); });
