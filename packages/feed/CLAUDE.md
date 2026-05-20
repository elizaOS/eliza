# Babylon — Agent & Developer Rules

> Single source of truth for all AI coding agents (Claude Code, Cursor, Codex, etc.) and human contributors.
> If you are reading `AGENTS.md`, it points here. Do not duplicate rules — edit this file.

## Quality Gate (run before every commit)

```bash
bun run check          # Biome format + lint (auto-fix)
bun run typecheck      # TypeScript across all packages
bun run lint           # Turbo lint (zero warnings required)
bun run test:unit      # Unit tests
```

Run integration tests when your changes touch DB/API:
```bash
bun run test:integration
```

Build before declaring done:
```bash
bun run build
```

## Architecture

### Dependency Direction

`apps/* → packages/* → packages/contracts`

- **Apps are wiring-only**: validate input → call service → map errors → return response.
- **Domain logic belongs in packages** and must stay framework-agnostic (no Next/React/Elysia imports in domain code).
- No circular dependencies between packages.

### Where to Put Code

| What | Where |
|---|---|
| Domain rules / game logic | `packages/engine`, `packages/agents` |
| Infra adapters (db/redis/http/sse/auth) | `packages/api`, `packages/db`, `packages/shared` |
| UI and route wiring | `apps/web` |
| Tests | `packages/testing` |
| Vendor docs | `docs/vendors/{vendor}` |

### State (current → target)

- **Current**: Next.js `apps/web` hosts UI + API routes + SSE + A2A. CLI in `apps/cli`. Domain in `packages/engine` and `packages/agents`.
- **Target**: Elysia host in `apps/server`, workers in `apps/daemon`, dedicated `apps/agents`, domain split into `packages/core/*`.

## Code Standards

- **Bun + TypeScript ESM**, 2-space indent, minimal changes.
- **No `any`**; avoid `unknown` (only as last resort, narrow immediately).
- **No broad `try/catch`**: catch only expected errors, map at boundaries. Fail fast otherwise.
- **Reuse before building**: search the codebase for existing patterns/utilities before adding new ones.
- **No invented behavior**: don't add fake placeholders or synthetic data. Build the real thing or leave a clear TODO.
- **Secrets**: never commit API keys, private keys, or tokens. Never log sensitive values.
- **Env hygiene**: new/changed env vars must be reflected in `.env.example` with required/optional + default notes.
- **Scope discipline**: don't fix unrelated lint/format issues or revert other WIP. Keep changes scoped to the task.
- **Documentation**: don't create new docs/READMEs unless requested. Update existing docs when behavior changes.

## Git Conventions

- Default branch: `staging` (not `main`).
- Commits: concise, imperative, prefixed (`feat:`, `fix:`, `chore:`, `refactor:`, `test:`, `docs:`).
- Always run `bun run check` before committing (Biome auto-fix).
- Run `bun run typecheck` and `bun run lint` before pushing.

## Testing

- Prefer **integration tests** for API/DB/infra flows (`packages/testing/integration`).
- Use **unit tests** for pure logic where they add confidence without heavy mocking (`packages/testing/unit`).
- Keep tests deterministic. Use fakes/stubs where appropriate, but avoid synthetic success paths.

## Commands Reference

| Task | Command |
|---|---|
| Install | `bun install` |
| Dev (full) | `bun run dev` |
| Dev (web only) | `bun run dev:web` |
| Format + lint fix | `bun run check` |
| Typecheck | `bun run typecheck` |
| Lint | `bun run lint` |
| Build | `bun run build` |
| Unit tests | `bun run test:unit` |
| Integration tests | `bun run test:integration` |
| DB generate | `bun run db:generate` |
| DB migrate | `bun run db:migrate` |
| DB seed | `bun run db:seed` |
| Vendor docs | `bun run docs:generate` |

## Tooling Notes

- Ruler (`.ruler/`) generates agent config files. After editing `.ruler/**`, run `bun run ruler:apply`.
- Prefer local vendor docs (`docs/vendors/`) before guessing APIs.

## Simulation Dev Tools

Use these tools when working on agent context, prompts, trading decisions, or market generation. They run against the live DB (no server needed) and give you immediate visibility into what agents actually see.

### Context Inspector

