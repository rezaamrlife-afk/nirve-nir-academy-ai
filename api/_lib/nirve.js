// Shared helpers for /api/analyze (not routed by Vercel: the folder starts with "_").
import { createHash } from 'node:crypto';

export const GROQ_MODEL = 'openai/gpt-oss-120b';            // must equal GROQ_MODEL in index.html
export const LIMITS = { free: 5, pro: 15 };                  // analyses per UTC day
export const FOLLOWUP_WINDOW = '2 hours';                    // how long after an analysis follow-ups are allowed
export const GROQ_TIMEOUT_MS = 25000;
export const MAX_ESSAY_CHARS = 40000;

// Per-kind server-side clamps. Values equal the client's base max_tokens x 2 (the i18n wrapper doubles it for fa/ar).
export const CAPS = {
  analysis:          { tokens: 3000, chars: 80000 },
  evolution:         { tokens: 2400, chars: 50000 },
  training_generate: { tokens: 2800, chars: 50000 },
  training_evaluate: { tokens: 800,  chars: 15000 },
  proofread:         { tokens: 3000, chars: 50000 }       // client: 1500 (x2 for fa/ar). Grammar + spelling check, one per analysis
};
// gpt-oss spends part of max_tokens on hidden reasoning; a proofreading pass that runs out of tokens returns an empty or
// cut-off answer. So the server (not the client) guarantees a floor and asks for low reasoning effort for this kind only.
export const PROOFREAD_MIN_TOKENS = 2000;
export const PROOFREAD_REASONING_EFFORT = 'low';

// Follow-up kinds are counted by the usage database under the kind names it already knows. 'proofread' has no
// kind of its own there yet, so it is booked as 'training_evaluate': it needs a completed analysis, costs NO essay
// quota, and is refunded if the AI call fails. To give it its own kind later, add it to the SQL functions and
// change this one line to  proofread: 'proofread'.
export const FOLLOWUP_DB_KIND = { proofread: 'training_evaluate' };

// Anchors taken from the real prompts built by index.html (checked by tests/api/classify.test.mjs against every mode).
const T = {
  analysis: {
    start: 'You are NIRVE — a Writing Intelligence Platform',
    open: '\nStudent response:\n---\n',
    close: '\n---\n\nReturn ONLY valid JSON, no markdown, no extra text.'
  },
  evolution: {
    start: 'You are a writing coach for ',
    must: 'Take the weakest paragraph from this response',
    open: '\nFull essay:\n---\n',
    close: '\n---\nIdentify the weakest paragraph.'
  },
  training_generate: {
    start: 'You are a Critical Thinking Coach for academic writing.\nA student wrote this essay:\n---\n',
    close: '\n---\nDetected thinking gaps:'
  },
  training_evaluate: {
    start: 'You are evaluating a student response to a Critical Thinking exercise.\n\nExercise type: ',
    must: '\n\nEvaluate the quality of critical thinking in this answer.'
  },
  // Grammar (red) + spelling (blue) highlights. The client sends the essay as numbered sentences, one per line.
  proofread: {
    start: 'You are a careful English proofreader for second-language writers.',
    must: '\n\nSENTENCES:\n[1] ',
    open: '\n\nSENTENCES:\n',
    close: '\n\nReturn ONLY valid JSON, compact, in exactly this shape:'
  }
};

const ALLOWED_KEYS = ['model', 'messages', 'temperature', 'max_tokens', 'response_format'];

export function normEssay(s) { return String(s).replace(/\s+/g, ' ').trim(); }
export function essayHash(essay) { return createHash('sha256').update(normEssay(essay), 'utf8').digest('hex'); }

/** The proofread block must be numbered sentences only: "[1] text" per line (keeps the endpoint from being a free-form prompt). */
function numberedLines(block) {
  const lines = String(block).split('\n').filter(l => l.trim() !== '');
  return lines.length > 0 && lines.length <= 2000 && lines.every(l => /^\[\d{1,4}\] \S/.test(l));
}

