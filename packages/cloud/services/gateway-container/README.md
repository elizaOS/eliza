# Cloudflare gateway hosting

Hosts the existing webhook and Discord gateway images. Their authentication,
consent, receipt, queue, and leader-lease implementations remain authoritative.
State still uses the configured external store; this wrapper does not retire Redis.

Use `cloudflare/wrangler.toml` with `webhook-staging`, `webhook-production`,
`discord-staging`, or `discord-production`. Deployments start inactive.
Set `GATEWAY_RUNTIME_CONFIG` as one JSON secret containing the running process's
string-valued settings. Preserve all keys and delivery flags. State endpoints
must be reachable from Cloudflare. Supply the exact runtime source as `BUILD_ID`.

Before activation, verify the image and configuration, then stop and drain the
old gateway. Deploy with `GATEWAY_ENABLED=true`. Verify health, authenticated
routing, provider callbacks, and retained receipts before retiring the old host.
Every later active deployment must also set this flag.

For rollback, deploy with `GATEWAY_ENABLED=false`. The next request or cron sends
SIGTERM. Observe the container's stopped state before starting another writer;
a 503 response alone does not prove that shutdown finished.
