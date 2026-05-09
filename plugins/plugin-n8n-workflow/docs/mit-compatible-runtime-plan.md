# MIT-compatible n8n workflow runtime plan

## Position

The upstream `n8n-io/n8n` source is not MIT licensed. The current upstream `master` checkout uses the Sustainable Use License for most source files and an enterprise license for `.ee` source files. We can use it as a reference while designing compatibility, but the MIT deliverable must be a clean Eliza implementation that does not copy n8n runtime source.

The pruned reference checkout lives outside this repo at:

`/Users/shawwalters/eliza-workspace/milady/n8n-eliza-reference`

That tree is only for inspection. It is not a shippable MIT package.

## Compatibility target

The Eliza workflow runtime should be able to import, store, validate, generate, and execute workflows using the n8n workflow JSON shape:

- workflow metadata: `id`, `name`, `active`, `settings`, `tags`, `versionId`
- nodes: `id`, `name`, `type`, `typeVersion`, `position`, `parameters`, `credentials`, `disabled`, `notes`
- connections: n8n `main` connection arrays with source node, output index, destination node, and input index
- execution data: per-node run data, item arrays, errors, start/finish timestamps, status
- optional compatibility fields: `pinData`, `staticData`, `meta`, `triggerCount`, `createdAt`, `updatedAt`

Compatibility means Eliza-generated workflows should round-trip through n8n import/export where the node types are supported. It does not mean Eliza must execute every n8n community or vendor node.

## Package shape

Build MIT code under Eliza, not by vendoring n8n packages.

- `@elizaos/n8n-workflow`: pure workflow types, JSON schema, import/export normalization, compatibility validation, expression interfaces.
- `@elizaos/n8n-runtime`: execution engine, graph planner, run state, node registry, scheduler hooks, webhook dispatch, execution persistence interfaces.
- `@elizaos/n8n-nodes`: MIT core node implementations for the supported subset.
- `@elizaos/plugin-n8n-workflow`: Eliza plugin API, app routes, generation/repair prompts, credential resolution, local runtime service.
- hosted worker package later: durable queue, hosted schedules, webhook ingress, execution logs, retries.

## MVP node subset

Start with nodes that are workflow primitives or broadly useful without vendor lock-in:

- triggers: Manual Trigger, Schedule Trigger, Webhook, Workflow Trigger, Error Trigger
- responses: Respond to Webhook
- flow control: If, Switch, Merge, Filter, Split In Batches / loop, Wait, Stop and Error, NoOp
- transforms: Set/Edit Fields, Code with JavaScript only, Date & Time, Item Lists, Rename Keys
- data formats: HTML, Markdown, XML, compression, file read/write/convert where local app permissions allow it
- network: HTTP Request, GraphQL
- composition: Execute Workflow
- crypto/auth helpers: JWT, Crypto, generic HTTP auth, OAuth1, OAuth2 credential references

Explicitly exclude for the MIT MVP:

- n8n CLI package and desktop/editor frontend
- CodeMirror/editor packages
- LangChain and n8n AI/agent nodes
- Python execution and Python task runners
- enterprise `.ee` code and permission model
- TypeORM n8n database schema and migrations
- vendor SaaS nodes until there is a specific Eliza app requirement

## Runtime requirements

The runtime should expose a small execution contract:

- `validateWorkflow(workflow, registry)` returns structural errors, unsupported node types, missing credentials, and unsafe settings.
- `executeWorkflow(workflow, input, options)` returns n8n-shaped execution data.
- `activateWorkflow(workflow)` registers schedules and webhooks.
- `deactivateWorkflow(workflowId)` unregisters schedules and webhooks.
- `resumeExecution(executionId, payload)` continues Wait/Webhook/Form resumptions.

Execution behavior:

- Build a graph from n8n `connections.main`.
- Support trigger start, manual start, partial start for testing, and Execute Workflow child calls.
- Preserve n8n item shape: `{ json, binary?, pairedItem? }`.
- Resolve expressions in parameter fields before node execution.
- Store run data per node and branch.
- Handle disabled nodes, continue-on-fail, retries, and node errors.
- Keep binary data behind an Eliza storage adapter rather than embedding large base64 payloads in execution rows.

## Expression support

Implement a conservative expression evaluator instead of importing n8n expression runtime.

MVP:

- literal parameters
- `={{ ... }}` expression fields
- `$json`, `$item`, `$node["Name"].json`, `$workflow`, `$execution`, `$now`
- safe helper functions required by generated Eliza workflows

Later:

- broader n8n expression helpers
- paired item traversal
- compatibility warnings when unsupported expression syntax is imported

## Local app execution

Local execution should run in-process inside the Eliza app/plugin:

- no external n8n process
- no n8n npm runtime dependencies
- schedules use local timers while the app is running
- webhooks route through the Eliza local server
- credentials resolve through the Eliza credential store
- file access obeys local app permission boundaries
- execution history persists in the plugin DB tables

## Hosted execution

Hosted execution needs durable infrastructure:

- workflow activation service writes schedule/webhook registrations
- queue-backed execution workers
- distributed schedule locking
- webhook ingress maps public URLs to workflow IDs
- encrypted credential resolution in cloud secrets
- execution logs and run data retention policy
- cancellation, retry, timeout, and concurrency limits
- tenant/workspace isolation

The hosted worker should use the same `@elizaos/n8n-runtime` package as local execution, with different adapters for storage, credentials, schedules, queues, and webhooks.

## Eliza app integration

The workflow app needs:

- workflow CRUD routes
- import/export n8n JSON
- node catalog route for the supported subset
- validation and repair route
- draft workflow generation from natural language
- execution route for manual/local runs
- activation/deactivation route for schedules and webhooks
- execution history route
- credential requirement detection and credential binding UI data

The existing plugin currently references `n8n-core`, `n8n-workflow`, and `n8n-nodes-base`. Those dependencies should be removed once the MIT runtime package exists.

## Cleanup waves

1. License boundary and reference cleanup
   - Keep upstream clone as reference only.
   - Do not copy upstream source into Eliza packages.
   - Delete n8n npm runtime dependencies from Eliza once replacements land.

2. Workflow schema and catalog
   - Define MIT workflow TypeScript types and JSON schema.
   - Normalize imported n8n workflows.
   - Generate or hand-author a supported-node catalog.
   - Add compatibility validation for unsupported nodes.

3. Runtime MVP
   - Implement graph planner and item execution model.
   - Implement expression MVP.
   - Implement core node registry and MVP nodes.
   - Add execution persistence adapter interface.

4. Plugin integration
   - Replace `embedded-n8n-service` with the MIT runtime service.
   - Keep current plugin routes stable.
   - Wire workflow CRUD, validation, activation, and execution to the new service.

5. Local execution hardening
   - Add cancellation, timeouts, concurrency limits, and sandbox policy.
   - Add binary-data adapter.
   - Add tests for import/export, execution, and route compatibility.

6. Hosted execution
   - Add queue/scheduler/webhook adapters.
   - Add cloud execution worker.
   - Add retention and observability.

7. Compatibility expansion
   - Add more nodes only when Eliza workflows need them.
   - Prefer generic HTTP/OpenAPI-backed nodes over handwritten vendor nodes.
   - Keep unsupported n8n nodes importable but non-executable with clear errors.

## Verification

Required tests before shipping:

- import/export round-trip for representative n8n workflows
- validation errors for unsupported nodes and missing credentials
- execution tests for each MVP node
- expression evaluator tests for supported syntax
- local schedule and webhook activation tests
- hosted adapter contract tests
- plugin route tests using the existing n8n-workflow app routes

