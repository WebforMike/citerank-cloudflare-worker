# Citerank Deploy — Cloudflare Worker

Publishes AI visibility signals for sites that are not on WordPress.

The Worker sits in front of your site and answers four paths from its own
storage. It never edits your origin, so reverting is exact: there is no previous
value to restore, because nothing was overwritten.

| Path | What it serves |
|---|---|
| `/llms.txt` | Replaced outright |
| `/robots.txt` | Your existing file, with AI bot rules appended |
| `/.well-known/a2a.json` | Replaced outright |
| `/.well-known/toolcatalog.json` | Replaced outright |

Every other request passes through untouched.

## Before you start

Your domain has to be on Cloudflare already, with its DNS proxied through them.
The Worker attaches to that zone. If the site is not on your Cloudflare account,
the deploy stops with a zone error.

## Deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/WebforMike/citerank-cloudflare-worker)

The button creates the Worker, provisions the `CITERANK_KV` namespace, and asks
you for `CITERANK_KEY`. Paste the key Citerank showed you when you generated the
client. It is shown once.

Two things remain after it finishes:

1. **Add the route.** In the Cloudflare dashboard open the Worker, then
   Settings, then Domains & Routes, and add a route covering the whole site:
   `example.com/*`. The whole site, not just the four paths above: `/robots.txt`
   is merged with whatever your origin already serves, so the Worker has to be
   able to reach the origin through the same route.
2. **Connect the site in Citerank**, using the same key.

## Deploy by hand instead

Needs Node, then:

```
npm install -g wrangler
wrangler login

wrangler kv namespace create CITERANK_KV     # older wrangler: kv:namespace create
# paste the printed id into the id = "" line in wrangler.toml

wrangler secret put CITERANK_KEY             # paste the key, it is not echoed
wrangler deploy
```

Then add the route and connect the site, as above.

If `wrangler secret put` says no Worker of that name exists yet, answer yes to
create it, or run `wrangler deploy` first and set the secret after.

## Updating to a newer version

The Worker does not update itself. Once it is deployed it keeps running the
version you deployed, so a fix published here does not reach your site until you
redeploy.

Check which version you are running:

```
curl -H "X-Citerank-Key: YOUR_KEY" https://example.com/citerank/v1/status
```

The `version` field in the response is the one deployed on your site. Compare it
with the `version` near the top of `cloudflare-worker.js` in this repository.

To update, redeploy the current code. Nothing else changes: your KV namespace,
your key and your route are all preserved, and the signals you have deployed
stay exactly as they are. The Worker stores those in KV, and redeploying the
code does not touch stored values.

**If you deployed with the button:** click Deploy to Cloudflare again and pick
the same Worker name (`citerank-deploy`). It redeploys over the existing Worker.

**If you deployed with wrangler:** pull the newer `cloudflare-worker.js` into
your folder, keeping your own `wrangler.toml` with its namespace id and route,
then run `wrangler deploy` again. There is no need to recreate the namespace or
set the secret a second time.

## What it does not do

Site-level signals only. Per-page schema needs a platform that can address
individual pages, so it is refused by this client with a clear reason rather
than accepted and silently dropped.

## Checking it works

With the key, against your own domain:

```
curl -H "X-Citerank-Key: YOUR_KEY" https://example.com/citerank/v1/status
curl -H "X-Citerank-Key: YOUR_KEY" https://example.com/citerank/v1/preflight
```

`status` lists the signals this client supports. `preflight` reports whether
`CITERANK_KV` is bound. If either returns your site's own 404 page rather than
JSON, the route is not covering the Worker.

## Source

`cloudflare-worker.js` is published from Citerank's own repository and is
byte-identical to the file the app serves. It is checked on every build, so the
code here is the code that was tested.
