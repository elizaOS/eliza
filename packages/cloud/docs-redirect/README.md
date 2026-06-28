# docs-elizacloud-redirect

Tiny Cloudflare Worker that owns the `docs.elizacloud.ai` hostname and 301s
every request to the unified docs site at `docs.elizaos.ai/cloud/*`.

Path and query are preserved; a legacy `/docs/` prefix is stripped.

## Deploy

```bash
bun install
bun run --cwd packages/docs-elizacloud-redirect deploy
```

The route binding (`docs.elizacloud.ai/*` on the `elizacloud.ai` zone) is
declared in `wrangler.toml` under `[env.production]`, so the deploy attaches
the worker to that hostname directly — no Cloudflare dashboard step required
beyond the one-time DNS record that points `docs.elizacloud.ai` at the
Cloudflare proxy (orange-cloud A/AAAA/CNAME).
