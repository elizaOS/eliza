# Phase 4 — Worker Compatibility Audit for `plugin-workflow`

**Status: BLOCKED. Phase 4 stops at the audit per AGENTS.md "If audit reveals a blocker, stop and report".**

The audit covers `plugins/plugin-workflow/src/services/embedded-workflow-service.ts` (2018 lines) plus the supporting modules under `plugins/plugin-workflow/src/`. Findings are split into per-API verdicts (resolvable) and architectural blockers (not resolvable in 60 minutes without crossing the hard-rules line).

---

## 1. Per-API Compatibility (resolvable)

| API surface | Where | Worker verdict | Mitigation |
| --- | --- | --- | --- |
| `import { createHash, randomUUID } from 'node:crypto'` | `embedded-workflow-service.ts:1`, `trigger-routes.ts` | **OK** with `nodejs_compat` (already enabled in `cloud/apps/api/wrangler.toml` `compatibility_flags = ["nodejs_compat"]`). `randomUUID` is also a Workers global. | None needed. |
| `setInterval` / Phase-0 timers | None remaining in the service. Only one `setTimeout` (line 934) inside a `Wait` node `await new Promise(r => setTimeout(r, ms))`. | **OK.** Workers support `setTimeout` inside a single request/scheduled handler (subject to CPU-time + duration limits). | None. |
| `node:fs`, `node:net`, `node:dgram`, `node:child_process` | **Not used** anywhere in `plugin-workflow/src/` (verified with grep). | **OK.** | None. |
| `quickjs-emscripten` (Code-node sandbox) | Lazy `await import('quickjs-emscripten')` (~600 KB WASM) | **Likely OK.** Workers paid plan = 10 MB compressed bundle, free = 3 MB. QuickJS WASM compresses well; needs an actual `wrangler dev --dry-run` build to confirm. Marked as a follow-up risk, not a blocker. | If size becomes the issue: gate the Code node behind a capability flag (already designed via `requiresLongRunning`-style flags) and refuse to schedule it on the Worker. |
| `import type { NodePgDatabase } from 'drizzle-orm/node-postgres'` | `embedded-workflow-service.ts:4`, `workflow-credential-store.ts` | **OK at type level only.** It is `import type` plus a runtime cast (`db as NodePgDatabase`). Cloud already uses `@neondatabase/serverless` with Drizzle — a `NeonHttpDatabase` works against the same `pg-core` schema. The plugin reads `this.runtime.db`, so the host (Worker runtime builder) decides which Drizzle driver lives there. | The Worker would build the runtime with a `drizzle-orm/neon-http` instance pointed at whichever Postgres holds the agent's workflow tables. No plugin source change needed. |
| `node:http` types in route files | `plugin-routes.ts`, `routes/workflow-routes.ts` | **OK.** Type-only imports for in-process Eliza HTTP server; not needed in the Worker, which mounts its own Hono routes for webhooks. | Don't bundle the HTTP-route files into the Worker. |
| `setTimeout` in Wait node (line 934) | Wait node, used during a single execution | **Conditionally OK.** Workers' free plan: 30 s wall-clock per invocation. Wait nodes that exceed that fail. | Capability-flag long Waits as `requiresLongRunning` and refuse to execute them on the Worker. Already partially structured (Schedule trigger has `capabilities: { requiresLongRunning: true }`). |

**Per-API conclusion:** All individual API calls are resolvable on Workers with the existing `nodejs_compat` flag and the Drizzle Neon driver swap. No engine source change is required (consistent with the hard rule).

---

## 2. Architectural Blockers (not resolvable inside scope)

These are why I am stopping rather than shipping a half-thing.

### 2.1 The Worker has no database to query

`EmbeddedWorkflowService` reads workflow definitions, executions, credentials, and tags from `runtime.db`. Per Phase 0, scheduling lives in core's Task system, so the Worker's cron handler would call `taskService.runDueTasks()` — which itself calls `runtime.getTasks({ tags: ["queue"], agentIds: [this.runtime.agentId] })`.

In this codebase, **the agent's Postgres (which holds `embedded_workflows`, `embedded_executions`, `embedded_credentials`, `embedded_tags`, plus core's `tasks` table) lives on each Railway-hosted agent deployment**. Verified:

- `grep -rE "embedded_workflows|embedded_executions|embedded_credentials|embedded_tags" cloud/db/ cloud/packages/lib/` → **zero matches**. Cloud's central Neon DB does not host these tables.
- `cloud/apps/api/v1/agents/[agentId]/workflows/route.ts:1-14` documents the model explicitly: cloud is a *proxy* — `proxyWorkflowRequest(agentId, orgId, ...)` forwards to a Railway agent identified via `elizaSandboxService`.

To run workflows in a Cloudflare Worker we would need one of:

1. **Move the four `embedded_*` tables into cloud's central Neon DB**, plus migrate the per-agent core `tasks` table for any workflow-driven task. Multi-tenant rewrite of the persistence boundary. Out of scope for Phase 4.
2. **Open per-tenant Postgres connections from the Worker into each Railway agent's DB** — requires those DBs to be reachable from Cloudflare egress, plus per-tenant credential management. Architecturally identical to "everyone runs on cloud's DB" once you tally the security work.
3. **Have the Worker call back into the agent over HTTP to drive `runDueTasks`**. Defeats the point — Phase 4's stated rationale is "useful for short-lived cron-triggered work where the Railway hop is overhead", but this design *is* the Railway hop.

