/**
 * Citerank Deploy — Cloudflare Worker
 *
 * A second implementation of the same contract the WordPress plugin speaks, for
 * sites that are not WordPress. Citerank sends the identical requests to both.
 *
 * It works differently in one important way, and the difference is in your
 * favour. The plugin edits your site: it writes llms.txt into your web root,
 * stores robots additions in an option, and keeps a copy of whatever was there
 * before so it can put it back. This Worker never touches your origin at all.
 * It sits in front of it and answers four paths from its own storage; every
 * other request passes through untouched.
 *
 * That makes revert exact rather than best-effort. There is no previous value to
 * restore because nothing was overwritten: deleting the stored value stops the
 * Worker answering, and your origin serves what it always served.
 *
 * Signals supported: llms_txt, robots, a2a, webmcp. These are the four that are
 * a file or a rule at a fixed location. entity_schema is per-page and addressed
 * by WordPress post ID, which has no meaning here, so it is refused with a clear
 * reason rather than accepted and silently dropped.
 *
 * Setup
 *   1. Create a KV namespace and bind it as CITERANK_KV.
 *   2. Set CITERANK_KEY as a secret: wrangler secret put CITERANK_KEY
 *      Use the key Citerank shows you when you connect the site.
 *   3. Deploy, with the Worker on a route covering the whole site: example.com/*
 */

/* Bump this whenever this file changes in a way a deployed site should pick up.
 *
 * The Worker does not update itself: a site keeps running the copy it deployed.
 * This is the only way anyone can tell a running deployment from a current one,
 * and it is reported by the status endpoint so both sides can compare. */
const CLIENT_VERSION = 2;

const BRIDGE_PATH = '/citerank/v1';

/* Where each signal is served, and how. "replace" answers the path outright.
 * "merge" fetches the origin first and appends, which is what robots.txt needs:
 * replacing it would silently drop rules the site already relies on. */
