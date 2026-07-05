# @feed/root — Feed social simulation game

Feed is a satirical prediction market game powered by autonomous AI agents. This directory is a self-contained monorepo nested inside the elizaOS repo; it is **not** an `@elizaos/*` package. It has its own workspace, packages, apps, scripts, and DB schema.

## Purpose / role

Feed runs a live social simulation where players and autonomous AI agents trade on prediction markets alongside LLM-driven NPCs. The game engine generates satirical social posts, breaking news, and market events every minute. Feed integrates with elizaOS via its `packages/agents` elizaOS plugin wiring (`feedPlugin`, `plugin-autonomy`, `plugin-experience`, `plugin-agent-core`, `plugin-trajectory-logger`). External Eliza agents connect via A2A or MCP protocols.

## Layout

```
packages/feed/
  apps/
    web/          Next.js 16 — UI, API routes, SSE, cron endpoints
    cli/          Bun CLI: db, game, agent commands (entry: apps/cli/src/index.ts)
    mobile/       Capacitor mobile shell
    dag-visualizer/ Visual DAG explorer for tick data flow (port 4000)

  packages/
    engine/       Game engine: tick orchestration, FeedGenerator, GameWorld,
                  GameGenerator, LLM client, prompts
    core/         Pure domain: prediction markets, perpetuals, pricing, CPMM
    db/           Drizzle ORM schema, migrations, lazy DB client
    api/          Steward JWT middleware, user provisioning, rate limiting
    agents/       Autonomous agent logic, elizaOS plugins (feedPlugin etc.), cron
      src/plugins/
        feed/                 Main feedPlugin (elizaOS Plugin)
        plugin-agent-core/    Agent core capabilities
        plugin-autonomy/      Autonomous NPC trading/posting behaviors
        plugin-experience/    Experience/points system
        plugin-trajectory-logger/ Trajectory recording
        plugin-user-core/     User coordinator plugin (limited read-only actions)
    contracts/    On-chain contract ABIs, deployments, and bootstrap scripts
    shared/       Shared types, content analysis utilities, logging
    a2a/          Agent-to-Agent protocol integration (@a2a-js/sdk)
    mcp/          Model Context Protocol server for tool-using agents
    pack-default/ Default NPC and organization content pack
    sim/          Standalone simulation CLI
    testing/      Shared test utilities, integration helpers
    examples/     Example agents, local A2A server, training harness

  scripts/        Operational scripts — context inspection, market reports, DB seeds
  docs/           Vendor docs, analysis docs, observability notes
  skills/         Runtime skill packages
  tools/          Developer tooling (chroma, dag-visualizer, e2e)
  .ruler/         Ruler config — generates CLAUDE.md/AGENTS.md; edit here, not in files
```

## Key exports / surface

The elizaOS integration lives entirely in `packages/agents/src/`:

- `feedPlugin` — main elizaOS `Plugin` object; registers actions, providers, and services for feed trading
- `initializeFeedPlugin` / `initializeAgentA2AClient` — bootstrap helpers
- `plugin-autonomy`, `plugin-agent-core`, `plugin-experience`, `plugin-trajectory-logger` — elizaOS sub-plugins; each exports a `Plugin` object from its `src/index.ts`
- `ExternalAgentAdapter` — bridges external agents (A2A / MCP) into the Feed runtime

The `packages/engine` exports `FeedGenerator`, `GameWorld`, `GameTick`, and the LLM client. The `packages/core` exports prediction market and perpetuals domain logic.

## Commands

All commands run from `packages/feed/` (this directory):

```bash
bun run dev                # Start web + cron simulator + Docker services
bun run dev:web            # Web only (no cron)
bun run build              # Production build (all packages)
bun run check              # Biome format + lint (auto-fix)
bun run test:unit          # Unit tests (no DB)
bun run test:integration   # Integration tests (requires Postgres + Redis)
bun run test:e2e           # Playwright end-to-end
bun run db:generate        # Generate Drizzle migration files
bun run db:migrate         # Apply migrations
bun run db:seed            # Seed initial game data
bun run db:studio          # Drizzle Studio DB browser
bun run env:validate       # Check required env vars before start
bun run inspect:context    # Inspect NPC/agent prompt context (see Dev Tools)
bun run report:markets     # Market diversity audit
bun run report:realism     # Market realism report
bun run ruler:apply        # Regenerate CLAUDE.md/AGENTS.md from .ruler/
```

## Config / env vars

See `.env.example` for the full annotated list. Key vars:

