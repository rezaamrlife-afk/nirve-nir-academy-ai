// /api/analyze — authenticated, usage-limited pass-through to Groq.
//   Free 5 / Pro 15 essay analyses per UTC day. Evolution and Critical Thinking cost no essay quota
//   but are tied to a completed analysis and capped (1 / 5 / 15 per analysis).
// Required env: GROQ_KEY, SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
import {
  classify, parseModelJson, isValidResult, essayHash, planOf, utcDate, UUID_RE,
  LIMITS, FOLLOWUP_WINDOW, GROQ_TIMEOUT_MS, MSG
} from './_lib/nirve.js';

function send(res, status, error, code, extra) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).json({ error: Object.assign({ message: error, code }, extra || {}) });
}

async function timedFetch(url, opts, ms) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, Object.assign({}, opts, { signal: ac.signal })); }
  finally { clearTimeout(t); }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const env = process.env;
  const GROQ_KEY = env.GROQ_KEY;
  const SB = env.SUPABASE_URL, ANON = env.SUPABASE_ANON_KEY, SVC = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!GROQ_KEY) return res.status(500).json({ error: 'API key not configured' });
  if (!SB || !ANON || !SVC) return send(res, 500, MSG.unavailable, 'usage_unconfigured'); // fail closed

  // 1) login required: verify the Supabase access token
  const auth = String(req.headers['authorization'] || '');
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) return send(res, 401, MSG.login, 'login_required');
  let user;
  try {
    const ur = await timedFetch(SB + '/auth/v1/user', { headers: { apikey: ANON, Authorization: 'Bearer ' + token } }, 8000);
    if (ur.status === 401 || ur.status === 403) return send(res, 401, MSG.session, 'invalid_session');
    if (!ur.ok) return send(res, 503, MSG.unavailable, 'usage_unavailable');
    user = await ur.json();
  } catch (e) { return send(res, 503, MSG.unavailable, 'usage_unavailable'); }
  if (!user || !user.id) return send(res, 401, MSG.session, 'invalid_session');
  const plan = planOf(user);
  const limit = LIMITS[plan];

  // 2) understand and sanitise the request
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
  const c = classify(body);
  if (!c.ok) return send(res, c.status, c.message, c.code);

  const rpc = async (name, args) => {
    const r = await timedFetch(SB + '/rest/v1/rpc/' + name, {
      method: 'POST',
      headers: { apikey: SVC, Authorization: 'Bearer ' + SVC, 'Content-Type': 'application/json' },
      body: JSON.stringify(args)
    }, 8000);
    if (!r.ok) throw new Error('rpc ' + name + ' ' + r.status);
    return r.json();
  };
  const callGroq = async () => {
    const gr = await timedFetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + GROQ_KEY },
      body: JSON.stringify(c.groqBody)
    }, GROQ_TIMEOUT_MS);
    let data = null;
    try { data = await gr.json(); } catch (e) { /* not JSON */ }
    return { ok: gr.ok, status: gr.status, data };
  };
  const safeFinish = async (name, args) => {          // one retry; refunds must not be lost to a blip
    for (let i = 0; i < 2; i++) { try { return await rpc(name, args); } catch (e) { /* retry */ } }
    return null;
  };

  try {
    // ───────────────────────── essay analysis (consumes quota) ─────────────────────────
    if (c.kind === 'analysis') {
      const idem = String(req.headers['x-idempotency-key'] || '');
      if (!UUID_RE.test(idem)) return send(res, 400, 'Invalid request.', 'bad_request');
      const hash = essayHash(c.essay);

      let begin;
      try {
        const rows = await rpc('nirve_begin_analysis', { p_user_id: user.id, p_date: utcDate(), p_limit: limit, p_idem: idem, p_essay_hash: hash });
        begin = Array.isArray(rows) ? rows[0] : rows;
      } catch (e) { return send(res, 503, MSG.unavailable, 'usage_unavailable'); }
      if (!begin || !begin.o_outcome) return send(res, 503, MSG.unavailable, 'usage_unavailable');

      const hdr = (runId, used) => {
        res.setHeader('Cache-Control', 'no-store');
        if (runId) res.setHeader('X-Nirve-Run', runId);
        res.setHeader('X-Nirve-Plan', plan);
        res.setHeader('X-Nirve-Limit', String(limit));
        res.setHeader('X-Nirve-Used', String(used == null ? '' : used));
      };
      switch (begin.o_outcome) {
        case 'limit':           return send(res, 429, plan === 'pro' ? MSG.limitPro : MSG.limitFree, 'limit_reached', { plan, limit, used: begin.o_used });
        case 'in_progress':     return send(res, 409, MSG.inProgress, 'in_progress');
        case 'key_conflict':
        case 'key_failed':
        case 'replay_expired':  return send(res, 409, MSG.keyUsed, begin.o_outcome);
        case 'replay':          hdr(begin.o_run_id, begin.o_used); return res.status(200).json(begin.o_result);
        case 'started':         break;
        default:                return send(res, 503, MSG.unavailable, 'usage_unavailable');
      }

      const runId = begin.o_run_id;
      let g;
      try { g = await callGroq(); }
      catch (e) {
        await safeFinish('nirve_finish_analysis', { p_run_id: runId, p_user_id: user.id, p_ok: false, p_result: null });
        const aborted = e && e.name === 'AbortError';
        return send(res, aborted ? 504 : 502, aborted ? MSG.timeout : MSG.upstream, aborted ? 'timeout' : 'upstream_error');
      }
      const parsed = g.ok ? parseModelJson(g.data) : null;
      if (!g.ok || !isValidResult('analysis', parsed)) {
        await safeFinish('nirve_finish_analysis', { p_run_id: runId, p_user_id: user.id, p_ok: false, p_result: null });
        return send(res, 502, MSG.upstream, 'upstream_error');
      }
      await safeFinish('nirve_finish_analysis', { p_run_id: runId, p_user_id: user.id, p_ok: true, p_result: g.data });
      hdr(runId, begin.o_used);
      return res.status(200).json(g.data);
    }

    // ─────────── follow-ups: Evolution / Critical Thinking (no essay quota, bound to a completed analysis) ───────────
    const runId = String(req.headers['x-nirve-run'] || '');
    if (!UUID_RE.test(runId)) return send(res, 403, MSG.noRun, 'no_run');
    let fu;
    try {
      const rows = await rpc('nirve_begin_followup', {
        p_run_id: runId, p_user_id: user.id, p_kind: c.kind,
        p_essay_hash: c.kind === 'evolution' ? essayHash(c.essay) : null, p_max_age: FOLLOWUP_WINDOW
      });
      fu = Array.isArray(rows) ? rows[0] : rows;
    } catch (e) { return send(res, 503, MSG.unavailable, 'usage_unavailable'); }
    if (!fu || !fu.o_outcome) return send(res, 503, MSG.unavailable, 'usage_unavailable');
    if (fu.o_outcome !== 'ok') {
      const map = {
        no_run: [403, MSG.noRun], run_not_complete: [403, MSG.noRun], expired: [403, MSG.followupExpired],
        essay_mismatch: [403, MSG.followupDenied], cap_reached: [429, MSG.followupCap], bad_kind: [400, 'Invalid request.']
      };
      const m = map[fu.o_outcome] || [403, MSG.followupDenied];
      return send(res, m[0], m[1], fu.o_outcome);
    }

    let g;
    try { g = await callGroq(); }
    catch (e) {
      await safeFinish('nirve_finish_followup', { p_followup_id: fu.o_followup_id, p_user_id: user.id, p_ok: false });
      const aborted = e && e.name === 'AbortError';
      return send(res, aborted ? 504 : 502, aborted ? MSG.timeout : MSG.upstream, aborted ? 'timeout' : 'upstream_error');
    }
    const parsed = g.ok ? parseModelJson(g.data) : null;
    const good = g.ok && isValidResult(c.kind, parsed);
    await safeFinish('nirve_finish_followup', { p_followup_id: fu.o_followup_id, p_user_id: user.id, p_ok: !!good });
    if (!good) return send(res, 502, MSG.upstream, 'upstream_error');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(g.data);
  } catch (err) {
    return send(res, 500, 'Unexpected error.', 'internal');
  }
}
