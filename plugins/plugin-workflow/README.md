# @elizaos/plugin-workflow

In-process workflow engine for elizaOS agents. Generate and deploy automation workflows from natural language using a RAG pipeline. The plugin embeds its own execution engine — workflows run in the agent process, no separate sidecar.

## Configuration

No workflow-specific env vars are required. The plugin's `EmbeddedWorkflowService` runs CRUD + execution + scheduler + webhook handling locally inside the agent, persisted to the agent's Postgres schema.

## Plugin Components

| Component | Purpose |
|---|---|
| `EmbeddedWorkflowService` | In-process workflow execution engine (CRUD + node runtime + scheduler + webhooks). |
| `WorkflowService` | Public service surface used by the agent's `WORKFLOW` umbrella action. Routes to the embedded workflows engine. |
| `WorkflowCredentialStore` | Stores workflow-scoped credentials (encrypted at rest). |
| `workflowStatusProvider` | Exposes engine status to the planner. |
| `activeWorkflowsProvider` | Lists active workflows for context. |
| `pendingDraftProvider` | Surfaces an in-progress draft so the agent can clarify before persisting. |
| Routes | Mounted at `/api/workflow/*` on the agent's HTTP server. |

The `WORKFLOW` umbrella action is defined in this plugin (`src/actions/workflow.ts`) and dispatches op-based commands (`create`, `modify`, `activate`, `deactivate`, `toggle_active`, `delete`, `executions`) to this plugin's services.

## RAG Pipeline (workflow generation from natural language)

1. **Extract keywords** from the user request.
2. **Match** against existing workflows (RAG over the workflow store) — return a match if one exists.
3. **Generate** a new workflow definition if no match — LLM produces a node graph against the catalog from `src/data/`.
4. **Validate & repair** node parameters / credentials / connections.
5. **Synthesize output schemas** for downstream nodes.
6. **Position** nodes for the visual editor.

## Credential Resolution

Credentials are resolved at workflow-execution time. The plugin checks:
1. Plugin-level `workflows.credentials` config map (deterministic).
2. Cached secrets via the agent's secret service.
3. Stored credentials via `WorkflowCredentialStore`.
4. LLM-driven `request_credential` resolution (prompts the user).

## Routes

All routes mount at `/api/workflow/`:

- `GET    /api/workflow/status` — engine + plugin status
- `GET    /api/workflow/workflows` — list
- `POST   /api/workflow/workflows` — create
- `GET    /api/workflow/workflows/:id`
- `PUT    /api/workflow/workflows/:id`
- `DELETE /api/workflow/workflows/:id`
- `POST   /api/workflow/workflows/:id/activate`
- `POST   /api/workflow/workflows/:id/deactivate`
- `GET    /api/workflow/workflows/:id/executions`
- `GET    /api/workflow/executions` — list executions (with workflowId/status/limit/cursor filters)
- `GET    /api/workflow/executions/:id` — execution detail
- Webhook endpoints for trigger nodes are exposed dynamically per workflow.

## Development

```bash
bun install
bun run build
bun run typecheck
bun run test
bun run lint
```

Lint/format is [Biome 2.x](https://biomejs.dev). TypeScript 6+. ESM only.