function bad(code, message, status) { return { ok: false, code, message, status: status || 400 }; }

/** Decide what a request is, validate it, and build the only body we will send to Groq. */
export function classify(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return bad('bad_request', 'Invalid request.');
  for (const k of Object.keys(body)) if (!ALLOWED_KEYS.includes(k)) return bad('bad_request', 'Invalid request.');
  if (body.model !== GROQ_MODEL) return bad('bad_request', 'Invalid request.');
  if (!Array.isArray(body.messages) || body.messages.length !== 1) return bad('bad_request', 'Invalid request.');
  const m = body.messages[0];
  if (!m || m.role !== 'user' || typeof m.content !== 'string') return bad('bad_request', 'Invalid request.');
  if (body.response_format !== undefined && !(body.response_format && body.response_format.type === 'json_object')) return bad('bad_request', 'Invalid request.');
  const c = m.content;

  let kind = null;
  for (const k of ['analysis', 'training_evaluate', 'training_generate', 'evolution', 'proofread']) {
    const t = T[k];
    if (c.startsWith(t.start) && (!t.must || c.includes(t.must))) { kind = k; break; }
  }
  if (!kind) return bad('unsupported_request', 'This request type is not supported.');
  if (c.length > CAPS[kind].chars) return bad('too_large', 'The text is too long to process.', 413);

  let essay = null;
  if (kind !== 'training_evaluate') {
    const t = T[kind];
    const from = t.open ? c.indexOf(t.open) : 0;
    const startAt = t.open ? from + t.open.length : t.start.length;
    const to = c.lastIndexOf(t.close);
    if ((t.open && from < 0) || to < startAt) return bad('unsupported_request', 'This request type is not supported.');
    essay = c.slice(startAt, to);
    if (kind === 'proofread' && !numberedLines(essay)) return bad('unsupported_request', 'This request type is not supported.');
    if (!normEssay(essay)) return bad('bad_request', 'There is no text to analyze.');
    if (essay.length > MAX_ESSAY_CHARS) return bad('too_large', 'The text is too long to process.', 413);
  }

  const cap = CAPS[kind].tokens;
  let tokens = Number(body.max_tokens);
  if (!isFinite(tokens) || tokens < 1) tokens = cap;
  tokens = Math.min(Math.floor(tokens), cap);
  if (kind === 'proofread') tokens = Math.max(tokens, PROOFREAD_MIN_TOKENS);
  let temp = Number(body.temperature);
  if (!isFinite(temp)) temp = 0.3;
  temp = Math.min(Math.max(temp, 0), 1);

  return {
    ok: true, kind, essay,
    groqBody: Object.assign(
      { model: GROQ_MODEL, messages: [{ role: 'user', content: c }], temperature: temp, max_tokens: tokens, response_format: { type: 'json_object' } },
      kind === 'proofread' ? { reasoning_effort: PROOFREAD_REASONING_EFFORT } : {})
  };
}

/** Proofread answers may be wrapped in ```json fences or cut off mid-list; keep every complete item. */
function parseProofread(content) {
  let t = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const a = t.indexOf('{'); if (a > 0) t = t.slice(a);
  try { const o = JSON.parse(t); return (o && typeof o === 'object' && !Array.isArray(o)) ? o : null; } catch (e) { /* maybe cut off */ }
  const errors = []; const re = /\{[^{}]*\}/g; let m;
  while ((m = re.exec(t))) { try { const it = JSON.parse(m[0]); if (it && typeof it === 'object' && it.text != null) errors.push(it); } catch (e) { /* skip */ } }
  return errors.length ? { errors, salvaged: true } : null;
}

/** Groq answers HTTP 400 "json_validate_failed" when the JSON was cut off or malformed and puts the text in
 *  error.failed_generation. For proofread, every complete item in it is still useful: rebuild a normal answer from it. */
