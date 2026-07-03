# @elizaos/plugin-workflow

In-process workflow engine for elizaOS agents. Generate and deploy automation workflows from natural language using a RAG pipeline. The plugin embeds its own execution engine — workflows run in the agent process, no separate sidecar.

> **Vocabulary:** a **workflow** is a stored node-graph definition; one execution is a **run**; the attachable start condition is a **trigger** (`schedule` or `event`). See [`docs/automation-glossary.md`](../../docs/automation-glossary.md) for how workflows, triggers, tasks, scheduled items, and automations differ and what fires each.

## Configuration

No workflow-specific env vars are required. The plugin's `EmbeddedWorkflowService` runs CRUD + execution + scheduler + webhook handling locally inside the agent, persisted to the agent's Postgres schema.

## Plugin Components

| Component | Purpose |
|---|---|
| `EmbeddedWorkflowService` | In-process workflow execution engine (CRUD + node runtime + scheduler + webhooks). |
| `WorkflowService` | Public service surface used by the agent's `WORKFLOW` umbrella action. Routes to the embedded workflows engine. |
| `WorkflowCredentialStore` | DB-backed `(userId, credType) → credential ID` mappings (service type `workflow_credential_store`). |
| `workflowStatusProvider` | `workflow_status` provider — per-user workflows with last execution status. |
| `activeWorkflowsProvider` | `ACTIVE_WORKFLOWS` provider — active/inactive workflows for LLM context. |
| `pendingDraftProvider` | `PENDING_WORKFLOW_DRAFT` provider — surfaces an in-flight draft so the agent can clarify before persisting. |
| Routes | `/api/workflow/*` (rawPath) plus plugin-name-prefixed `/workflow/*` (see Routes below). |

The `WORKFLOW` umbrella action is defined in this plugin (`src/actions/workflow.ts`) and dispatches op-based commands (`create`, `modify`, `activate`, `deactivate`, `toggle_active`, `delete`, `executions`) to this plugin's services.

## RAG Pipeline (workflow generation from natural language)

1. **Extract keywords** from the user request.
2. **Match** against existing workflows (RAG over the workflow store) — return a match if one exists.
3. **Generate** a new workflow definition if no match — LLM produces a node graph against the catalog from `src/data/`.
4. **Validate & repair** node parameters / credentials / connections.
5. **Synthesize output schemas** for downstream nodes.
6. **Position** nodes for the visual editor.

## Credential Resolution

Credentials are resolved per credential type at deploy/execution time. The chain (first match wins, see `src/utils/credentialResolver.ts`):
1. Credential store DB — cached `(userId, credType) → credentialId` mappings via `WorkflowCredentialStore`.
2. Static config — `character.settings.workflows.credentials`.
3. External provider — a registered `CredentialProvider` service (e.g. cloud OAuth); newly resolved IDs are written back to the store.
4. Otherwise the credType is reported as a missing connection for manual configuration.

## Routes

Two registration paths produce two URL shapes.

The `rawPath` route plugin (`src/plugin-routes.ts`, registered via `registerAppRoutePluginLoader`) mounts at `/api/workflow/*`:

- `GET    /api/workflow/status` — engine + plugin status
- `GET/POST /api/workflow/workflows` — list / create
- `POST   /api/workflow/workflows/generate` — generate a draft from a prompt
- `POST   /api/workflow/workflows/resolve-clarification`
- `GET/PUT/DELETE /api/workflow/workflows/:id`
- `POST   /api/workflow/workflows/:id/activate` · `/deactivate`
- `GET    /api/workflow/workflows/:id/executions`
- `GET    /api/automations` — combined workflows + triggers + tasks + draft conversations

The standard plugin `routes` (`src/routes/index.ts`) are mounted under the plugin-name prefix `/workflow/*` by the runtime:

- `GET    /workflow/executions` · `/workflow/executions/:id` — list (workflowId/status/limit/cursor) + detail
- `GET    /workflow/nodes` · `/workflow/nodes/available` · `/workflow/nodes/:type`
- `POST   /workflow/workflows/validate`
- `GET/POST/PUT/PATCH/DELETE /workflow/webhooks/:path` — trigger-node webhooks

## Development

```bash
bun install
bun run build
bun run typecheck
bun run test
bun run lint
```

Lint/format is [Biome 2.x](https://biomejs.dev). TypeScript 6+. ESM only.

