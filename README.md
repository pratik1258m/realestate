# 🏠 Real Estate News Intelligence & Distribution Platform

A fully automated platform that scrapes, categorises, summarises and distributes Indian real estate news daily — powered by Groq AI and hosted on Netlify.

---

## 📋 Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Local Development Setup](#local-development-setup)
- [Environment Variables](#environment-variables)
- [Netlify Deployment](#netlify-deployment)
- [How the Pipeline Works](#how-the-pipeline-works)
- [News Categories](#news-categories)
- [API Reference](#api-reference)
- [Admin Panel Guide](#admin-panel-guide)
- [Adding New RSS Feeds](#adding-new-rss-feeds)
- [Troubleshooting](#troubleshooting)

---

## Overview

This platform automatically:
1. **Scrapes** 500+ raw articles daily from 32 RSS feeds (national + city + Hindi)
2. **Deduplicates** using Jaccard similarity (removes near-duplicate headlines)
3. **Scores** relevance using keyword heuristics across 8 categories
4. **Shortlists** top 50 diversified articles (capped per category to prevent bias)
5. **Processes** via Groq AI — rewrites headlines, generates 100–150 word summaries, assigns priority scores
6. **Distributes** via Email (Resend API) and WhatsApp at 8:00 AM IST daily
7. **Exports** branded PDF reports (Daily / Weekly / Monthly / City / Builder)

---

## Features

| Feature | Status |
|---|---|
| 32 RSS feed sources (English + Hindi) | ✅ |
| Jaccard deduplication | ✅ |
| 8 news categories with balanced sampling | ✅ |
| Groq AI — headline + summary + priority | ✅ |
| Dual Groq key failover & rotation | ✅ |
| Daily 8 AM IST cron via Netlify | ✅ |
| Email broadcast (Resend API) | ✅ |
| WhatsApp broadcast (Business API) | ✅ |
| PDF report generation (jsPDF) | ✅ |
| Admin Panel — recipients management | ✅ |
| CSV import for contacts | ✅ |
| Manual "Run Scraper" button on Feed | ✅ |
| Search & filter by city / category | ✅ |
| Bookmark / saved articles | ✅ |

---

## Tech Stack

| Layer | Technology |
|---|---|
| **Frontend** | HTML, Vanilla CSS, Vanilla JS |
| **Backend** | Netlify Serverless Functions (Node.js) |
| **AI Engine** | [Groq API](https://console.groq.com) — `llama-3.1-8b-instant` |
| **RSS Parsing** | `rss-parser` npm package |
| **Email** | [Resend API](https://resend.com) |
| **WhatsApp** | Meta WhatsApp Business Cloud API |
| **PDF** | jsPDF + jsPDF AutoTable (CDN) |
| **Hosting** | [Netlify](https://netlify.com) |
| **Database** | Netlify Blobs (key-value, serverless) |

---

## Project Structure

```
realestate/
│
├── index.html                        # Main SPA — Feed, Saved, Admin Panel views
├── app.js                            # All frontend logic (12 modules)
├── style.css                         # Full design system + component styles
├── netlify.toml                      # Netlify build config + cron schedule
├── package.json                      # Node dependencies
├── campaigns.json                    # Local campaigns seed data
│
└── netlify/
    └── functions/
        ├── scrape-and-process.js     # ⭐ Core AI pipeline (scrape → dedup → score → AI)
        ├── daily-cron.js             # Scheduled cron: runs pipeline + dispatches email/WA
        ├── broadcast.js              # Email + WhatsApp broadcast helper
        ├── db-helper.js              # Netlify Blobs read/write wrapper
        ├── recipients.js             # Recipients CRUD API
        └── track.js                  # Email open/click tracking webhook
```

---

## Local Development Setup

### Prerequisites
- Node.js 18+
- Netlify CLI

### Steps

```bash
# 1. Clone the repo
git clone https://github.com/pratik1258m/realestate.git
cd realestate

# 2. Install dependencies
npm install

# 3. Install Netlify CLI globally (if not already)
npm install -g netlify-cli

# 4. Create your local environment file
cp .env.example .env
# Fill in your API keys (see Environment Variables section)

# 5. Start local dev server (with serverless functions)
netlify dev
```

Open `http://localhost:8888` in your browser.

> ⚠️ **Important:** The scraper backend only runs on port `8888` (Netlify Dev) or a deployed Netlify domain. Opening `index.html` directly in a browser or using Live Server (port 5500) will run in static-only mode with no live scraping.

---

## Environment Variables

Set these in **Netlify Dashboard → Site Settings → Environment Variables** for production.

For local dev, add them to your `.env` file (never commit this file).

| Variable | Required | Description |
|---|---|---|
| `GROQ_API_KEY_1` | ✅ Yes | Primary Groq API key. Get one free at [console.groq.com](https://console.groq.com) |
| `GROQ_API_KEY_2` | Optional | Backup Groq key for auto-failover when Key 1 hits rate limits |
| `RESEND_API_KEY` | Optional | [Resend](https://resend.com) key for email broadcasts |
| `WHATSAPP_TOKEN` | Optional | Meta WhatsApp Business Cloud API token |
| `WHATSAPP_PHONE_NUMBER_ID` | Optional | Meta WhatsApp sender phone ID |
| `REPORT_EMAIL` | Optional | Fallback email for daily report if no recipients in DB |
| `REPORT_WHATSAPP` | Optional | Fallback WhatsApp number for daily report |

### `.env` file format
```env
GROQ_API_KEY_1=gsk_xxxxxxxxxxxxxxxxxxxxxxxxxxxx
GROQ_API_KEY_2=gsk_yyyyyyyyyyyyyyyyyyyyyyyyyyyy
RESEND_API_KEY=re_xxxxxxxxxxxxxxxxxxxxxxxxxxxx
WHATSAPP_TOKEN=EAAxxxxxxxxxxxxxxxxxx
WHATSAPP_PHONE_NUMBER_ID=1234567890
REPORT_EMAIL=news@yourdomain.com
REPORT_WHATSAPP=+919876543210
```

---

## Netlify Deployment

### Option A — Netlify Drop (Quickest)
1. Run `npm run build` (or manually zip the project excluding `node_modules/`, `.env`, `deploy/`)
2. Drag and drop the ZIP at [app.netlify.com/drop](https://app.netlify.com/drop)
3. Set Environment Variables in the site dashboard

### Option B — GitHub Auto-Deploy (Recommended)
1. Push to `main` branch on GitHub
2. In Netlify Dashboard → **Add new site → Import from Git**
3. Select `pratik1258m/realestate`
4. Build settings:
   - **Build command:** *(leave blank — static site)*
   - **Publish directory:** `.`
   - **Functions directory:** `netlify/functions`
5. Set all Environment Variables
6. Deploy

### Cron Schedule
The daily pipeline runs automatically via Netlify Scheduled Functions:
```toml
# netlify.toml
[functions."daily-cron"]
  schedule = "30 2 * * *"   # 2:30 AM UTC = 8:00 AM IST
```

---

## How the Pipeline Works

```
32 RSS Feeds (parallel fetch, 6s timeout)
        ↓
500+ Raw Articles
        ↓
7-day date filter
        ↓
Jaccard Deduplication (0.3 threshold)
        ↓
Relevance Scoring (keyword heuristics)
        ↓
Category-Diversified Candidate Selection
  • Max 8 per positive category (Launch, Funding, Infrastructure, Policy, Redevelopment)
  • Max 3 per dispute category (RERA, Litigation)
  • Hard cap: 50 candidates total
        ↓
Groq AI Batch Processing (batches of 6, with key rotation)
  • Rewrites headline (max 15 words)
  • Generates 100–150 word summary
  • Assigns priority score (1–10)
  • Extracts: builder, city, state, category
        ↓
Top 50 Articles (sorted by priority score)
        ↓
Stored in frontend localStorage + Netlify Blobs
        ↓
Daily Dispatch: Email (Resend) + WhatsApp at 8AM IST
```

---

## News Categories

| Category | Description |
|---|---|
| **Project Launch** | New residential/commercial project announcements |
| **Land Acquisition** | Builder/developer land purchase deals |
| **Redevelopment** | Slum, cluster, or SRA redevelopment projects |
| **RERA** | Regulatory orders, penalties, registrations |
| **Funding** | PE investments, IPO, QIP, REIT, FDI |
| **Government Policy** | Stamp duty, circle rates, PMAY, housing policy |
| **Infrastructure** | Metro rail, highways, airport city, expressways |
| **Litigation** | NCLT, court orders, homebuyer disputes, builder fraud |

---

## API Reference

All APIs are Netlify Serverless Functions accessible via `/api/*` (proxied via `netlify.toml`).

### `POST /api/scrape-and-process`
Triggers the full scraping + AI pipeline manually.

**Response:**
```json
{
  "success": true,
  "count": 42,
  "articles": [...],
  "totalRawScraped": 587,
  "totalUniqueDeduplicated": 312,
  "keysStatus": {
    "totalKeys": 2,
    "activeKeyIndex": 0,
    "failovers": []
  }
}
```

### `GET /api/recipients`
Returns all recipient groups and contacts.

### `POST /api/recipients`
Create/update recipient groups.

---

## Admin Panel Guide

Navigate to **Admin Panel** in the top nav bar.

### AI Engine Settings
- Hidden by default (collapsible card)
- Enter a Groq API key if running in client-side mode (not needed on Netlify)

### News Scraping & AI Pipeline
- **Run AI Scraper Now** — manually triggers the full pipeline
- **Live Activity Logs** — shows real-time console output
- Shows Primary / Backup AI Engine status

### Recipients Database
- **New Group** — create a named subscriber group (e.g. "Mumbai Investors")
- **Add Contact** — manually add email + WhatsApp per group
- **Import CSV** — bulk import with headers: `name, email, whatsapp`
- **Download CSV Template** — sample file to fill and re-upload

### Report Export Center
Choose scope → Download PDF:
- **Daily** — today's top articles
- **Weekly** — last 7 days
- **Monthly** — last 30 days
- **City-Wise** — filter by city name
- **Builder-Wise** — filter by builder/developer name

---

## Adding New RSS Feeds

Edit [`netlify/functions/scrape-and-process.js`](./netlify/functions/scrape-and-process.js) and add to the `feeds` array:

```js
{
  name: 'My New Feed',
  url: 'https://example.com/rss.xml'
}
```

**For Google News RSS queries:**
```js
{
  name: 'Google News - EN: Your Topic',
  url: 'https://news.google.com/rss/search?q=%22your+search+query%22&hl=en-IN&gl=IN&ceid=IN:en'
}
```

> The pipeline automatically appends `+when:3d` to Google News URLs to restrict results to the last 3 days.

After adding feeds, redeploy to Netlify.

---

## Troubleshooting

### Scraper returns HTTP 504
- The Netlify function exceeded its 26-second timeout
- Reduce number of feeds or lower `BUCKET_LIMIT` in `scrape-and-process.js`
- Check Netlify function logs: Dashboard → Functions → `scrape-and-process`

### "No Groq API keys configured"
- Set `GROQ_API_KEY_1` in Netlify Dashboard → Environment Variables
- Trigger a new deploy after adding the variable (env vars require redeploy)

### All news is dispute/RERA related
- Check `detectTopicBucket()` — RERA and Litigation are intentionally checked last
- `DISPUTE_BUCKET_LIMIT` is set to 3 (max 3 RERA + 3 Litigation out of 50)
- If still biased, check which Google News queries are returning the most articles

### CSV import not working
- Ensure CSV headers are exactly: `name,email,whatsapp` (lowercase)
- At minimum, `name` and one of `email` or `whatsapp` must be present
- File must be `.csv` format (not `.xlsx`)

### Email not sending
- Verify `RESEND_API_KEY` is set in Netlify env vars
- Free Resend plan is limited to 100 emails/day — upgrade for 5,000 recipients
- Check Netlify function logs for the `daily-cron` function

---

## Contributing

1. Fork the repo
2. Create a feature branch: `git checkout -b feature/your-feature`
3. Commit your changes: `git commit -m 'feat: add your feature'`
4. Push to the branch: `git push origin feature/your-feature`
5. Open a Pull Request

---

## License

Private project — all rights reserved.

---

*Built with ❤️ for the Indian real estate intelligence ecosystem.*
