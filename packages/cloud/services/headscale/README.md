# headscale (Eliza Cloud coordination server — ACL source of truth)

Self-hosted [headscale](https://github.com/juanfont/headscale) coordination
server for the Eliza Cloud tailnet. It coordinates internal agent containers
(`tag:agent`) and, historically, customer tunnels sold by
`@elizaos/plugin-elizacloud`; the tags cohabit through ACL-tag isolation.

Headscale runs on the **Hetzner control-plane VM** (see [`DEPLOY.md`](./DEPLOY.md)).
The previous Railway-hosted runtime was removed on 2026-06-17, along with its
`Dockerfile`, `entrypoint.sh`, `railway.toml`, `config.yaml`, and the
`cloud-headscale.yml` deploy workflow. This directory is now the committed source
of truth for the **ACL policy** (`acl.hujson`), which the Hetzner arm workflow
deploys to `/etc/headscale/acl.hujson`.

## Tag namespaces (load-bearing safety boundary)

| Tag | Used by | Reach |
|---|---|---|
| `tag:agent` | Internal agent containers (set in [`headscale-integration.ts`](../../shared/src/lib/services/headscale-integration.ts:57)) | Internal services only — must NOT reach customer tunnels. |
| `tag:eliza-tunnel` | Customer tunnel sessions minted by [`auth-key/route.ts`](../../api/v1/apis/tunnels/tailscale/auth-key/route.ts) | The reverse proxy and the customer's own node. Cross-customer routing is enforced by the proxy lookup layer. |
| `tag:eliza-proxy` | The public reverse proxy node | Customer tunnel HTTPS endpoints only. |

The exact ACL policy lives in `acl.hujson` next to this README. **Edit there, not in the headscale admin UI** — the file is committed and deployed.

Customer tunnel provisioning is gated by the Cloud API route
`POST /api/v1/apis/tunnels/tailscale/auth-key`. The route requires an Eliza
Cloud user or API key with an active organization, debits org credits once per
successful provisioning, mints a short-lived non-reusable key tagged
`tag:eliza-tunnel`, and returns a signed generated
`eliza-<org>-<random>-<expiry>-<signature>` hostname for the tunnel proxy. The
proxy rejects signed hostnames after their embedded expiry, so public tunnel
URLs do not become permanent reusable aliases.

## Deploy

Headscale is armed on the Hetzner control-plane VM by
`arm-headscale-control-plane.yml` / `packages/scripts/cloud/admin/arm-headscale-control-plane.mjs`,
which writes this directory's `acl.hujson` to the host, converges
`/etc/headscale/config.yaml`, ensures the `agent` and `tunnel` users, and
upserts the Worker-facing env. Full checklist + required GitHub Environment
values are in [`DEPLOY.md`](./DEPLOY.md). The `HEADSCALE_API_KEY` is generated on
the host and stored as a GitHub/Worker secret — never pasted into issues or
workflow inputs.

## Local dev

A `docker-compose.yml` for headscale is intentionally NOT included in `cloud/docker-compose.yml` — local dev uses the `tag:agent` flow only and doesn't touch customer-tunnel pricing. To exercise customer tunnels locally, point `HEADSCALE_API_URL` at a development instance you stand up by hand.