| Group | Variables |
|-------|-----------|
| Database | `DATABASE_URL`, `DIRECT_DATABASE_URL`, `DATABASE_READ_REPLICA_URL`, `DATABASE_POOL_MAX` |
| Auth (Steward) | `STEWARD_JWT_SECRET`, `STEWARD_TENANT_API_KEY`, `NEXT_PUBLIC_STEWARD_API_URL`, `STEWARD_API_URL` |
| LLM | `ELIZACLOUD_API_KEY`, `GROQ_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` (at least one required) |
| Cache | `REDIS_URL` |
| Storage | `BLOB_READ_WRITE_TOKEN` (Vercel Blob; MinIO locally) |
| Game | `GAME_START=true`, `CRON_SECRET` |
| Agents | `FEED_A2A_API_KEY` |

LLM inference defaults to ElizaCloud (`ELIZACLOUD_API_KEY`), falls back to Groq → Anthropic → OpenAI.

Docker services (started by `bun run dev`): Postgres `:5433`, Redis `:6380`, MinIO `:9000/:9001`, Steward auth `:3200`.

## Dev tools

```bash
# Inspect what context an NPC or agent receives before an LLM call
bun run inspect:context -- --npc ailon-musk --type trading --raw
bun run inspect:context -- --agent <userId> --raw
bun run inspect:context -- --npc all --summary

# Market diversity (topic clustering, duplicates, timeframe balance)
bun run report:markets
bun run report:markets -- --verbose
bun run report:markets -- --history 7

# Prompt diff between two versions
bun scripts/prompt-diff.ts \
  --old "git:HEAD~1:packages/engine/src/prompts/trading/npc-market-decisions.ts" \
  --new packages/engine/src/prompts/trading/npc-market-decisions.ts
```

## How to extend

**Add an elizaOS plugin:** create a new directory under `packages/agents/src/plugins/`, implement and export a `Plugin` object from `src/index.ts`, then re-export from `packages/agents/src/index.ts`.

**Add a game action in feedPlugin:** edit `packages/agents/src/plugins/feed/` — add the action to the plugin's `actions` array following the existing pattern.

**Add an API route:** route handlers live in `apps/web/src/app/api/`. Domain logic must stay in `packages/`; the route is wiring only (validate → call service → return response).

**Add a Drizzle table:** add the schema in `packages/db/`, then `bun run db:generate` + `bun run db:migrate`.

**Add a prompt:** add the template in `packages/engine/src/prompts/`, then use `bun scripts/prompt-diff.ts` to verify rendering.

## Conventions / gotchas

- **This is not an `@elizaos/*` package.** The npm name is `@feed/root` and all internal packages use the `@feed/` scope. Do not publish or import from `@elizaos/` unless explicitly integrating with upstream elizaOS packages.
- **Ruler manages CLAUDE.md and AGENTS.md.** These files are generated from `.ruler/`. Edit `.ruler/**` and run `bun run ruler:apply` — never hand-edit CLAUDE.md or AGENTS.md directly (changes will be overwritten).
- **Default branch is `staging`**, not `main`.
- **Root quality gates are real.** `bun run lint` runs Biome in check mode and `bun run typecheck` typechecks the stable `packages/shared`, `packages/contracts`, `packages/db`, `packages/core`, `packages/engine`, `packages/sim`, `packages/agents`, `packages/api`, `packages/a2a`, `packages/mcp`, the `packages/testing` public surface, `apps/cli`, the `apps/mobile` native shell, and `apps/web` roots. `bun run check` remains the auto-fix format/lint command.
- **DB connections are lazy**: client objects are created only when the first query executes, not at import time. Prefer `DATABASE_URL` (pooled) in production; use `DIRECT_DATABASE_URL` only for migrations.
- **No network/LLM calls inside `db.transaction()`** — transactions must be short to avoid lock escalation.
- **Architecture rule**: `apps/* → packages/* → packages/contracts` — domain logic never imports from app or infra layers.

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root PR_EVIDENCE.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[PR_EVIDENCE.md](../../PR_EVIDENCE.md)**. Read it.
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

**Capture & manually review for this package — storage / memory:**
- The actual rows / embeddings / documents written **and read back**, with their shape inspected — not a mock asserting itself.
- Query correctness: precision/recall on real data, ordering, pagination, and migration up/down.
- GC/retention, concurrency, and large-payload paths.
- A trajectory showing memory/knowledge actually recalled into a turn, where relevant.
<!-- END: evidence-and-e2e-mandate -->