const SIGNALS = {
  llms_txt: { path: '/llms.txt',                     type: 'text/plain; charset=utf-8',  mode: 'replace' },
  robots:   { path: '/robots.txt',                   type: 'text/plain; charset=utf-8',  mode: 'merge'   },
  a2a:      { path: '/.well-known/a2a.json',         type: 'application/json',           mode: 'replace' },
  webmcp:   { path: '/.well-known/toolcatalog.json', type: 'application/json',           mode: 'replace' },
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

/* Constant-time compare. A plain === leaks the key a character at a time to
 * anyone who can measure the response, and this key is the only thing standing
 * between the internet and the ability to publish files on the site. */
function keyMatches(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string') return false;
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

const kvKey = (signal) => `signal:${signal}`;
const LOG_KEY = 'deployments';

async function readLog(env) {
  return (await env.CITERANK_KV.get(LOG_KEY, 'json')) || [];
}

async function appendLog(env, entry) {
  const log = await readLog(env);
  log.unshift({ ...entry, at: new Date().toISOString() });
  // Bounded: this is an audit trail, not storage. KV values have a size limit
  // and an unbounded log would eventually fail to write, which would fail the
  // deploy that was trying to record itself.
  await env.CITERANK_KV.put(LOG_KEY, JSON.stringify(log.slice(0, 100)));
}

async function handleBridge(request, env, url) {
  const endpoint = url.pathname.slice(BRIDGE_PATH.length + 1);

  if (!keyMatches(request.headers.get('X-Citerank-Key') || '', env.CITERANK_KEY || '')) {
    return json({ error: 'Invalid or missing X-Citerank-Key' }, 401);
  }

  const body = request.method === 'POST'
    ? await request.json().catch(() => ({}))
    : {};

  switch (endpoint) {
    case 'status':
      return json({
        success: true,
        client: 'cloudflare-worker',
        version: CLIENT_VERSION,
        /* Declared, not implied. Citerank reads this to know which signals to
         * offer, so a client that cannot do per-page schema says so here rather
         * than failing later when someone presses Deploy. */
        supports: Object.keys(SIGNALS),
        page_level: false,
      });

    case 'preflight': {
      // Nothing to check for writability: this Worker writes to its own storage,
      // never to the origin. The one thing that can be wrong is the binding.
      const bound = !!env.CITERANK_KV;
      return json({
        success: bound,
        writable: bound,
        error: bound ? undefined : 'CITERANK_KV is not bound to this Worker',
      });
    }

    case 'health': {
      const checks = {};
      for (const [name, sig] of Object.entries(SIGNALS)) {
        const stored = await env.CITERANK_KV.get(kvKey(name));
        checks[name] = { deployed: stored !== null, path: sig.path };
      }
      const live = Object.values(checks).filter(c => c.deployed).length;
      return json({
        success: true,
        overall: live > 0 ? 'ok' : 'none',
        checked_at: new Date().toISOString(),
        summary: { live, of: Object.keys(SIGNALS).length },
        file_checks: checks,
      });
    }

    case 'deploy': {
      const signal = body.signal_key || body.type;
      const sig = SIGNALS[signal];
      if (!sig) {
        return json({
          error: `This client serves site-level signals only (${Object.keys(SIGNALS).join(', ')}). `
               + `"${signal}" is page-level and needs a platform that can address individual pages.`,
          code: 'unsupported_signal',
        }, 400);
      }
      const content = signal === 'robots'
        ? (body.payload?.additions ?? body.payload?.content)
        : (body.payload?.content ?? body.payload?.jsonld ?? body.payload?.additions);
      if (typeof content !== 'string' || !content.trim()) {
        return json({ error: 'payload must carry a non-empty string', code: 'bad_payload' }, 400);
      }
      await env.CITERANK_KV.put(kvKey(signal), content);
      await appendLog(env, { signal, action: 'deploy', bytes: content.length });
      return json({ success: true, signal_key: signal, preview: content.slice(0, 400), revertible: true });
    }

    case 'revert': {
      const signal = body.signal_key || body.type;
      if (!SIGNALS[signal]) return json({ error: 'Unknown signal', code: 'unsupported_signal' }, 400);
      /* Exact, not best-effort. The origin was never modified, so removing the
       * stored value is the whole of the undo: the next request passes through
       * and the site serves what it always served. */
      await env.CITERANK_KV.delete(kvKey(signal));
      await appendLog(env, { signal, action: 'revert' });
      return json({ success: true, signal_key: signal, reverted: true });
    }

    case 'deployments':
      return json({ success: true, deployments: await readLog(env) });

    case 'webhook-url':
      return json({ success: true, webhook_url: null, supported: false });

    default:
      return json({
        error: `Endpoint "${endpoint}" is not implemented by this client`,
        code: 'not_implemented',
      }, 404);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === BRIDGE_PATH || url.pathname.startsWith(BRIDGE_PATH + '/')) {
      if (!env.CITERANK_KV) return json({ error: 'CITERANK_KV is not bound' }, 500);
      if (!env.CITERANK_KEY) return json({ error: 'CITERANK_KEY is not set' }, 500);
      return handleBridge(request, env, url);
    }

    const hit = Object.entries(SIGNALS).find(([, s]) => s.path === url.pathname);
    // Only GET and HEAD are answered from storage. A POST to /robots.txt is not
    // a request for the file and must reach the origin like anything else.
    if (!hit || !['GET', 'HEAD'].includes(request.method) || !env.CITERANK_KV) {
      return fetch(request);
    }

    const [name, sig] = hit;
    const stored = await env.CITERANK_KV.get(kvKey(name));
    if (stored === null) return fetch(request);   // nothing deployed: origin wins

    if (sig.mode === 'merge') {
      /* Append, never replace. A site's own robots.txt carries rules it depends
       * on, and serving ours instead would quietly drop them. If the origin has
       * no robots.txt, or is unreachable, the additions still stand on their
       * own rather than the whole request failing. */
      let origin = '';
      try {
        const res = await fetch(request);
        if (res.ok) origin = await res.text();
      } catch { /* origin unavailable: serve the additions alone */ }
      const merged = `${origin}\n# Citerank AI visibility — AI bot rules\n${stored}\n`;
      return new Response(merged, { headers: { 'content-type': sig.type, 'cache-control': 'no-store' } });
    }

    return new Response(stored, { headers: { 'content-type': sig.type, 'cache-control': 'no-store' } });
  },
};
