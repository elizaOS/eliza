# @elizaos/plugin-workflow

Native Smithers workflow authoring and execution for elizaOS. This package owns the workflow domain exposed to chat, the Workflows view, trigger dispatch, and elizaOS Cloud routes.

## Architecture

A persisted workflow is a TypeScript or TSX module that imports public APIs from `smthrs` and default-exports a workflow built with `smithers(...)`. The artifact also carries an input JSON Schema, a visual step manifest, optional schedule metadata, and props-driven widget manifests. There is one workflow format; foreign node graphs and translation layers are not supported.

elizaOS owns authentication, tenancy, definitions, revisions, run summaries, scheduling, HTTP routes, chat routing, and live product events. Smithers owns workflow evaluation. Runs execute in an isolated Bun child process and native Smithers progress is copied into the owning elizaOS run record. There is no Smithers Gateway, Gateway protocol, or Smithers HTTP sidecar.

Every Smithers `Task` must use `globalThis.__elizaSmithers.agent`. The runner injects that AgentLike and sends generation requests back to the owning `AgentRuntime`, which selects the elizaOS model/provider and Cloud credentials. Workflow source must never instantiate provider or Gateway clients.

## Source contract

```tsx
/** @jsxImportSource smthrs */
import { createSmithers } from "smthrs";
import { z } from "zod";

const { Workflow, Task, smithers, outputs } = createSmithers(
  { result: z.object({ message: z.string() }) },
  { dbPath: process.env.ELIZA_SMTHRS_DB_PATH },
);
const agent = globalThis.__elizaSmithers.agent;

export default smithers(() => (
  <Workflow name="Example">
    <Task id="run" output={outputs.result} agent={agent}>Do the work.</Task>
  </Workflow>
));
```

Source validation requires a `smthrs` import and default export and rejects legacy package names or foreign node definitions.

## Services

- `WorkflowService` (`workflow`) is the chat and API facade. It generates native source with the selected elizaOS model and exposes search, CRUD, activation, asynchronous runs, revisions, and evaluation samples.
- `EmbeddedWorkflowService` (`embedded_workflow_service`) persists tenant-scoped definitions and runs, launches the Smithers worker, records events, and supports cancellation and live subscriptions.
- `WORKFLOW_DISPATCH` is the typed trigger bridge and preserves idempotency keys.
- `WorkflowCredentialStore` remains the agent-scoped connector credential mapping service; workflow tasks access integrations through elizaOS capabilities rather than embedded secrets.

## HTTP surface

All routes are elizaOS routes under `/api/workflow`: status, definitions, generation, activate/deactivate, asynchronous run start, execution detail/cancel/events, revisions/restore, and evaluation samples. Hosted agents expose the same contract through the authenticated Cloud agent-server boundary.

`GET /api/workflow/executions/:id/events` is an SSE stream of elizaOS-owned copies of native Smithers events. UI clients may poll execution detail where their transport cannot keep an SSE connection.

## UI and chat

The Workflows studio edits source, renders the Smithers step manifest, starts and cancels runs, follows live events, previews widgets, and restores revisions. Chat uses the same service. A run response emits a `[WORKFLOW]` block with workflow/run ids, step ids, and widget manifests; the inline widget hydrates from the execution API and links back to the studio.

## Commands

```bash
bun run --cwd plugins/plugin-workflow typecheck
bun run --cwd plugins/plugin-workflow test
bun run --cwd plugins/plugin-workflow lint:check
```

The package requires Bun because Smithers uses Bun SQLite for its per-workflow durable engine store. Repository-wide validation and app visual evidence requirements in the root guide remain binding.
