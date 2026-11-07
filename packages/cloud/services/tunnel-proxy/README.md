# Tunnel proxy

Go HTTP proxy for signed, tenant-scoped Eliza Cloud tunnel URLs over Headscale.
Keep hostname signatures, expiry checks, and tailnet isolation enforced.

Configure `HEADSCALE_PUBLIC_URL`, `TUNNEL_PROXY_TS_AUTHKEY`, `TUNNEL_PROXY_HOST`,
`TUNNEL_TAILNET_DOMAIN`, and `TUNNEL_HOSTNAME_SIGNING_SECRET` for the deployment.
When changing the public domain, set `TUNNEL_PROXY_HOST_ALIASES` to the explicit,
comma-separated previous hostnames. Both domains use the same signed, expiring
labels and tailnet. Route each configured wildcard to this proxy; do not add
another environment's domain.
Use the Go version in `go.mod`. Build and test from this directory:

```bash
go build ./...
go test ./...
```

`cloudflare/wrangler.toml` hosts the same proxy in a Cloudflare Container,
inactive until `TUNNEL_ENABLED=true`. Configure `TUNNEL_RUNTIME_CONFIG` with the
existing environment's string settings, preserving its hostname, tailnet, auth
key, and signing secret. Set `TSNET_STATE_URL` to that Worker's
`/internal/tsnet-state` endpoint and `TSNET_STATE_TOKEN` to its private bearer token.
The Go process uses this authenticated durable store when configured; failures do
not create a replacement identity or fall back to local disk.

Before activation, stop the original proxy and import its complete
`tailscaled.state` JSON map with `{operation:"import", sourceQuiesced:true, entries}`.
Keep this secret-bearing input out of logs and Git. Import requires an inactive
runtime, preserves binary values, and atomically rejects conflicting existing
state. An uninitialized store refuses runtime reads. Confirm the old process is
stopped before activation; confirm the new node identity and a signed tunnel
request before moving wildcard DNS. Deactivation sends SIGTERM; independently
verify shutdown before reactivating another owner. PostgreSQL is unaffected.

Use `bun run typecheck` and `bun run lint:check` for the Cloudflare host. The
Dockerfile builds the Go runtime; `railway.toml` remains for the source deployment
until the migration is accepted.
