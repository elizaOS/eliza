# @elizaos/plugin-workflow

In-process workflow engine: generate and run automation workflows from natural language inside an Eliza agent.

## Purpose / role

Adds workflow automation capabilities to an Eliza agent. Given a natural-language prompt, the plugin runs a RAG pipeline (keyword extraction → node catalog search → LLM generation → validate/repair → deploy) to produce and immediately activate a runnable workflow. Execution happens in-process via the `EmbeddedWorkflowService`; there is no external sidecar. The plugin is **default-enabled** (opt-out with `workflow.enabled: false` in agent config).

## Plugin surface

### Actions

| Name | Description |
|---|---|
| `WORKFLOW` | Umbrella action for all workflow lifecycle ops. Dispatches on `action` parameter: `create`, `modify`, `activate`, `deactivate`, `toggle_active`, `delete`, `executions`. Requires `minRole: OWNER`. Active in contexts `general`, `automation`, `tasks`, `agent_internal`. |

### Providers

| Name | Description |
|---|---|
| `workflow_status` | Lists each user's workflows with last execution status. Contexts: `automation`, `connectors`. `minRole: ADMIN`. Cache scope: `turn`. |
| `ACTIVE_WORKFLOWS` | Lists active/inactive workflows for LLM context (IDs, names, node counts), or searches the user's workflows when the current message is workflow-related. Contexts: `general`, `automation`, `tasks`, `connectors`. `minRole: ADMIN`. Cache scope: `turn`. |
| `PENDING_WORKFLOW_DRAFT` | Surfaces an in-flight draft so the agent routes confirmation/cancellation messages to `WORKFLOW` instead of `REPLY`. Contexts: `automation`, `connectors`. `minRole: ADMIN`. Cache scope: `conversation`. |

### Services

| Service type | Class | Description |
|---|---|---|
| `workflow` | `WorkflowService` | Orchestrates the RAG generation pipeline and CRUD. Public surface used by the `WORKFLOW` action. |
| `embedded_workflow_service` | `EmbeddedWorkflowService` | In-process execution engine: runs node graphs, manages scheduler, handles webhooks, persists to Postgres. |
| `workflow_credential_store` | `WorkflowCredentialStore` | DB-backed `(userId, credType) → credential ID` mapping; purges on `connector_disconnected` event. |
| `WORKFLOW_DISPATCH` | (registered in `init`) | Thin dispatch service. Trigger tasks with `kind: "workflow"` call `runtime.getService("WORKFLOW_DISPATCH").execute(workflowId)` to fire a workflow without going through the agent action layer. |

### Routes

Two registration paths, two URL shapes:

**`rawPath` routes** (`src/plugin-routes.ts`, `workflowRoutePlugin`) — registered with the app-route-plugin-registry (`@elizaos/plugin-workflow:routes`) via the side-effect import of `./register-routes` in `src/index.ts`. These mount verbatim at `/api/workflow/*` (and `/api/automations`):

- `GET/POST /api/workflow/workflows` — list / create
- `POST /api/workflow/workflows/generate` — generate a draft from a prompt
- `POST /api/workflow/workflows/resolve-clarification` — resolve a pending clarification
- `GET/PUT/DELETE /api/workflow/workflows/:id` — CRUD
- `POST /api/workflow/workflows/:id/activate|deactivate`
- `GET /api/workflow/workflows/:id/executions`
- `GET /api/workflow/status` — engine + plugin status
- `POST /api/workflow/runtime/start` — lifecycle compat
- `GET /api/automations` — cross-cutting view (workflows + triggers + tasks + draft conversations)

