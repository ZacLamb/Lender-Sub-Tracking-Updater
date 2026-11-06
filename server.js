// GHL Lender Log
// Webhook from a GHL workflow -> read the lender checkbox field(s) on the contact ->
// add one timestamped line per lender to a log field -> clear the checkbox(es).
//
// The GHL token and location ID arrive in each webhook POST, so one deploy
// serves any number of sub-accounts. Nothing account-specific lives in Railway.
//
// Accounts with several lender fields (e.g. "Lenders", "A+ Lenders", "B Lenders",
// or "1st Position", "2nd Position") send `lenders_fields` in the webhook custom
// data as a comma-separated list. Every listed field is logged into the same log
// field with the field name as a prefix, and all of them are cleared:
//   11/06/26 09:30 EST - A+ Lenders - Kapitus
//   11/06/26 09:30 EST - Lenders - Forward
// `lenders_fields: auto` logs every contact checkbox whose name contains
// lender / position / tier.

const express = require('express');

const {
  LENDERS_FIELD_NAME = 'Lenders', // default single checkbox field to read and clear
  LOG_FIELD_NAME = 'Lender Submission Log', // Large Text field that holds the history
  AUTO_FIELD_PATTERN = 'lender|position|tier', // used when lenders_fields = auto
  TIMEZONE = 'America/New_York',
  NEWEST_FIRST = 'true',
  ADD_NOTE = 'true', // also post each shop-out as a contact note
  WEBHOOK_SECRET = '', // optional; if set, the webhook must send it
  GHL_API_BASE = 'https://services.leadconnectorhq.com',
  PORT = 3000,
} = process.env;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// GHL rate-limits per token per location. Retry 429s (honouring Retry-After)
// and transient 5xx a few times before giving up.
async function ghl(token, method, path, body, attempt = 0) {
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
  if ((res.status === 429 || res.status >= 500) && attempt < 4) {
    const retryAfter = Number(res.headers.get('retry-after')) || 0;
    const wait = Math.max(retryAfter * 1000, 1500 * 2 ** attempt);
    console.warn(`GHL ${method} ${path} -> ${res.status}; retrying in ${wait}ms (attempt ${attempt + 1})`);
    await sleep(wait);
    return ghl(token, method, path, body, attempt + 1);
  }
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

const norm = (s) => String(s || '').trim().toLowerCase();

// Returns { lenderFields: [{ id, name }], logFieldId }
async function findFieldIds(token, locationId, lenderNames, logName) {
  const key = `${locationId}|${lenderNames.join(',')}|${logName}`.toLowerCase();
  const hit = fieldCache.get(key);
  if (hit && Date.now() - hit.at < FIELD_CACHE_MS) return hit.ids;

  const { customFields = [] } = await ghl(token, 'GET', `/locations/${locationId}/customFields?model=contact`);
  const byName = (name) =>
    customFields.find((c) => norm(c.name) === norm(name) || norm(c.fieldKey) === norm(name));

  let lenderFields;
  if (lenderNames.length === 1 && norm(lenderNames[0]) === 'auto') {
    const re = new RegExp(AUTO_FIELD_PATTERN, 'i');
    lenderFields = customFields
      .filter((c) => String(c.dataType || '').toUpperCase() === 'CHECKBOX' && re.test(String(c.name || '')))
      .map((c) => ({ id: c.id, name: c.name }));
    if (!lenderFields.length) throw new Error(`No checkbox fields matching /${AUTO_FIELD_PATTERN}/ in location ${locationId}`);
  } else {
    lenderFields = lenderNames.map((name) => {
      const f = byName(name);
      if (!f) throw new Error(`No contact custom field named "${name}" in location ${locationId}`);
      return { id: f.id, name: f.name || name };
    });
  }

  const log = byName(logName);
  if (!log) throw new Error(`No contact custom field named "${logName}" in location ${locationId}`);

  const ids = { lenderFields, logFieldId: log.id };
  fieldCache.set(key, { at: Date.now(), ids });
  return ids;
}

function fieldValue(contact, fieldId) {
  const f = (contact.customFields || []).find((c) => c.id === fieldId);
  return f ? f.value ?? f.field_value ?? f.fieldValue : undefined;
}

async function processContact({ token, locationId, contactId, lenderFields, logFieldId, timeZone, addNote }) {
  const { contact } = await ghl(token, 'GET', `/contacts/${contactId}`);
  if (!contact) throw new Error(`Contact ${contactId} not found`);
  if (contact.locationId && contact.locationId !== locationId) {
    throw new Error(`Contact ${contactId} is not in location ${locationId}`);
  }

  // Collect every checked lender across all lender fields.
  const multi = lenderFields.length > 1;
  const entries = []; // { field, name }
  for (const f of lenderFields) {
    for (const name of toList(fieldValue(contact, f.id))) entries.push({ field: f.name, name });
  }
  // Empty means the change that fired this webhook was our own clear. Stop here.
  if (!entries.length) return { contactId, logged: 0 };

  const when = stamp(timeZone);
  const label = (e) => (multi ? `${e.field} - ${e.name}` : e.name);
  const lines = entries.map((e) => `${when} - ${label(e)}`).join('\n');
  const existing = String(fieldValue(contact, logFieldId) || '').trim();
  const log = (NEWEST_FIRST === 'true' ? [lines, existing] : [existing, lines]).filter(Boolean).join('\n');

  // One request writes the log and clears every lender checkbox, so a failure
  // can't clear the lenders without recording them.
  await ghl(token, 'PUT', `/contacts/${contactId}`, {
    customFields: [{ id: logFieldId, field_value: log }, ...lenderFields.map((f) => ({ id: f.id, field_value: [] }))],
  });

  // The note is a copy for the contact's timeline. It runs after the log is
  // saved, so if it fails the shop-out is still recorded in the field.
  let noteAdded = false;
  let noteError;
  if (addNote) {
    try {
      const body = [`Lender shop-out - ${when}`, ...entries.map((e) => `- ${label(e)}`)].join('\n');
      await ghl(token, 'POST', `/contacts/${contactId}/notes`, { body });
      noteAdded = true;
    } catch (err) {
      noteError = err.message;
      console.error(`[${locationId}] ${contactId}: note not added: ${err.message}`);
    }
  }
  return { contactId, logged: entries.length, lenders: entries.map(label), noteAdded, ...(noteError && { noteError }) };
}

// Run one job at a time per location, spaced out a little, so a burst of
// contact changes doesn't trip the per-location rate limit, and two quick
// changes to one contact can't overwrite each other.
const queues = new Map();
const GAP_MS = 250;
function inOrder(key, job) {
  const prev = queues.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(() => sleep(GAP_MS)).then(job);
  queues.set(key, next);
  next.catch(() => {}).finally(() => {
    if (queues.get(key) === next) queues.delete(key);
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

  // Which checkbox field(s) hold the lenders: `lenders_fields` (comma list or
  // "auto"), else `lenders_field`, else the env default.
  const lenderNames = toList(pick(b, ['lenders_fields', 'lender_fields']) || pick(b, ['lenders_field']) || LENDERS_FIELD_NAME);

  try {
    const { lenderFields, logFieldId } = await findFieldIds(token, locationId, lenderNames, pick(b, ['log_field']) || LOG_FIELD_NAME);

    const result = await inOrder(locationId, () =>
      processContact({ token, locationId, contactId, lenderFields, logFieldId, timeZone, addNote })
    );
    console.log(
      result.logged
        ? `[${locationId}] Logged ${result.logged} lender(s) for ${contactId}: ${result.lenders.join(', ')}` +
            (result.noteAdded ? ' (+ note)' : '')
        : `[${locationId}] Nothing to log for ${contactId} (lender fields empty)`
    );
    res.json(result);
  } catch (err) {
    console.error(`[${locationId}] ${contactId}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`ghl-lender-log listening on ${PORT}`));
