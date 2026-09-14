# Ledger — personal bookkeeping app

A simple month-by-month expense ledger backed by a Google Sheet.
- Enter an expense (date, amount, note) and your balance updates instantly.
- At the start of a new month, your ending balance automatically becomes
  the new month's starting balance.
- All data lives in your Google Sheet — edit it there anytime.

## Deploying to Netlify

1. Push this folder to a GitHub repo (or drag-and-drop the folder into
   Netlify's "Deploys" page for a manual deploy).
2. In Netlify: **Add new site → Import an existing project**, pick this repo.
   - Build command: (leave blank)
   - Publish directory: `public`
   - Functions directory: `netlify/functions` (should be auto-detected from `netlify.toml`)
3. Once created, go to **Site configuration → Environment variables** and add:
   - `SHEET_ID` — your Google Sheet's ID (the long string in its URL between `/d/` and `/edit`)
   - `GOOGLE_SERVICE_ACCOUNT_KEY` — paste the **entire contents** of your
     downloaded service account JSON key file, as one single-line value.
4. Trigger a deploy (or it will deploy automatically after saving env vars).
5. Visit your site's URL. On your phone, open it in the browser and use
   "Add to Home Screen" so it behaves like an app icon.

## Google Sheet setup (if not already done)

Your Sheet needs two tabs:

**Transactions**
| Date | Amount | Note | Balance |
|------|--------|------|---------|

**Settings**
| Month   | Starting Balance |
|---------|-------------------|
| 2026-08 | 1000              |

Share the Sheet with your service account's email (found in the JSON key
file as `client_email`) with **Editor** access.

## Notes

- Dates are stored as `YYYY-MM-DD`. The "Month" in Settings uses `YYYY-MM`.
- Deleting a transaction clears its row rather than removing it, so row
  references stay stable — you'll just see a small gap in the raw sheet,
  which is harmless.
- If a month has no Settings row yet, the app automatically creates one by
  carrying forward the previous month's ending balance the first time you
  open the app in that month.