**Standard plugin routes** (`src/routes/index.ts`, on the plugin's `routes` field). The runtime prefixes non-`rawPath` paths with the plugin name (`workflow`), so these mount at `/workflow/*`:

- `GET /workflow/executions` · `/workflow/executions/:id`
- `GET /workflow/nodes` · `/workflow/nodes/available` · `/workflow/nodes/:type`
- `POST /workflow/workflows/validate`
- `GET/POST/PUT/PATCH/DELETE /workflow/webhooks/:path` — trigger-node webhooks

### DB schema

Five Drizzle tables under `src/db/schema.ts`, exported as `workflowSchema`:
`embeddedWorkflows`, `embeddedExecutions`, `embeddedCredentials`, `embeddedTags`, `credentialMappings`.

## Layout

```
plugins/plugin-workflow/
  auto-enable.ts              autoEnableModule — shouldEnable() opt-out check
  src/
    index.ts                  Plugin definition + init: registers WORKFLOW_DISPATCH
    register-routes.ts        Side-effect: registers route plugin with app-route-registry
    plugin-routes.ts          Route plugin object (workflowRoutePlugin)
    trigger-routes.ts         Trigger route helpers and type exports
    actions/
      workflow.ts             WORKFLOW action + all op handlers
    services/
      workflow-service.ts     WorkflowService — RAG pipeline + CRUD facade
      embedded-workflow-service.ts  EmbeddedWorkflowService — in-process execution engine
      workflow-credential-store.ts  WorkflowCredentialStore
      workflow-dispatch.ts    WORKFLOW_DISPATCH service registration helper
      smithers-runtime.ts     Smithers orchestrator adapter
    providers/
      workflowStatus.ts       workflow_status provider
      activeWorkflows.ts      ACTIVE_WORKFLOWS provider
      pendingDraft.ts         PENDING_WORKFLOW_DRAFT provider
    routes/
      workflows.ts            Workflow CRUD handlers
      executions.ts           Execution query handlers
      nodes.ts                Node catalog query handlers
      validation.ts           Workflow validation endpoint
      automations.ts          /api/automations combined view
      embedded-webhooks.ts    Webhook trigger handlers
      workflow-routes.ts      Central route dispatcher
      _helpers.ts             Shared route helper utilities
    db/
      schema.ts               Drizzle schema (5 tables)
    types/
      index.ts                WorkflowDefinition, WorkflowExecution, error classes, service-type constants
      workflow-contracts.ts   n8n-style node contract types (INode, INodeProperties, INodeTypeDescription, INodeCredentials, IWorkflowSettings)
    data/
      defaultNodes.json       Bundled node catalog (node type definitions)
      schemaIndex.json        Node parameter schemas
      triggerSchemaIndex.json Trigger node schemas
    utils/                    generation, validateAndRepair, credentialResolver, catalog, etc.
      workflow-prompts/       LLM prompt templates (keywordExtraction, feasibility, draftIntent, workflowGeneration, workflowMatching, fieldCorrection, parameterCorrection, actionResponse)
    lib/                      automations-builder, automations-types, workflow-clarification
    schemas/                  LLM structured-output schemas (keywordExtraction, feasibility, draftIntent, workflowMatching)
```

## Commands

```bash
bun run --cwd plugins/plugin-workflow build        # compile to dist/
bun run --cwd plugins/plugin-workflow dev          # tsc --watch
bun run --cwd plugins/plugin-workflow typecheck    # tsgo --noEmit
bun run --cwd plugins/plugin-workflow test         # bun test (all)
bun run --cwd plugins/plugin-workflow test:unit    # bun test __tests__/unit/
bun run --cwd plugins/plugin-workflow test:e2e     # live plugin smoke
bun run --cwd plugins/plugin-workflow lint         # biome check --write --unsafe
bun run --cwd plugins/plugin-workflow lint:check   # biome check (read-only)
bun run --cwd plugins/plugin-workflow format       # biome format --write
bun run --cwd plugins/plugin-workflow format:check # biome format (read-only)
```

## Config / env vars

No required env vars. All configuration is read from `character.settings`:

| Setting path | Type | Description |
|---|---|---|
| `character.settings.workflows.credentials` | `Record<string, string>` | Optional pre-configured credential IDs keyed by credType (e.g. `"gmailOAuth2": "cred_abc"`). Note: `runtime.getSetting()` only returns primitives — read this nested value directly via `runtime.character.settings`. |
| `workflow.enabled` | `boolean` | Set to `false` in agent config to disable the plugin entirely (checked by `auto-enable.ts`). |

The Smithers execution runtime also reads these optional environment variables (used in `src/services/smithers-runtime.ts`):

| Env var | Default | Description |
|---|---|---|
| `SMITHERS_DB_PROVIDER` | `sqlite` | Database backend for the Smithers orchestrator (`sqlite` or `postgres`). |
| `SMITHERS_DB_URL` | — | Connection string when `SMITHERS_DB_PROVIDER=postgres`. |
| `SMITHERS_DB_DATA_DIR` | — | Data directory for SQLite storage. |
| `ELIZA_SMITHERS_RUN_PAYLOAD` | `{}` | JSON payload injected into Smithers worker runs. |
| `BUN_BIN` | `bun` | Bun executable fallback for Node-hosted dev/test processes; Smithers workers still run under Bun for `bun:sqlite`. |

Workflow generation/repair model calls also read optional primitive settings or env vars:

| Setting / env var | Default | Description |
|---|---|---|
| `WORKFLOW_LLM_PROVIDER` / `WORKFLOW_MODEL_PROVIDER` / `WORKFLOW_TEST_PROVIDER` | inferred | Provider intent for workflow generation, repair, and action-copy LLM calls. `cerebras` is mapped to the registered `openai` provider because Cerebras is served through the OpenAI-compatible plugin. |
| `WORKFLOW_LLM_MODEL` / `WORKFLOW_MODEL` / `WORKFLOW_TEST_MODEL` | `gpt-oss-120b` in Cerebras mode | Per-workflow model hint attached to generation/repair calls and `providerOptions.workflow`. |
| `WORKFLOW_LLM_RUNTIME_PROVIDER` / `WORKFLOW_MODEL_RUNTIME_PROVIDER` | `openai` when provider is `cerebras` | Override the registered runtime provider name used as the third `runtime.useModel()` argument. |

Cerebras mode is inferred from `ELIZA_PROVIDER=cerebras`, an `OPENAI_BASE_URL` on `cerebras.ai`, or a standalone `CEREBRAS_API_KEY` with no OpenAI key/base URL. The OpenAI plugin then reads `CEREBRAS_MODEL` / `CEREBRAS_API_KEY` / `CEREBRAS_BASE_URL`.

## How to extend

### Add an action op

Edit `src/actions/workflow.ts`: add the new op to `WORKFLOW_OPS`, add a `handleXxx` function following the existing pattern, and add a `case` in the `switch` block in `handler`.

### Add a provider

1. Create `src/providers/<name>.ts` exporting a `Provider` object. Set `name`, `contexts`, `contextGate`, `cacheScope`, and `roleGate` consistent with existing providers.
2. Export it from `src/providers/index.ts`.
3. Add it to the `providers` array in `src/index.ts`.

### Add a service

1. Create `src/services/<name>.ts` extending `Service` from `@elizaos/core`. Set `static override readonly serviceType`.
2. Export from `src/services/index.ts`.
3. Add to `services` array in `src/index.ts`. If the service needs cleanup, add a `stop()` call in the `dispose` function in `src/index.ts`.

### Add a route

1. Add handler(s) in the appropriate file under `src/routes/` or create a new one.
2. Export from `src/routes/index.ts` and add the route objects to `workflowRoutes`.
3. Also add the route declaration to `workflowRouteList` in `src/plugin-routes.ts` so it is registered with the app-route-plugin-registry.

### Extend the node catalog

Node definitions live in `src/data/defaultNodes.json`. Add new entries and update `src/data/schemaIndex.json` with the parameter schemas.

## Conventions / gotchas

- **No HTTP boundary.** All execution is in-process. `EmbeddedWorkflowService` is both the CRUD store and the execution runtime — never add an HTTP sidecar.
- **Route registration is a side effect.** `src/index.ts` imports `./register-routes` purely for its side effect (`registerAppRoutePluginLoader`). Without this import, all `/api/workflow/*` routes return 404.
- **Nested settings read-path.** `runtime.getSetting()` only surfaces primitive values. Nested objects like `character.settings.workflows.credentials` must be read directly from `runtime.character.settings?.workflows`.
- **`TRIGGER` action is separate.** Trigger CRUD (cron schedules, promoting a task to a workflow) lives in the agent-internal `TRIGGER` action, not here. `WORKFLOW_DISPATCH` service bridges the two: trigger tasks call `runtime.getService("WORKFLOW_DISPATCH").execute(workflowId)`.
- **Idempotency keys.** `WorkflowDispatchOptions.idempotencyKey` prevents duplicate executions when the same trigger fires concurrently.
- **Smithers orchestrator.** Workflow node execution delegates to `smithers-orchestrator@0.22.0` (see `src/services/smithers-runtime.ts`). The `effect` and `quickjs-emscripten` packages support the orchestrator's functional pipeline and sandboxed JS evaluation respectively. Failed delegated nodes are echoed before Smithers' wrapper error so execution diagnostics retain the original node error.
- **Workflow eval kits.** `WORKFLOW eval_samples` and `/api/workflow/workflows/:id/evaluation-samples` return compact JSONL cases plus Smithers eval, GEPA optimize, observability, and metrics command hints. Keep `jsonl` pure so it can be written directly to the returned `optimizer.caseFile`.
- **Drizzle ORM.** The plugin manages its own Postgres schema via Drizzle. Tables are exported from `src/db/schema.ts` and registered on the plugin's `schema` field.
- **validateAndRepair retry loop.** Generation and modification both run up to 3 LLM-retry passes via `validateAndRepair` + `fixWorkflowErrors` to correct typeVersion hallucinations, missing credential blocks, and invalid output references before deploy.
- **Auto-enable.** `auto-enable.ts` (referenced by `elizaos.plugin.autoEnableModule` in `package.json`) returns `false` only when `config.workflow.enabled === false`. Default is enabled.

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

**Capture & manually review for this package — agent behavior / app plugin:**
- A **live-LLM** scenario trajectory showing the behavior end to end and asserting the **outcome**, not just that routing/an action was selected (see #9970).
- The artifacts the behavior creates — memories, knowledge, scheduled-task rows, relationships, documents, outputs — inspected after the run.
- Backend `[ClassName]` logs of the action/service/runner firing, plus error/edge/permission paths.
- The empty-state and adversarial-input behavior, not just one happy scenario.
<!-- END: evidence-and-e2e-mandate -->
