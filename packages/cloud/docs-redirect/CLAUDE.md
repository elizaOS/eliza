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

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root PR_EVIDENCE.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[PR_EVIDENCE.md](../../../PR_EVIDENCE.md)**. Read it.
> Nothing in this package is *done* until it is *proven* done — a reviewer must confirm it
> works **without reading the code**, from the artifacts you attach. This applies to **every**
> feature, fix, refactor, and chore here. "Tests pass" is not proof; "CI is green" is not proof.

- **Record AND read model trajectories.** Capture the *actual* inputs and outputs of the model
  from a **live** LLM — not the deterministic proxy, not a mock: the prompt, the
  providers/context, the raw model output, every tool/action call, and the result. Then **open
  the trajectory and review it by hand.** A captured-but-unread trajectory is not evidence
  (`packages/scenario-runner/bin/eliza-scenarios run <scenario> --report <out>`).
- **Real, full-featured E2E — no larp.** Every feature ships detailed end-to-end tests that
  drive the *real* path end to end. Not the happy "front door" only: cover error paths,
  edge/empty/invalid input, concurrency, roles/permissions, and adversarial input. A test that
  asserts against a mock/stub/fixture standing in for the thing under test **does not count**.
  If the real model/device/chain/connector/account is hard to reach, **make it reachable — that
  is the work**, not an excuse to mock. If the existing tests here are shallow or mocked, fixing
  them is part of your change.
- **Screenshots + logs at every phase**, plus a **complete walkthrough video/run-through** of
  the entire feature or view, start to finish (`bun run test:e2e:record`).
- **Manually review every artifact the change touches** — never just the green check: client
  logs (console + network), server logs (`[ClassName] …`), the model trajectories in and out,
  before/after full-page screenshots, **and the domain artifacts listed below for this package.**
- **No residuals. No shortcuts.** The goal is not "done" — it is *everything* done. Clear every
  blocker by the **hard path**: build the real architecture, stand up the real
  model/device/service, actually test it. Never leave a TODO, a stub, a stepping-stone, or a
  "follow-up." When unsure, research thoroughly, weigh the options, and ship the best,
  highest-effort, production-ready version. Keep going until every possibility is exhausted.

Artifacts → attached inline in the PR (MP4 video, JPG screenshots, logs in `<details>`); attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — cloud backend / security:**
- Real request → response traces against the local cloud stack (`bun run cloud:mock`) hitting real endpoints, plus the structured backend logs.
- The **DB state** the change produced/changed (Drizzle rows), billing/usage records, and migration up **and** down.
- Auth/role-gating and multi-tenant isolation proven by test, including the denied-access paths (see #9853/#9948) — not assumed.
- The agent trajectory for any model-backed endpoint.
<!-- END: evidence-and-e2e-mandate -->
