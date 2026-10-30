// GHL Lender Log
// Webhook from a GHL workflow -> read the Lenders checkbox on the contact ->
// add one timestamped line per lender to a log field -> clear the checkbox.
//
// The GHL token and location ID arrive in each webhook POST, so one deploy
// serves any number of sub-accounts. Nothing account-specific lives in Railway.

const express = require('express');

const {
  LENDERS_FIELD_NAME = 'Lenders', // checkbox field to read and clear
  LOG_FIELD_NAME = 'Lender Submission Log', // Large Text field that holds the history
  TIMEZONE = 'America/New_York',
  NEWEST_FIRST = 'true',
  ADD_NOTE = 'true', // also post each shop-out as a contact note
  WEBHOOK_SECRET = '', // optional; if set, the webhook must send it
  GHL_API_BASE = 'https://services.leadconnectorhq.com',
  PORT = 3000,
} = process.env;

async function ghl(token, method, path, body) {
  const res = await fetch(`${GHL_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Version: '2021-07-28',
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GHL ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

// Look in the workflow's custom data first, then the top level of the body.
function pick(body, keys) {
  for (const src of [body.customData, body]) {
    if (!src || typeof src !== 'object') continue;
    for (const k of keys) {
      const v = src[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
  }
  return '';
}

// Checkbox values come back as an array, but tolerate a comma string too.
function toList(value) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map((v) => v.trim()).filter(Boolean);
  return [];
}

// MM/DD/YY HH:MM in 24-hour time, e.g. "10/07/26 14:15 EDT"
function stamp(timeZone, date = new Date()) {
  const p = {};
  for (const { type, value } of new Intl.DateTimeFormat('en-US', {
    timeZone,
    month: '2-digit',
    day: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'short',
  }).formatToParts(date)) {
    p[type] = value;
  }
  return `${p.month}/${p.day}/${p.year} ${p.hour}:${p.minute} ${p.timeZoneName}`;
}

function validZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// Field IDs are different in every sub-account, so find them by name once
// per location and remember them for a while.
const fieldCache = new Map();
const FIELD_CACHE_MS = 10 * 60 * 1000;

async function findFieldIds(token, locationId, lendersName, logName) {
  const key = `${locationId}|${lendersName}|${logName}`.toLowerCase();
  const hit = fieldCache.get(key);
  if (hit && Date.now() - hit.at < FIELD_CACHE_MS) return hit.ids;

  const { customFields = [] } = await ghl(token, 'GET', `/locations/${locationId}/customFields?model=contact`);
  const find = (name) => {
    const n = name.toLowerCase();
    const f = customFields.find(
      (c) => String(c.name || '').trim().toLowerCase() === n || String(c.fieldKey || '').toLowerCase() === n
    );
    if (!f) throw new Error(`No contact custom field named "${name}" in location ${locationId}`);
    return f.id;
  };
  const ids = { lendersFieldId: find(lendersName), logFieldId: find(logName) };
  fieldCache.set(key, { at: Date.now(), ids });
  return ids;
}

function fieldValue(contact, fieldId) {
  const f = (contact.customFields || []).find((c) => c.id === fieldId);
  return f ? f.value ?? f.field_value ?? f.fieldValue : undefined;
}

async function processContact({ token, locationId, contactId, lendersFieldId, logFieldId, timeZone, addNote }) {
  const { contact } = await ghl(token, 'GET', `/contacts/${contactId}`);
  if (!contact) throw new Error(`Contact ${contactId} not found`);
  if (contact.locationId && contact.locationId !== locationId) {
    throw new Error(`Contact ${contactId} is not in location ${locationId}`);
  }

  const lenders = toList(fieldValue(contact, lendersFieldId));
  // Empty means the change that fired this webhook was our own clear. Stop here.
  if (!lenders.length) return { contactId, logged: 0 };

  const when = stamp(timeZone);
  const lines = lenders.map((name) => `${when} - ${name}`).join('\n');
  const existing = String(fieldValue(contact, logFieldId) || '').trim();
  const log = (NEWEST_FIRST === 'true' ? [lines, existing] : [existing, lines]).filter(Boolean).join('\n');

  // One request writes the log and clears the checkbox, so a failure can't
  // clear the lenders without recording them.
  await ghl(token, 'PUT', `/contacts/${contactId}`, {
    customFields: [
      { id: logFieldId, field_value: log },
      { id: lendersFieldId, field_value: [] },
    ],
  });

  // The note is a copy for the contact's timeline. It runs after the log is
  // saved, so if it fails the shop-out is still recorded in the field.
  let noteAdded = false;
  let noteError;
  if (addNote) {
    try {
      const body = [`Lender shop-out - ${when}`, ...lenders.map((name) => `- ${name}`)].join('\n');
      await ghl(token, 'POST', `/contacts/${contactId}/notes`, { body });
      noteAdded = true;
    } catch (err) {
      noteError = err.message;
      console.error(`[${locationId}] ${contactId}: note not added: ${err.message}`);
    }
  }
  return { contactId, logged: lenders.length, lenders, noteAdded, ...(noteError && { noteError }) };
}

// Run one job at a time per contact so two quick changes can't overwrite each other.
const queues = new Map();
function inOrder(contactId, job) {
  const prev = queues.get(contactId) || Promise.resolve();
  const next = prev.catch(() => {}).then(job);
  queues.set(contactId, next);
  next.catch(() => {}).finally(() => {
    if (queues.get(contactId) === next) queues.delete(contactId);
  });
  return next;
}

const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/', (_req, res) => res.send('ghl-lender-log ok'));

app.post('/webhook', async (req, res) => {
  if (WEBHOOK_SECRET && (req.get('x-webhook-secret') || req.query.secret) !== WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'bad secret' });
  }

  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const token = pick(b, ['ghl_token', 'ghlToken', 'token', 'access_token', 'api_key']).replace(/^Bearer\s+/i, '');
  const locationId = pick(b, ['location_id', 'locationId']) || b.location?.id || '';
  const contactId = pick(b, ['contact_id', 'contactId']) || b.contact?.id || '';

  const missing = [!token && 'ghl_token', !locationId && 'location_id', !contactId && 'contact_id'].filter(Boolean);
  if (missing.length) return res.status(400).json({ error: `missing in webhook: ${missing.join(', ')}` });

  const tz = pick(b, ['timezone']);
  const timeZone = tz && validZone(tz) ? tz : TIMEZONE;
  const noteSetting = pick(b, ['add_note']).toLowerCase();
  const addNote = noteSetting ? noteSetting !== 'false' : ADD_NOTE !== 'false';

  try {
    // Field IDs can be sent directly; otherwise they are found by name.
    let lendersFieldId = pick(b, ['lenders_field_id']);
    let logFieldId = pick(b, ['log_field_id']);
    if (!lendersFieldId || !logFieldId) {
      const ids = await findFieldIds(
        token,
        locationId,
        pick(b, ['lenders_field']) || LENDERS_FIELD_NAME,
        pick(b, ['log_field']) || LOG_FIELD_NAME
      );
      lendersFieldId = lendersFieldId || ids.lendersFieldId;
      logFieldId = logFieldId || ids.logFieldId;
    }

    const result = await inOrder(contactId, () =>
      processContact({ token, locationId, contactId, lendersFieldId, logFieldId, timeZone, addNote })
    );
    console.log(
      result.logged
        ? `[${locationId}] Logged ${result.logged} lender(s) for ${contactId}: ${result.lenders.join(', ')}` +
            (result.noteAdded ? ' (+ note)' : '')
        : `[${locationId}] Nothing to log for ${contactId} (Lenders empty)`
    );
    res.json(result);
  } catch (err) {
    console.error(`[${locationId}] ${contactId}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`ghl-lender-log listening on ${PORT}`));