export function rescueProofread(data) {
  try {
    const fg = data && data.error && data.error.failed_generation;
    if (typeof fg !== 'string') return null;
    const parsed = parseProofread(fg);
    if (!isValidResult('proofread', parsed) || !(parsed.errors || parsed.grammar || parsed.spelling).length) return null;
    return { parsed, data: { choices: [{ message: { role: 'assistant', content: JSON.stringify(parsed) }, finish_reason: 'length' }] } };
  } catch (e) { return null; }
}

/** Why the AI call produced nothing usable (no essay text, no secrets). Sent to the client for proofread only. */
export function upstreamDetail(g) {
  const d = g && g.data, e = d && d.error, ch = d && d.choices && d.choices[0];
  const msg = e && (e.message || (typeof e === 'string' ? e : ''));
  return {
    status: g ? g.status : null,
    code: (e && e.code) ? String(e.code).slice(0, 60) : null,
    message: msg ? String(msg).slice(0, 180) : null,
    finish: ch && ch.finish_reason ? String(ch.finish_reason) : null,
    empty: !!(ch && ch.message && (ch.message.content == null || String(ch.message.content).trim() === ''))
  };
}

/** Parse the model's JSON answer; null when it is not a JSON object. */
export function parseModelJson(data, kind) {
  try {
    const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (typeof content !== 'string') return null;
    if (kind === 'proofread') return parseProofread(content);
    const o = JSON.parse(content);
    return (o && typeof o === 'object' && !Array.isArray(o)) ? o : null;
  } catch (e) { return null; }
}

const filled = v => typeof v === 'string' && v.trim().length > 0;
const hasText = o => !!o && typeof o === 'object' && Object.values(o).some(filled);

/** A result is only "successful" (and only then charged) when it contains real content,
 *  not an empty shell such as {"band":6,"scores":{}} or blank feedback. */
export function isValidResult(kind, o) {
  if (!o || typeof o !== 'object') return false;
  if (kind === 'analysis') {
    const nums = o.scores && typeof o.scores === 'object' ? Object.values(o.scores).filter(v => isFinite(parseFloat(v))) : [];
    return isFinite(parseFloat(o.band)) && nums.length > 0 && (hasText(o.examiner) || hasText(o.teacher) || hasText(o.coach));
  }
  if (kind === 'evolution') return [o.band6, o.band7, o.band8].some(b => b && filled(b.text));
  if (kind === 'training_generate') return Array.isArray(o.exercises) && o.exercises.some(e => e && filled(e.question));
  if (kind === 'training_evaluate') return isFinite(parseFloat(o.score)) && (filled(o.verdict) || (Array.isArray(o.points) && o.points.some(filled)));
  // "no errors found" ({"errors":[]}) is a real answer; only a missing/garbled list is a failure
  if (kind === 'proofread') return Array.isArray(o.errors) || Array.isArray(o.grammar) || Array.isArray(o.spelling);
  return false;
}

export function planOf(user) {
  const p = user && user.app_metadata && user.app_metadata.plan;
  return String(p || '').toLowerCase() === 'pro' ? 'pro' : 'free';
}
export function utcDate(d) { return (d || new Date()).toISOString().slice(0, 10); }
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const MSG = {
  login: 'Please sign in to analyze your writing.',
  session: 'Your session has expired. Please sign in again.',
  limitFree: 'You have used all 5 free analyses for today. Your limit resets at 00:00 UTC.',
  limitPro: 'You have used all 15 Pro analyses for today. Your limit resets at 00:00 UTC.',
  inProgress: 'This analysis is already running. Please wait a moment.',
  keyUsed: 'This request was already used. Please try again.',
  upstream: 'The analysis could not be completed. It was not counted against your daily limit.',
  timeout: 'The analysis took too long. It was not counted against your daily limit.',
  unavailable: 'The usage service is temporarily unavailable. Please try again.',
  noRun: 'Run an analysis first to use this feature.',
  followupExpired: 'This feature is only available for 2 hours after an analysis. Run a new analysis to continue.',
  followupCap: 'You have reached the limit for this feature for this analysis.',
  followupDenied: 'This request does not match your latest analysis.'
};
