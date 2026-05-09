# headscale (Eliza Cloud customer-tunnel coordination server)

Self-hosted [headscale](https://github.com/juanfont/headscale) deployment used as Tailscale's coordination server for customer tunnels sold by `@elizaos/plugin-elizacloud`. The same headscale instance also coordinates internal agent containers; the two cohabit through ACL-tag isolation.

## Tag namespaces (load-bearing safety boundary)

| Tag | Used by | Reach |
|---|---|---|
| `tag:agent` | Internal agent containers (set in [`headscale-integration.ts`](../../packages/lib/services/headscale-integration.ts:57)) | Internal services only — must NOT reach customer tunnels. |
| `tag:eliza-tunnel-<orgId>` | Per-customer tunnel sessions minted by [`auth-key/route.ts`](../../apps/api/v1/apis/tunnels/headscale/auth-key/route.ts) | The reverse proxy and the customer's own node. Cross-tag traffic is denied. |

The exact ACL policy lives in `acl.hujson` next to this README. **Edit there, not in the headscale admin UI** — the file is committed and deployed.

## Deploy on Railway

1. Create a new Railway service in the `cloud` project. Image: `headscale/headscale:0.26-stable` (verify the latest stable tag before pinning).
2. Mount a Railway volume at `/var/lib/headscale` for the SQLite DB (or attach Railway PG and switch the config to `database.type: postgres`).
3. Copy `config.yaml` and `acl.hujson` into the service via Railway's "Files" tab or a small init container.
4. Expose port `8080` as a public TCP/HTTP port. Bind a custom domain like `headscale.elizacloud.ai` in Railway's Networking tab.
5. Set the Worker secrets so the API can talk to it:
   - `HEADSCALE_PUBLIC_URL=https://headscale.elizacloud.ai`
   - `HEADSCALE_API_URL=https://headscale.elizacloud.ai` (same URL inside Railway's private network if you wire one up)
   - `HEADSCALE_API_KEY=<key minted via 'headscale apikeys create'>`
   - `HEADSCALE_USER=tunnel`
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
