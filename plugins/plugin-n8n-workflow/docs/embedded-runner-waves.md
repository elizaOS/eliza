# Embedded n8n Runner Plan

Status: P0 landed as a plugin-only, feature-flagged spike.

## Decisions Locked For This Implementation

- Ownership boundary: all n8n and workflow runtime code lives in `plugins/plugin-n8n-workflow`. App-core and agent can keep calling the plugin routes/services they already call, but they should not own n8n execution internals.
- Backend switch: default remains HTTP n8n. Embedded mode is opt-in with one of:
  - `N8N_BACKEND=embedded`
  - `N8N_MODE=embedded`
  - `N8N_EMBEDDED_ENABLED=true`
  - `N8N_HOST=embedded://local`
- P0 persistence: in-memory workflows, executions, credentials, and tags. DB persistence is a later plugin schema migration.
- P0 node set: `scheduleTrigger`, `httpRequest`, and `set`. Unsupported nodes fail before activation or execution.
- P0 runtime import: `n8n-core` and `n8n-workflow` are lazy-loaded by the plugin. Importing the plugin does not immediately load n8n-core.
- Code node: deferred. QuickJS remains the likely mobile-safe direction, but it should be its own wave.
- Catalog policy: embedded generation should eventually filter to registered nodes by default.
- License posture: n8n packages declare `SEE LICENSE IN LICENSE.md`; n8n docs describe the Sustainable Use License, and n8n support docs say embedding workflow/credential management for clients may require an Embed license. Legal review remains required before shipping in distributed binaries.

## Corrections To The Initial Plan

- Current npm metadata observed during implementation:
  - `n8n-core@2.16.1`
  - `n8n-workflow@2.16.0`
  - `n8n-nodes-base@2.15.1`
- `n8n-core` was not already present in the workspace lock. It is now a direct dependency of this plugin.
- `n8n-workflow` was previously only transitive through `n8n-nodes-base`; it is now a direct dependency of this plugin.
- `n8n-nodes-base` remains dev-only for catalog/crawl work. P0 does not import it.
- Node ESM import of `n8n-workflow` can fail because the package's ESM build uses extensionless internal imports. Bun can import it; Node can use the CJS condition through `createRequire`. The embedded loader handles both.
- `Workflow` strips node parameters that are not declared in a node type's `description.properties`, so even custom P0 nodes need minimal property schemas.
- `WorkflowExecute` requires execution lifecycle hooks; P0 supplies `ExecutionLifecycleHooks` from n8n-core.
- Loading n8n-core has process-level side effects and can leave handles open in tests. Execution smoke tests therefore run in a child process that exits explicitly.

## Wave A: P0 Spike (Current)

Owner: one worker inside `plugins/plugin-n8n-workflow`.

Scope:
- Add `EmbeddedN8nService`.
- Add lazy runtime loader for `n8n-core` and `n8n-workflow`.
- Register 3 embedded node implementations:
  - `n8n-nodes-base.scheduleTrigger`
  - `n8n-nodes-base.httpRequest`
  - `n8n-nodes-base.set`
- Wire `N8nWorkflowService` to select embedded backend by feature flag.
- Keep existing HTTP n8n path as default.
- Add focused tests:
  - unsupported node rejection
  - embedded backend selection without `N8N_HOST`/`N8N_API_KEY`
  - child-process execution smoke for schedule -> HTTP -> Set

Exit criteria:
- `bun test __tests__/unit/embeddedN8nService.test.ts` passes.
- `bunx tsc --noEmit --project plugins/plugin-n8n-workflow/tsconfig.json` passes.

## Wave B: Plugin Persistence

Parallel workers:

1. Schema worker
   - Owns `src/db/schema.ts` and plugin migration docs/scripts.
   - Adds plugin-owned tables for workflows, executions, credentials, and tags.
   - Keeps export-to-n8n compatibility by storing original workflow JSON.

