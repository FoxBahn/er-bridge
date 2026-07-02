`DEPLOY.md` is just your operations manual living in the repo — everything you'd need to recover or manage the system if you (or I, reading the repo) come back to it in six months. Here's the content, ready to paste into GitHub's editor:

````markdown
# ER-Bridge — Deployment & Operations Reference

WhatsApp Alert Bridge for EarthRanger. Forwards incoming alerts into the
emergency group chat. Runs on GCP Free Tier (e2-micro, 1GB RAM, Ubuntu),
managed by PM2, kept alive by Google Uptime Monitor pinging /health every 60s.

**Architecture rule: NO internal cron/timers.** All timing piggybacks on the
external uptime pings (RAM constraint).

## Server

- Platform: GCP e2-micro (migrating to Oracle Cloud when account approved)
- Project folder: `~/er-bridge`
- Process manager: PM2, process name `er-bridge`
- WhatsApp session stored in `~/er-bridge/.wwebjs_auth` — **never delete
  this folder** unless you intend to rescan the QR

## Control panel (browser, no SSH needed)

Replace VM-IP and SECRET with real values:

- `http://VM-IP:8080/health` — public health check (Uptime Monitor target)
- `http://VM-IP:8080/status?key=SECRET` — connection state, stats, memory
- `http://VM-IP:8080/logs?key=SECRET` — last 150 log lines
- `http://VM-IP:8080/qr?key=SECRET` — scan here when session drops
- `http://VM-IP:8080/restart?key=SECRET` — clean restart via PM2
- `http://VM-IP:8080/deploy?key=SECRET` — git pull latest code + restart

## Normal update workflow

1. Edit `index.js` in GitHub (or ask Claude to commit the change)
2. Merge to `main`
3. Open `/deploy?key=SECRET` in browser
4. Confirm `/status` shows `whatsappConnected: true`

## SSH fallback commands (browser SSH via GCP Console)

```bash
cd ~/er-bridge                 # project folder
pm2 logs er-bridge             # live logs
pm2 delete er-bridge           # full clean redeploy:
pm2 start index.js --name "er-bridge" --update-env
pm2 save
curl -v http://localhost:8080/health   # local health test
```

## Fresh VM setup / Oracle migration

```bash
git clone https://github.com/FoxBahn/er-bridge.git
cd er-bridge
npm install whatsapp-web.js qrcode-terminal qrcode
pm2 start index.js --name "er-bridge" --update-env
pm2 save
pm2 startup    # run the sudo command it prints
```
Then scan the QR at `/qr?key=SECRET`, and repoint the Uptime Monitor
to the new IP with path `/health` + email alerting policy (fail 3–5 min).

## Monitoring / trust model

- WhatsApp disconnected => `/health` returns 503 => GCP emails you
- Daily 📊 digest to personal WhatsApp each morning — silence = investigate
- Failed group delivery => fallback message to personal number

## IDs

- Target group: `120363408545190910@g.us`
- Backup personal: `27731511664@c.us`
```
````

Two notes on it:

**Don't put the actual SECRET_KEY value in this file.** It's written as `SECRET` placeholder deliberately — the real key already lives in `index.js`, which is enough. Keeping it out of the docs means a screenshot or screen-share of DEPLOY.md never leaks your control panel.

And update the `YOURUSERNAME` and (after Phase 3) note your VM's IP at the top if you like — future-you on a bad signal in Zululand will thank present-you.

Paste that in, commit, and that's Phase 1 done. Next: Settings → Connectors → GitHub, then tell me to read the repo.
