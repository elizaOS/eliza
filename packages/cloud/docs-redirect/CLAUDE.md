# @elizaos/docs-elizacloud-redirect

Cloudflare Worker that 301-redirects every request on `docs.elizacloud.ai` to the unified elizaOS docs site at `docs.elizaos.ai/cloud/*`.

## Purpose

This is a standalone infrastructure package — not an elizaOS plugin and not imported by any other package. It owns the `docs.elizacloud.ai` hostname via a Cloudflare Worker route and ensures old Eliza Cloud documentation links stay permanently redirected to the canonical location. Path, query string, and deep links are preserved; a legacy `/docs/` prefix is stripped.

## Layout

```
packages/docs-elizacloud-redirect/
  src/worker.ts        Entry point — the entire Worker (one fetch handler, ~25 lines)
  wrangler.toml        Cloudflare Worker config: route binding for docs.elizacloud.ai/*
  package.json         Three scripts: test + dev + deploy
```

## Key logic (`src/worker.ts`)

- `TARGET_ORIGIN = "https://docs.elizaos.ai"`, `TARGET_PREFIX = "/cloud"`.
- Incoming path transformations:
  - `/docs/<rest>` → `/cloud/<rest>` (legacy prefix stripped)
  - `/docs` → `/cloud`
  - `/` → `/cloud`
  - anything else → `/cloud<path>`
- Query string (`url.search`) appended unchanged.
- Returns `Response.redirect(location, 301)` — permanent, no state, no KV, no bindings.

## Commands

```bash
bun run --cwd packages/docs-elizacloud-redirect dev     # wrangler local dev server
bun run --cwd packages/docs-elizacloud-redirect deploy  # deploy to Cloudflare (production env)
bun run --cwd packages/docs-elizacloud-redirect test    # vitest run
```

`deploy` targets `[env.production]` in `wrangler.toml`, which binds the route `docs.elizacloud.ai/*` on the `elizacloud.ai` zone automatically — no Cloudflare dashboard step beyond the one-time DNS record pointing `docs.elizacloud.ai` at the Cloudflare proxy.

## Config / env vars

No runtime env vars or secrets. All config is static in `wrangler.toml`:

| Key | Value |
|-----|-------|
| `main` | `src/worker.ts` |
| `compatibility_date` | `2025-09-01` |
| `workers_dev` | `false` |
| Production route | `docs.elizacloud.ai/*` on zone `elizacloud.ai` |

Wrangler picks up `CLOUDFLARE_API_TOKEN` from the environment (or `~/.wrangler/config`) for deploy auth — standard Wrangler behaviour, not package-specific.

## How to extend

The worker is intentionally trivial. If redirect rules change:

1. Edit `TARGET_ORIGIN` or `TARGET_PREFIX` in `src/worker.ts`.
2. Add path-rewrite logic inside the `fetch` handler before the `Response.redirect` call.
3. To add a second route (e.g. a different hostname), add another entry to `routes` in `wrangler.toml` under `[env.production]`.

## Gotchas

- `private: true` — never published to npm; deploy-only via Wrangler.
- No TypeScript compilation step; Wrangler bundles `src/worker.ts` directly via esbuild.
- `workers_dev = false` means `wrangler deploy` without `--env production` deploys nothing to a `*.workers.dev` URL. Always pass `--env production` (the `deploy` script does this).
- No tests. The logic is two conditionals; verify correctness by reading `src/worker.ts` or running `bun run dev` and inspecting redirects locally with `curl -I`.