2. Service worker
   - Owns `src/services/embedded-n8n-service.ts`.
   - Replaces in-memory maps with repository methods backed by `runtime.db`.
   - Adds startup rehydration for active schedules.

3. Test worker
   - Owns plugin tests only.
   - Adds PGlite/Postgres-compatible repository tests if existing plugin-sql test helpers are available.

Exit criteria:
- Workflows survive service restart in tests.
- Active schedules are rearmed after service start.
- Executions are queryable through existing plugin routes/providers.

## Wave C: T1 Node Set

Parallel workers:

1. Control-flow worker
   - Adds IF, Switch, Merge, Filter, NoOp.
   - Uses n8n-compatible output indexes and item pairing.

2. Data worker
   - Adds Edit Fields aliases, Item Lists, DateTime, Crypto, SplitInBatches.
   - Adds fixture parity tests for expressions and binary-safe item passing.

3. Trigger worker
   - Adds Manual Trigger, Webhook, RespondToWebhook, Wait.
   - Keeps webhook route registration inside plugin routes only.

4. Catalog worker
   - Adds a registered-node catalog filter used by generation in embedded mode.
   - Keeps the full catalog available for remote/cloud HTTP mode.

Exit criteria:
- Embedded validation rejects unregistered nodes before deploy.
- Generation in embedded mode only sees registered nodes unless cloud fallback is enabled.
- T1 fixture workflows pass against embedded and HTTP-mode mocked API paths.

## Wave D: QuickJS Code Node

Parallel workers:

1. Sandbox worker
   - Adds QuickJS runtime and resource limits.
   - Implements n8n-shaped globals: `$input`, `$json`, `$node`, `$items`, helpers.

2. Security worker
   - Audits timeout, memory, host object exposure, and escaping.
   - Confirms no `vm2` or `isolated-vm` dependency enters embedded mode.

3. Compatibility worker
   - Builds fixtures for common n8n Code node snippets.
   - Documents unsupported n8n-specific globals.

Exit criteria:
- Code node works on Bun without native dependencies.
- Unsupported APIs fail clearly.
- Security review has no known sandbox escape path from host capabilities.

## Wave E: T2 Integrations

Parallel workers should take disjoint integration groups:

- Chat: Slack, Discord, Telegram.
- Google: Gmail, Sheets, Calendar, Drive.
- Developer: GitHub, OpenAI, Anthropic.
- Business: Stripe, Notion, Airtable, Postgres.

Rules:
- Do not import `n8n-nodes-base` wholesale.
- Prefer first-party lightweight plugin-owned nodes where dependency surface is smaller.
- If selectively importing `n8n-nodes-base`, audit transitive dependencies first and gate by platform.
- Credential resolution remains plugin-owned and must reuse existing credential provider/store contracts.

Exit criteria:
- Each integration has dependency audit notes.
- Each integration has at least one credentialed execution fixture or a clear mocked transport test.
- Mobile-unsafe integrations are excluded from embedded-mobile mode and routed to cloud if available.

## Wave F: Cloud Fallback And Mobile Packaging

Parallel workers:

1. Fallback worker
   - Adds runtime policy: unregistered node -> cloud fallback when paired, hard fail otherwise.
   - Keeps policy in plugin config and plugin services.

2. Mobile worker
   - Keeps implementation in plugin.
   - Determines whether mobile should bundle `n8n-core` or stage plugin dependencies as runtime packages.
   - Adds plugin-local documentation for required mobile stubs if the platform build needs them.

3. Licensing worker
   - Confirms SUL/Embed posture for distributed desktop, Android APK, cloud, and white-label use.
   - Blocks release if legal approval is missing.

Exit criteria:
- Android embedded mode can boot and run P0/T1 fixtures.
- iOS remains cloud-only until local agent exists.
- Legal posture is recorded before release packaging.

## References

- n8n Sustainable Use License docs: https://docs.n8n.io/sustainable-use-license/
- n8n license reference: https://docs.n8n.io/reference/license/
- n8n Embed docs: https://docs.n8n.io/embed/