None of (1)/(2)/(3) is the kind of "move two files" change Phase 4 is sized for.

### 2.2 The Worker has no fully-realized `IAgentRuntime`

`EmbeddedWorkflowService.executeWorkflow` ultimately runs nodes that, in the Phase 0 design, can call `useModel`, `composeState`, `createMemory`, `getService(...)`, etc. — the AI nodes especially. The Worker would need to construct a real `IAgentRuntime` with character config, model providers, message manager, evaluators, plus *every plugin the workflow's nodes reference* (HTTP, code, AI, etc.).

The cloud Worker currently stubs `@elizaos/core` and `@elizaos/plugin-sql` at bundle time (`cloud/apps/api/wrangler.toml:27-30`) precisely because *the agent runtime doesn't run in the Worker* — it runs on the Railway sidecar (`cloud/INFRA.md`). Reversing that stub for the workflow runner means either:

- Building a parallel "lite" runtime that satisfies just the Task/Workflow surface — but workflow nodes call into model providers and services at execution time, so "lite" creeps to "full" fast.
- Bundling the real runtime into the Worker — but the existing API Worker already explicitly stubs it out, and the runtime + its plugins blow past Worker bundle limits.

### 2.3 Per-workflow capability tagging does not exist

Phase 4 task wording says "Iterate tenants whose workflows are tagged Worker-safe". I grepped `capabilities:` across the plugin: only **one** node carries a capability flag (`Schedule Trigger → requiresLongRunning`). There is no per-workflow `workerSafe` boolean and no aggregation step that rolls node capabilities up to a workflow. Adding that would touch the engine — explicitly forbidden by Phase 4's hard rule "DO NOT modify embedded-workflow-service.ts".

### 2.4 Phase 4's "webhook entry" already exists in the Railway agent

Workflow webhooks today land at `cloud/apps/api/v1/agents/[agentId]/workflows/...` and proxy to the Railway agent. The agent already owns the `workflow.webhook` TaskWorker (Phase 0). Adding a Worker-side webhook entry that creates a task in *cloud's* DB does not help unless the workflow runner also runs on the Worker — see 2.1/2.2. So 2.1/2.2 are the gating blockers; the webhook handler is downstream of them.

---

## 3. Recommendation

**Do not build a Cloudflare Worker workflow runner against the current architecture.** The Phase 4 brief assumes a topology (cloud-side tenant runtime + workflows in cloud's DB) that this repo does not have — workflows are agent-local, the agent runtime runs on Railway, and the cloud Worker is intentionally a thin proxy.

If the goal is "execute short-lived cron workflows without the Railway hop", the realistic options are:

- **Option A — Hosted runner inside the Railway agent.** No change. The agent already serves cron via core's `TaskService` timer. Phase 4's saving (one HTTP hop) is small compared to the work above.
- **Option B — Cloud-side workflow runner with a shared workflow store.** Move `embedded_workflows`, `embedded_executions`, `embedded_credentials`, `embedded_tags`, and a workflow-scoped `tasks` partition into cloud's Neon DB. Rebuild a minimal runtime stub on the Worker that registers `workflow.run` + `workflow.webhook` task workers and runs only nodes whose `capabilities` are all Worker-safe. Reject (return 4xx + capability list) any workflow whose node set requires `requiresLongRunning | requiresInbound | requiresFs | requiresChildProcess | requiresNet`. This is a **multi-week** project across cloud DB schema, migration of existing per-agent workflow data, and runtime construction. It also requires per-workflow capability rollup, which is an engine change.
- **Option C — Durable Object workflow worker.** Cloudflare Durable Objects + Cron Triggers per tenant. Same data-locality problem as Option B; only the compute story changes.

All three exceed the "60 minutes, Phase 4" budget, and (B) and (C) require touching `embedded-workflow-service.ts` (forbidden) or building a parallel engine (drift risk, also forbidden by AGENTS.md "Do not keep both old and new paths").

---

## 4. What I did not build

Per the hard rule, I stopped after the audit:

- No `cloud/services/workflow-runner/src/index.ts` cron handler.
- No `wrangler.toml` for the runner.
- No HTTP webhook entry.
- No tests.

Only this `COMPAT.md` exists under `cloud/services/workflow-runner/`.

---

## 5. Verification commands run

- `wc -l plugins/plugin-workflow/src/services/embedded-workflow-service.ts` → 2018
- `grep -nE "^import|setInterval|node:fs|node:net|node:child_process|quickjs" plugins/plugin-workflow/src/services/embedded-workflow-service.ts`
- `grep -rE "node-postgres|drizzle-orm|neondatabase|d1-database|hyperdrive" plugins/plugin-workflow/src/ cloud/`
- `grep -rE "embedded_workflows|embedded_executions|embedded_credentials|embedded_tags" cloud/db/ cloud/packages/lib/` → empty
- `grep -nE "capabilities:\s*\{" plugins/plugin-workflow/src/services/embedded-workflow-service.ts` → one hit (Schedule Trigger)
- Inspected `cloud/apps/api/wrangler.toml`, `cloud/apps/api/v1/agents/[agentId]/workflows/route.ts`, `packages/core/src/services/task.ts:540-560`.