Inspect exactly what context an NPC or autonomous agent receives. Use this after modifying prompts, context assembly, or truncation logic to verify changes.

```bash
# NPC trading context (section breakdown, ghost vars, truncation stats)
bun run inspect:context -- --npc ailon-musk --type trading

# Full rendered prompt the NPC LLM would see
bun run inspect:context -- --npc ailon-musk --type trading --raw

# Autonomous agent context (uses MultiStepExecutor pipeline)
bun run inspect:context -- --agent <userId> --raw

# All NPCs aggregate stats
bun run inspect:context -- --npc all --summary
```

### Market Diversity Report

Audit the active prediction market pool for topic clustering, entity over-representation, near-duplicates, and timeframe balance. Use after modifying question generation or market creation.

```bash
bun run report:markets
bun run report:markets -- --verbose       # full question texts
bun run report:markets -- --history 7     # trend over 7 days
```

### Prompt Diff

Compare two prompt template versions rendered with the same context. Use when modifying any prompt in `packages/engine/src/prompts/`.

```bash
# Compare current vs previous git version
bun scripts/prompt-diff.ts \
  --old "git:HEAD~1:packages/engine/src/prompts/trading/npc-market-decisions.ts" \
  --new packages/engine/src/prompts/trading/npc-market-decisions.ts

# Section token table only
bun scripts/prompt-diff.ts --old file1.ts --new file2.ts --section-only
```

### Analysis Docs

- `docs/agent-context-analysis.md` — deep analysis of agent context gaps, what's been fixed, what's remaining
- `docs/stories-markets-analysis.md` — analysis of story/market repetition issues
- `docs/dev-tools-plan.md` — dev tools roadmap and implementation plan

## Production database (scale / locks)

Indexes and query shape are necessary but **not sufficient**: you cannot prove every query is safe without **runtime** evidence (`EXPLAIN (ANALYZE)`, `pg_stat_statements`, load tests). Code review alone does not scale to millions of users.

**What actually prevents “one query takes the site down”:**

- **Short transactions** — hold locks for the minimum work; no network/LLM calls inside `db.transaction()`.
- **Pool + DB limits** — app pool (`DATABASE_POOL_MAX`, etc. in `.env.example`) must stay below Postgres `max_connections` (account for PgBouncer multipliers, replicas, workers). Defaults use **small per-process pools** for high fan-out (many serverless/workers) against Neon’s pooled (~10k) / direct (~4k) caps; prefer pooled `DATABASE_URL` in prod and tune `DATABASE_POOL_MAX` from metrics.
- **Session guardrails** — in production, `packages/db` sets Postgres `statement_timeout`, `lock_timeout`, and `idle_in_transaction_session_timeout` on new connections (tunable via env). This caps runaway queries and fails lock waits instead of piling up.
- **DDL** — `CREATE INDEX` on large tables blocks writes unless built **`CONCURRENTLY`** (hand-roll a migration for huge tables; Drizzle defaults are blocking). Note: migrations 0055/0056 use blocking indexes; acceptable for current table sizes (<100k rows) but must be rewritten with `CONCURRENTLY` before scaling. To use `CONCURRENTLY`, create a manual migration outside a transaction since concurrent index builds cannot run inside transactions. **TODO: Track issue to rewrite 0055/0056 with CONCURRENTLY before tables exceed 100k rows.**
- **Observability** — enable `pg_stat_statements`, watch `pg_locks` / `pg_stat_activity`, set alerts on slow queries and connection saturation.
- **Read path** — route read-heavy, latency-tolerant queries through **`DATABASE_READ_REPLICA_URL`** when configured. **Replication lag caveat**: reads immediately after writes may return stale data; use the primary (`dbWrite`) for read-after-write consistency (e.g., fetching a record just created/updated). **TODO: Consider adding `readAfterWrite()` helper utility for cases requiring read-your-writes consistency.**

**Lazy Connection Creation**: Database client objects are created lazily - only when queries execute, not during property access. This optimizes cold start performance for read-only routes. With `DATABASE_READ_REPLICA_URL` configured, reads never create write client objects. The fallback to primary (when no replica) is also lazy, deferring client creation until query execution.

Treat every new high-volume query as guilty until measured under production-like data volume.
