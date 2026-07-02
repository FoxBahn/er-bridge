// ===================================================
// ER-BRIDGE v2 — WhatsApp Alert Bridge with Self-Monitoring
// Architecture notes:
// - NO internal timers/cron. All "clock" behaviour piggybacks on
//   Google Uptime Monitor's 60-second pings to /health.
// - Health check now reflects WHATSAPP state, not just Node state.
//   Session drops => /health returns 503 => Uptime check fails => you get emailed.
// - Control panel routes are protected by SECRET_KEY.
// Dependencies: npm install whatsapp-web.js qrcode-terminal qrcode
// ===================================================

const http = require('http');
const { exec } = require('child_process');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');

// ===================================================
// CONFIG — CHANGE THE SECRET KEY BEFORE DEPLOYING
// ===================================================
const SECRET_KEY = 'CHANGE-THIS-TO-A-LONG-RANDOM-STRING';
const TARGET_GROUP = '120363408545190910@g.us';
const MY_PERSONAL_NUMBER = '27731511664@c.us';
const PORT = 8080;

// ===================================================
// STATE & IN-MEMORY LOG BUFFER (last 150 lines)
// ===================================================
let clientReady = false;
let latestQR = null;             // holds QR string whenever a rescan is needed
const stats = {
    startedAt: new Date(),
    forwarded: 0,
    failures: 0,
    lastAlertAt: null
};
let lastDigestDate = new Date().toDateString();

const logBuffer = [];
function log(line) {
    const entry = `[${new Date().toISOString()}] ${line}`;
    console.log(entry);
    logBuffer.push(entry);
    if (logBuffer.length > 150) logBuffer.shift();
}

// ===================================================
// WHATSAPP CLIENT (lean Puppeteer config for 1GB RAM)
// ===================================================
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--no-zygote'
        ]
    }
});

client.on('qr', (qr) => {
    latestQR = qr;
    clientReady = false;
    log('⚠️ Session needs authentication. QR available at /qr endpoint (also printed below).');
    qrcodeTerminal.generate(qr, { small: true });
});

client.on('ready', () => {
    clientReady = true;
    latestQR = null;
    log('🛡️ Alert Bridge operational and listening for EarthRanger traffic.');
});

client.on('disconnected', (reason) => {
    clientReady = false;
    log(`🔌 WhatsApp DISCONNECTED: ${reason}. Health check will now fail => expect an email alert.`);
});

client.on('auth_failure', (msg) => {
    clientReady = false;
    log(`🚨 AUTH FAILURE: ${msg}`);
});

// ===================================================
// CENTRAL ROUTING PROCESSOR
// ===================================================
client.on('message', async (msg) => {
    // Ignore group echo and status broadcasts
    if (msg.from === TARGET_GROUP) return;
    if (msg.from === 'status@broadcast') return;
    // Ignore media-only / empty-body messages
    if (!msg.body) return;

    log(`📥 Packet received from: ${msg.from}`);
    try {
        await client.sendMessage(TARGET_GROUP, msg.body);
        stats.forwarded++;
        stats.lastAlertAt = new Date();
        log('✅ Group delivery completed successfully.');
    } catch (err) {
        stats.failures++;
        log(`❌ FAILURE delivering to group: ${err.message}`);
        try {
            await client.sendMessage(MY_PERSONAL_NUMBER,
                `🚨 ER-BRIDGE ERROR: Alert failed to deliver to group.\nContent: ${msg.body}`);
        } catch (backupErr) {
            log(`🚨 Double failure — backup route offline: ${backupErr.message}`);
        }
    }
});

