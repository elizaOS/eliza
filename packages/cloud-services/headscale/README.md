# headscale (Eliza Cloud customer-tunnel coordination server)

Self-hosted [headscale](https://github.com/juanfont/headscale) deployment used as Tailscale's coordination server for customer tunnels sold by `@elizaos/plugin-elizacloud`. The same headscale instance also coordinates internal agent containers; the two cohabit through ACL-tag isolation.

## Tag namespaces (load-bearing safety boundary)

| Tag | Used by | Reach |
|---|---|---|
| `tag:agent` | Internal agent containers (set in [`headscale-integration.ts`](../../packages/lib/services/headscale-integration.ts:57)) | Internal services only — must NOT reach customer tunnels. |
| `tag:eliza-tunnel` | Customer tunnel sessions minted by [`auth-key/route.ts`](../../apps/api/v1/apis/tunnels/tailscale/auth-key/route.ts) | The reverse proxy and the customer's own node. Cross-customer routing is enforced by the proxy lookup layer. |
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

## Deploy on Railway

1. Create a new Railway service in the `cloud` project from this directory. The Dockerfile downloads the pinned `headscale` v0.28.0 Linux release binary; verify the latest stable release before bumping it.
2. Mount a Railway volume at `/var/lib/headscale` for the SQLite DB (or attach Railway PG and switch the config to `database.type: postgres`).
3. Deploy the Dockerfile. It copies `config.yaml` and `acl.hujson` into `/etc/headscale`.
4. Expose port `8080` as a public TCP/HTTP port. Bind a custom domain like `headscale.elizacloud.ai` in Railway's Networking tab.
5. Set the Worker config so the API can talk to it. Public URLs and user names live in `apps/api/wrangler.toml`; `HEADSCALE_API_KEY` remains a Wrangler secret.
6. Inside the running container, create the two users that the API expects:
   ```sh
   headscale users create agent
   headscale users create tunnel
   ```
7. Mint the API key:
   ```sh
   headscale apikeys create --expiration=8760h
   ```
   Store the returned key as `HEADSCALE_API_KEY` and rotate annually.

## Local dev

A `docker-compose.yml` for headscale is intentionally NOT included in `cloud/docker-compose.yml` — local dev uses the `tag:agent` flow only and doesn't touch customer-tunnel pricing. To exercise customer tunnels locally, point `HEADSCALE_API_URL` at a development instance you stand up by hand.
