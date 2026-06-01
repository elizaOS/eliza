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
    shared/       Shared types, content analysis utilities, logging
    a2a/          Agent-to-Agent protocol integration (@a2a-js/sdk)
    mcp/          Model Context Protocol server for tool-using agents
    training/     RL pipeline, ScamBench harness, HF/W&B integration
    pack-default/ Default NPC and organization content pack
    sim/          Standalone simulation CLI
    testing/      Shared test utilities, integration helpers
    examples/     Example agents, local A2A server, training harness

  scripts/        Operational scripts — context inspection, market reports, DB seeds
  docs/           Vendor docs, analysis docs, observability notes
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
| Cache | `REDIS_URL`, `KV_REST_API_URL` |
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
- **`typecheck` and `lint` are no-ops** in the root package.json (they echo "skip (feed)"). Run typechecking per-package or via the build step.
- **DB connections are lazy**: client objects are created only when the first query executes, not at import time. Prefer `DATABASE_URL` (pooled) in production; use `DIRECT_DATABASE_URL` only for migrations.
- **No network/LLM calls inside `db.transaction()`** — transactions must be short to avoid lock escalation.
- **Architecture rule**: `apps/* → packages/* → packages/contracts` — domain logic never imports from app or infra layers.