// ===================================================
// DAILY DIGEST — clocked by Google's pings, no internal timers.
// On each /health ping, if the calendar date has rolled over,
// send yesterday's summary to your personal number.
// ===================================================
async function maybeSendDailyDigest() {
    const today = new Date().toDateString();
    if (today === lastDigestDate || !clientReady) return;
    lastDigestDate = today;
    try {
        const uptimeHrs = ((Date.now() - stats.startedAt.getTime()) / 3600000).toFixed(1);
        await client.sendMessage(MY_PERSONAL_NUMBER,
            `📊 ER-BRIDGE daily check-in\n` +
            `Status: ONLINE ✅\n` +
            `Alerts forwarded (since last restart): ${stats.forwarded}\n` +
            `Delivery failures: ${stats.failures}\n` +
            `Last alert: ${stats.lastAlertAt ? stats.lastAlertAt.toISOString() : 'none yet'}\n` +
            `Process uptime: ${uptimeHrs}h`);
        log('📊 Daily digest sent.');
    } catch (e) {
        log(`Digest send failed: ${e.message}`);
    }
}

// ===================================================
// HTTP GATEWAY + CONTROL PANEL
// Routes:
//   /health            (public)  200 if WhatsApp connected, 503 if not — point Uptime Monitor here
//   /status?key=SECRET           JSON stats
//   /logs?key=SECRET             last 150 log lines as plain text
//   /qr?key=SECRET               scannable QR image in browser when session drops
//   /restart?key=SECRET          clean restart (PM2 auto-resurrects)
//   /deploy?key=SECRET           git pull latest code, then restart
// ===================================================
http.createServer(async (req, res) => {
    const u = new URL(req.url, `http://localhost:${PORT}`);
    const authed = u.searchParams.get('key') === SECRET_KEY;

    // --- Public health check (Google Uptime Monitor target) ---
    if (u.pathname === '/health' || u.pathname === '/') {
        maybeSendDailyDigest(); // piggyback the daily clock on Google's pings
        if (clientReady) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ALIVE', whatsapp: 'CONNECTED', engine: 'GCP-ALERT-BRIDGE' }));
        } else {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'DEGRADED', whatsapp: 'DISCONNECTED' }));
        }
        return;
    }

    // --- Everything below requires the secret key ---
    if (!authed) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden');
        return;
    }

    if (u.pathname === '/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            whatsappConnected: clientReady,
            qrPending: !!latestQR,
            ...stats,
            memoryMB: Math.round(process.memoryUsage().rss / 1048576)
        }, null, 2));
        return;
    }

    if (u.pathname === '/logs') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(logBuffer.join('\n') || 'No logs yet.');
        return;
    }

    if (u.pathname === '/qr') {
        if (!latestQR) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('<h2>✅ Session active — no QR scan needed.</h2>');
            return;
        }
        try {
            const dataUrl = await QRCode.toDataURL(latestQR, { width: 400 });
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(`<html><body style="text-align:center;font-family:sans-serif">
                <h2>⚠️ Scan with WhatsApp (Linked Devices)</h2>
                <img src="${dataUrl}" />
                <p>Refresh this page if the code expires.</p>
                </body></html>`);
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('QR render failed: ' + e.message);
        }
        return;
    }

    if (u.pathname === '/restart') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('♻️ Restarting via PM2...');
        log('♻️ Manual restart triggered via control panel.');
        setTimeout(() => process.exit(0), 500); // PM2 auto-restarts the process
        return;
    }

    if (u.pathname === '/deploy') {
        log('🚀 Deploy triggered: pulling latest code from GitHub...');
        exec('git pull', { cwd: __dirname }, (err, stdout, stderr) => {
            const output = (stdout || '') + (stderr || '');
            res.writeHead(err ? 500 : 200, { 'Content-Type': 'text/plain' });
            res.end(`${err ? '❌ Pull failed' : '✅ Pulled'}\n\n${output}\n\nRestarting in 1s...`);
            log(`Deploy output: ${output.trim()}`);
            if (!err) setTimeout(() => process.exit(0), 1000);
        });
        return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
}).listen(PORT, () => {
    log(`💚 Gateway + control panel live on port ${PORT}`);
});

// Fire up the pipeline
client.initialize();
