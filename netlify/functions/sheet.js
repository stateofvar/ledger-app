const { google } = require('googleapis');

const SHEET_ID = process.env.SHEET_ID;

function getAuth() {
  // The service account key JSON is stored as a single env var (its full contents).
  const credsRaw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!credsRaw) {
    throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_KEY env var');
  }
  const creds = JSON.parse(credsRaw);
  return new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

async function getSheetsClient() {
  const auth = getAuth();
  const client = await auth.getClient();
  return google.sheets({ version: 'v4', auth: client });
}

function monthKeyFromDate(dateStr) {
  // dateStr like "2026-08-27" -> "2026-08"
  return dateStr.slice(0, 7);
}

function parseMoney(val) {
  if (val === undefined || val === null || val === '') return 0;
  if (typeof val === 'number') return val;
  // Strip thousands separators, currency symbols, and stray whitespace
  // so values like "27,923.38" or "$1,000" parse correctly instead of
  // silently truncating at the first non-numeric character.
  const cleaned = String(val).replace(/[^0-9.\-]/g, '');
  if (cleaned === '') return 0;
  const n = parseFloat(cleaned);
  return isNaN(n) ? 0 : n;
}

async function getSettingsRows(sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: 'Settings!A2:B1000',
  });
  return res.data.values || [];
}

// Columns: A Date | B Spent | C Deposited | D Note | E Balance
async function getTransactionRows(sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: 'Transactions!A2:E10000',
  });
  return res.data.values || [];
}

async function setSettingsStartingBalance(sheets, monthKey, startingBalance) {
  const rows = await getSettingsRows(sheets);
  const idx = rows.findIndex((r) => r[0] === monthKey);
  if (idx >= 0) {
    const rowNumber = idx + 2; // account for header row
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `Settings!A${rowNumber}:B${rowNumber}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[monthKey, startingBalance]] },
    });
  } else {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'Settings!A:B',
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [[monthKey, startingBalance]] },
    });
  }
}

async function getStartingBalanceForMonth(sheets, monthKey) {
  const rows = await getSettingsRows(sheets);
  const row = rows.find((r) => r[0] === monthKey);
  return row ? parseMoney(row[1]) : null;
}

// Recompute running balances for a whole month's transactions in the sheet,
// and return the ending balance for that month.
async function recomputeMonth(sheets, monthKey) {
  const allRows = await getTransactionRows(sheets); // [date, spent, deposited, note, balance]
  const startingBalance = await getStartingBalanceForMonth(sheets, monthKey);
  if (startingBalance === null) {
    throw new Error(`No starting balance set for month ${monthKey}`);
  }

  let running = startingBalance;
  const updates = [];
  allRows.forEach((row, i) => {
    const date = row[0];
    if (!date || monthKeyFromDate(date) !== monthKey) return;
    const spent = parseMoney(row[1]);
    const deposited = parseMoney(row[2]);
    running = running - spent + deposited;
    const rowNumber = i + 2;
    updates.push({
      range: `Transactions!E${rowNumber}`,
      values: [[running]],
    });
  });

  if (updates.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: {
        valueInputOption: 'RAW',
        data: updates,
      },
    });
  }

  return running; // ending balance for the month
}

async function ensureMonthInitialized(sheets, monthKey) {
  const existing = await getStartingBalanceForMonth(sheets, monthKey);
  if (existing !== null) return existing;

  // Find the previous month that has a starting balance and transactions,
  // carry its ending balance forward.
  const rows = await getSettingsRows(sheets);
  const monthKeys = rows.map((r) => r[0]).filter(Boolean).sort();
  const priorMonths = monthKeys.filter((m) => m < monthKey);
  if (priorMonths.length === 0) {
    // No prior month at all — nothing to carry forward from.
    return null;
  }
  const priorMonth = priorMonths[priorMonths.length - 1];
  const endingBalance = await recomputeMonth(sheets, priorMonth);
  await setSettingsStartingBalance(sheets, monthKey, endingBalance);
  return endingBalance;
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    const sheets = await getSheetsClient();
    const params = event.queryStringParameters || {};
    const action = params.action;

    // ---- GET current month data (initializes month if needed) ----
    if (event.httpMethod === 'GET' && action === 'month') {
      const monthKey = params.month; // e.g. "2026-08"
      await ensureMonthInitialized(sheets, monthKey);
      const startingBalance = await getStartingBalanceForMonth(sheets, monthKey);
      const allRows = await getTransactionRows(sheets);
      const transactions = [];
      allRows.forEach((row, i) => {
        const date = row[0];
        if (!date || monthKeyFromDate(date) !== monthKey) return;
        const spent = parseMoney(row[1]);
        const deposited = parseMoney(row[2]);
        transactions.push({
          rowNumber: i + 2,
          date,
          type: deposited > 0 ? 'deposit' : 'expense',
          amount: deposited > 0 ? deposited : spent,
          note: row[3] || '',
          balance: row[4] !== undefined && row[4] !== '' ? parseMoney(row[4]) : null,
        });
      });
      const currentBalance =
        transactions.length > 0
          ? transactions[transactions.length - 1].balance
          : startingBalance;

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          monthKey,
          startingBalance,
          currentBalance,
          transactions,
        }),
      };
    }

    // ---- POST add a transaction ----
    if (event.httpMethod === 'POST' && action === 'transaction') {
      const body = JSON.parse(event.body);
      const { date, amount, note, type } = body; // type: 'expense' | 'deposit'
      const monthKey = monthKeyFromDate(date);
      await ensureMonthInitialized(sheets, monthKey);

      const spent = type === 'deposit' ? '' : amount;
      const deposited = type === 'deposit' ? amount : '';

      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: 'Transactions!A:E',
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [[date, spent, deposited, note || '', '']] },
      });

      const endingBalance = await recomputeMonth(sheets, monthKey);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true, endingBalance }),
      };
    }

    // ---- PUT edit a transaction ----
    if (event.httpMethod === 'PUT' && action === 'transaction') {
      const body = JSON.parse(event.body);
      const { rowNumber, date, amount, note, type } = body;
      const spent = type === 'deposit' ? '' : amount;
      const deposited = type === 'deposit' ? amount : '';

      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `Transactions!A${rowNumber}:D${rowNumber}`,
        valueInputOption: 'RAW',
        requestBody: { values: [[date, spent, deposited, note || '']] },
      });
      const monthKey = monthKeyFromDate(date);
      const endingBalance = await recomputeMonth(sheets, monthKey);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true, endingBalance }),
      };
    }

    // ---- DELETE a transaction ----
    if (event.httpMethod === 'DELETE' && action === 'transaction') {
      const rowNumber = parseInt(params.rowNumber, 10);
      const monthKey = params.month;

      // Clear the row's values (leaves a blank row rather than shifting everything,
      // which keeps other rowNumbers stable).
      await sheets.spreadsheets.values.clear({
        spreadsheetId: SHEET_ID,
        range: `Transactions!A${rowNumber}:E${rowNumber}`,
      });

      const endingBalance = await recomputeMonth(sheets, monthKey);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true, endingBalance }),
      };
    }

    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Unknown action or method' }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
