# @elizaos/plugin-workflow

In-process workflow engine: generate and run automation workflows from natural language inside an Eliza agent.

## Purpose / role

Adds workflow automation capabilities to an Eliza agent. Given a natural-language prompt, the plugin runs a RAG pipeline (keyword extraction → node catalog search → LLM generation → validate/repair → deploy) to produce and immediately activate a runnable workflow. Execution happens in-process via the `EmbeddedWorkflowService`; there is no external sidecar. The plugin is **default-enabled** (opt-out with `workflow.enabled: false` in agent config).

## Plugin surface

### Actions

| Name | Description |
|---|---|
| `WORKFLOW` | Umbrella action for all workflow lifecycle ops. Dispatches on `action` parameter: `create`, `modify`, `activate`, `deactivate`, `toggle_active`, `delete`, `executions`. Requires `minRole: OWNER`. Active in contexts `automation`, `tasks`, `agent_internal`. |

### Providers

| Name | Description |
|---|---|
| `workflow_status` | Lists each user's workflows with last execution status. Contexts: `automation`, `connectors`. `minRole: ADMIN`. Cache scope: `turn`. |
| `ACTIVE_WORKFLOWS` | Lists active/inactive workflows for LLM context (IDs, names, node counts). Contexts: `automation`, `connectors`. `minRole: ADMIN`. Cache scope: `agent`. |
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
- **Smithers orchestrator.** Workflow node execution delegates to `smithers-orchestrator@0.22.0` (see `src/services/smithers-runtime.ts`). The `effect` and `quickjs-emscripten` packages support the orchestrator's functional pipeline and sandboxed JS evaluation respectively.
- **Drizzle ORM.** The plugin manages its own Postgres schema via Drizzle. Tables are exported from `src/db/schema.ts` and registered on the plugin's `schema` field.
- **validateAndRepair retry loop.** Generation and modification both run up to 3 LLM-retry passes via `validateAndRepair` + `fixWorkflowErrors` to correct typeVersion hallucinations, missing credential blocks, and invalid output references before deploy.
- **Auto-enable.** `auto-enable.ts` (referenced by `elizaos.plugin.autoEnableModule` in `package.json`) returns `false` only when `config.workflow.enabled === false`. Default is enabled.
