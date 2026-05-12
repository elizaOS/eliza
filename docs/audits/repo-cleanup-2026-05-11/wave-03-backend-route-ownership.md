# Wave 03 - Backend Route Ownership Dry-Run Manifest

Date: 2026-05-11
Worker: Wave 3 backend route ownership
Scope: dry-run only. No source, config, test, package, generated, or asset files were changed.

## Summary

This wave should not start by deleting routes. The repository has two active backend route planes:

- Cloud Worker/Hono routes under `cloud/apps/api/**/route.ts`, mounted by `cloud/apps/api/src/_generate-router.mjs` into `cloud/apps/api/src/_router.generated.ts`.
- Local agent/desktop routes split across `packages/agent/src/api/*`, `packages/app-core/src/api/*`, and plugin `Plugin.routes` surfaces such as `plugins/plugin-elizacloud`, `plugins/plugin-local-inference`, `plugins/plugin-computeruse`, `plugins/plugin-browser`, and `plugins/plugin-workflow`.

Dry-run inventory found no duplicate mounted Cloud Worker paths in the generated router. The cleanup risk is instead route ownership drift: legacy/compat routes, local pre-dispatch routes shadowing upstream agent routes, copied type definitions, broad barrels, and placeholder/stub routes that are mounted but not real implementations.

## Current Route Inventory

Read-only checks performed during this dry run:

- `cloud/apps/api/src/_router.generated.ts` currently says `529 routes mounted, 0 skipped`.
- `collectRouteEntries()` from `cloud/apps/api/src/_generate-router.mjs` reported `routeFiles: 529`, `mounted: 529`, `unconverted: 0`, `duplicateMountedPaths: 0`.
- Existing generated audit docs under `cloud/apps/api/test/*.md` are stale relative to the current route tree; for example `cloud/apps/api/test/INVENTORY.md` still reports 493 mounted routes.
- `packages/agent/src/api` contains 192 checked-in declaration/source-map artifacts matching `*.d.ts` or `*.d.ts.map`.

## Canonical Ownership Proposal

| Area | Proposed canonical owner | Compatibility owner | Rule before deletion |
| --- | --- | --- | --- |
| Cloud Worker route mounting | `cloud/apps/api/src/_generate-router.mjs` and generated `cloud/apps/api/src/_router.generated.ts` | none | Re-run codegen after any route add/delete and require zero stale/missing generated routes. |
| Cloud public v1 API | `cloud/apps/api/v1/**/route.ts` | Root aliases such as `cloud/apps/api/credits/*`, `cloud/apps/api/stripe/*`, `cloud/apps/api/elevenlabs/*`, and `cloud/apps/api/compat/*` | Alias can be deleted only after SDK/frontend callers move and parity tests prove response/body/header compatibility or an intentional breaking change is approved. |
| Cloud thin-client agent compatibility | `cloud/apps/api/v1/agents/**`, `cloud/apps/api/v1/jobs/**`, plus shared services in `cloud/packages/lib` / `cloud/apps/api/lib/services` | `cloud/apps/api/compat/**` | Keep `/api/compat/*` as envelope adapters until waifu/core/dashboard clients stop depending on compat envelopes. |
| Local standalone agent API | `packages/agent/src/api/*-routes.ts` and dispatch in `packages/agent/src/api/server.ts` | app-core pre-dispatch wrappers when desktop embeds agent | Standalone behavior must be tested separately from app-core-wrapped behavior; same path does not imply same owner. |
| Desktop/app-core local API | `packages/app-core/src/api/*-compat-routes.ts` and `packages/app-core/src/api/server.ts` pre-dispatch | `packages/agent/src/api/*` fallback after pre-dispatch | Shadowed routes need an allowlist and paired tests before either side is removed. |
| `/api/cloud/*` local runtime routes | `plugins/plugin-elizacloud/src/plugin.ts` route registration and `plugins/plugin-elizacloud/src/routes/*` | `packages/app-core/src/api/server.ts` still proxies `/api/cloud/compat/*`, `/api/cloud/v1/*`, and `/api/cloud/billing/*` | Do not delete app-core proxy branches until plugin route dispatch can provide the same fresh config, auth, and billing/compat proxy behavior. |
| `/api/local-inference/*` | Split owner today: app-core desktop implementation in `packages/app-core/src/api/local-inference-compat-routes.ts`; plugin/mobile implementation in `plugins/plugin-local-inference/src/local-inference-routes.ts` | none | Extract shared service/contract first; do not delete either handler until desktop, mobile, and paired-device flows have parity tests. |
| `/api/computer-use/*` | `plugins/plugin-computeruse/src/routes/computer-use-compat-routes.ts` via `plugins/plugin-computeruse/src/index.ts` route registration | `plugins/plugin-computeruse/src/routes/computer-use-routes.ts` empty fallback | Delete/rename the empty fallback only after confirming no imports of `handleComputerUseRoutes` and plugin route registration covers all host modes. |
| `/api/browser-bridge/*`, `/api/browser-workspace/*` | `plugins/plugin-browser/src/routes/bridge.ts` and `plugins/plugin-browser/src/routes/workspace.ts` | inline optional fallbacks in `packages/agent/src/api/server.ts` | Remove inline fallbacks only after plugin route loading is guaranteed in desktop/mobile builds and package/open-path behavior is preserved. |
| Workflow/automation local routes | `plugins/plugin-workflow/src/plugin-routes.ts` and route modules under `plugins/plugin-workflow/src/routes` | `packages/app-core/src/api/automations-compat-routes.ts` | Keep compatibility until automation UI/API clients stop calling `/api/automations`. |
| Public type contracts | Prefer `@elizaos/shared` or a single package-local `types.ts` per package | local copied interfaces and helper barrels | Only collapse after downstream imports are found and migrated. |

## Duplicate And Compatibility Routes

### Cloud compat agents

Compat route files:

- `cloud/apps/api/compat/agents/route.ts` -> `GET/POST /api/compat/agents`
- `cloud/apps/api/compat/agents/[id]/route.ts` -> `GET/DELETE /api/compat/agents/:id`
- `cloud/apps/api/compat/agents/[id]/launch/route.ts` -> `POST /api/compat/agents/:id/launch`
- `cloud/apps/api/compat/agents/[id]/logs/route.ts` -> `GET /api/compat/agents/:id/logs`
- `cloud/apps/api/compat/agents/[id]/restart/route.ts` -> `POST /api/compat/agents/:id/restart`
- `cloud/apps/api/compat/agents/[id]/resume/route.ts` -> `POST /api/compat/agents/:id/resume`
- `cloud/apps/api/compat/agents/[id]/status/route.ts` -> `GET /api/compat/agents/:id/status`
- `cloud/apps/api/compat/agents/[id]/suspend/route.ts` -> `POST /api/compat/agents/:id/suspend`
- `cloud/apps/api/compat/jobs/[jobId]/route.ts` -> `GET /api/compat/jobs/:jobId`

Nearby v1 owners:

- `cloud/apps/api/v1/agents/route.ts` -> `POST /api/v1/agents`
- `cloud/apps/api/v1/agents/[agentId]/route.ts` -> `GET /api/v1/agents/:agentId`
- `cloud/apps/api/v1/agents/[agentId]/restart/route.ts` -> `POST /api/v1/agents/:agentId/restart`
- `cloud/apps/api/v1/agents/[agentId]/resume/route.ts` -> `POST /api/v1/agents/:agentId/resume`
- `cloud/apps/api/v1/agents/[agentId]/status/route.ts` -> `GET /api/v1/agents/:agentId/status`
- `cloud/apps/api/v1/agents/[agentId]/suspend/route.ts` -> `POST /api/v1/agents/:agentId/suspend`
- `cloud/apps/api/v1/jobs/[jobId]/route.ts` -> `GET /api/v1/jobs/:jobId`

Proposed owner: keep v1 as canonical service API; keep compat as response-envelope adapters. Do not delete compat routes until tests prove all consumers accept v1 response shapes or clients are migrated. `cloud/apps/api/compat/jobs/[jobId]/route.ts` is not equivalent to `v1/jobs/[jobId]`: compat treats `jobId` as an agent id and synthesizes status from `elizaSandboxService`.

Parity tests required:

- Same seeded organization, agent, sandbox, and provisioning-job rows.
- For each lifecycle action, compare auth methods, status code, CORS, envelope shape, error shape, and side effects.
- Explicit negative tests for wrong org, missing agent, provisioning in progress, and service-key versus user auth.

### Cloud billing, credits, and checkout aliases

Duplicate/alias candidates:

- `cloud/apps/api/credits/balance/route.ts` -> `GET /api/credits/balance`
- `cloud/apps/api/v1/credits/balance/route.ts` -> `GET /api/v1/credits/balance`
- `cloud/apps/api/credits/transactions/route.ts` -> `GET /api/credits/transactions`
- `cloud/apps/api/v1/credits/summary/route.ts` -> `GET /api/v1/credits/summary`
- `cloud/apps/api/v1/app-credits/balance/route.ts` -> `GET /api/v1/app-credits/balance`
- `cloud/apps/api/stripe/create-checkout-session/route.ts` -> `POST /api/stripe/create-checkout-session`
- `cloud/apps/api/v1/credits/checkout/route.ts` -> `POST /api/v1/credits/checkout`
- `cloud/apps/api/v1/app-credits/checkout/route.ts` -> `POST /api/v1/app-credits/checkout`
- `cloud/apps/api/v1/stripe/checkout/route.ts` -> `POST /api/v1/stripe/checkout`
- `cloud/apps/api/billing/checkout/verify/route.ts` -> `GET /api/billing/checkout/verify`

Proposed owner: v1 owns new org/app/payment-request flows. Root `/api/credits/*`, `/api/stripe/*`, and `/api/billing/*` are compatibility or UX fallback surfaces. `/api/credits/balance` and `/api/v1/credits/balance` are closest to direct duplicates because both use `getCreditBalanceResponse`; checkout routes are not direct duplicates because request schemas and redirect handling differ.

Parity tests required:

- Snapshot response body for balance routes with the same organization row.
- Checkout schema tests for `creditPackId`, `amount`, `credits`, `success_url`, `cancel_url`, custom packs, and app-specific checkout.
- Stripe metadata parity: `organization_id`, `user_id`, `credits`, `type`, customer creation, and redirect validation.
- Billing success fallback test for webhook-missed checkout verification before removing `/api/billing/checkout/verify`.

### Cloud voice provider aliases

Direct aliases:

- `cloud/apps/api/elevenlabs/tts/route.ts` forwards `POST /api/elevenlabs/tts` to `/api/v1/voice/tts`.
- `cloud/apps/api/elevenlabs/stt/route.ts` forwards `POST /api/elevenlabs/stt` to `/api/v1/voice/stt`.

Related but not equivalent:

- `cloud/apps/api/elevenlabs/voices/route.ts` lists ElevenLabs public/premade voices.
- `cloud/apps/api/v1/voice/list/route.ts` lists user-cloned voices for an org.
- `cloud/apps/api/elevenlabs/voices/[id]/route.ts`, `clone`, `jobs`, `user`, and `verify/[id]` each need separate mapping decisions.

Proposed owner: v1 voice owns provider-agnostic TTS/STT. Keep provider-specific aliases with deprecation headers until SDK/public-route clients stop using them. Do not collapse voice-list routes without a product decision because public premade voices and org cloned voices are different resources.

Parity tests required:

- Forwarded method/body/header preservation for TTS/STT, including multipart STT.
- Credit reservation/billing parity through the v1 implementation.
- Audio response headers and streaming/body behavior.

### Cloud anonymous-session and auth session surfaces

Routes:

- `cloud/apps/api/anonymous-session/route.ts` -> `GET /api/anonymous-session` polling by token.
- `cloud/apps/api/auth/anonymous-session/route.ts` -> `POST /api/auth/anonymous-session` get-or-create with cookie.
- `cloud/apps/api/auth/create-anonymous-session/route.ts` -> `GET /api/auth/create-anonymous-session` create and redirect.
- `cloud/apps/api/set-anonymous-session/route.ts` -> `POST /api/set-anonymous-session` set cookie from supplied token.
- `cloud/apps/api/sessions/current/route.ts` -> `GET /api/sessions/current`.
- `cloud/apps/api/users/me/route.ts` -> `GET /api/users/me`.

Proposed owner: keep all for now, but document them as separate intents. They are not safe duplicates: token polling, cookie get-or-create, redirect creation, and explicit cookie setting have different threat models.

Parity tests required before any deletion:

- Anonymous cookie flags, expiry env names, token validation, inactive/expired session behavior, and return URL validation.
- Authenticated versus anonymous identity shape for `/api/users/me` and session stats.

### Cloud mounted stubs and backend slop

Mounted stubs/partial routes found by source scan:

- `cloud/apps/api/eliza-app/webhook/blooio/route.ts`
- `cloud/apps/api/eliza-app/webhook/discord/route.ts`
- `cloud/apps/api/eliza-app/webhook/telegram/route.ts`
- `cloud/apps/api/eliza-app/webhook/whatsapp/route.ts`
- `cloud/apps/api/eliza/rooms/route.ts`
- `cloud/apps/api/eliza/rooms/[roomId]/route.ts`
- `cloud/apps/api/eliza/rooms/[roomId]/messages/route.ts`
- `cloud/apps/api/eliza/rooms/[roomId]/messages/stream/route.ts`
- `cloud/apps/api/training/vertex/tune/route.ts`
- `cloud/apps/api/v1/admin/docker-containers/[id]/logs/route.ts`
- `cloud/apps/api/v1/admin/docker-containers/audit/route.ts`
- `cloud/apps/api/v1/admin/infrastructure/route.ts`
- `cloud/apps/api/v1/admin/infrastructure/containers/actions/route.ts`
- `cloud/apps/api/v1/apis/streaming/sessions/[id]/route.ts`
- `cloud/apps/api/v1/connections/[platform]/route.ts`
- `cloud/apps/api/v1/containers/[id]/metrics/route.ts`
- `cloud/apps/api/v1/containers/[id]/route.ts`

Proposed owner: these should either become real Worker-compatible implementations or be explicitly moved to an agent/server-sidecar API plane. Deleting them from the Worker route tree is a breaking change because they are currently mounted and return deterministic 501/stub responses.

Parity tests required:

- Frontend gap audit must classify no used path as `hono-stub` unless product explicitly accepts a 501.
- For sidecar-owned routes, tests must assert the frontend resolves the sidecar base URL instead of Cloud Worker.

## Local Agent And App-Core Shadowed Routes

These same-path local routes are not automatically deletable because app-core wraps the upstream agent server and intercepts some requests before upstream dispatch.

| Route | Files | Proposed owner | Deletion gate |
| --- | --- | --- | --- |
| `POST /api/agent/reset` | `packages/agent/src/api/agent-admin-routes.ts`; `packages/app-core/src/api/server.ts` | app-core owns desktop reset; agent owns standalone reset | Extract shared reset service or delegate app-core to agent with hooks. Test config, PGlite state dir, cloud secrets, wallet secrets, and restart behavior. |
| `GET /api/agents` | `packages/agent/src/api/server.ts`; `packages/app-core/src/api/server.ts` | agent owns standalone health/name lookup; app-core can be adapter | Paired standalone/app-core tests for response `agents[]`, id fallback, status, and auth. |
| `GET /api/auth/me` | `packages/agent/src/api/auth-routes.ts`; `packages/app-core/src/api/auth-session-routes.ts` | app-core owns cookie/session dashboard auth; agent owns bearer/local standalone auth | Do not merge until session, CSRF, bootstrap, static token, and local trust cases are in one matrix. |
| `GET /api/auth/status`, `POST /api/auth/pair` | `packages/agent/src/api/auth-routes.ts`; `packages/app-core/src/api/auth-pairing-routes.ts` | app-core owns desktop pairing; agent route remains standalone-only | Existing agent comment says app-core shadows `POST /api/auth/pair`; codify that in an allowlist and tests. |
| `POST /api/background/run-due-tasks` | `packages/agent/src/api/background-tasks-routes.ts`; `packages/app-core/src/api/background-tasks-routes.ts` | shared implementation should live in one module | The implementations are near-duplicates; extract a pure handler or delegate, then run both existing tests. |
| `GET /api/config`, `POST /api/config/reload`, `GET /api/config/schema` | `packages/agent/src/api/config-routes.ts`; `packages/app-core/src/api/server.ts` | agent owns config API; app-core should only wrap auth/filtering if needed | Compare redaction, hot reload diff, provider selection patching, and cloud-mode filtering. |
| `/api/local-inference/*` | `packages/app-core/src/api/local-inference-compat-routes.ts`; `plugins/plugin-local-inference/src/local-inference-routes.ts` | split desktop/plugin owners until shared service exists | App-core has richer auth, HF search, overrides, device streams. Plugin implementation has mobile/local bridge behavior. Do not delete either without host-specific tests. |
| `/api/computer-use/*` | `plugins/plugin-computeruse/src/routes/computer-use-compat-routes.ts`; `plugins/plugin-computeruse/src/routes/computer-use-routes.ts`; registered in `plugins/plugin-computeruse/src/index.ts` | compat route handler is canonical | Remove empty fallback only after import search and plugin-route e2e prove all hosts use `computerUseRouteHandler()`. |
| `/api/browser-bridge/*`, `/api/browser-workspace/*` | inline fallback in `packages/agent/src/api/server.ts`; plugin handlers in `plugins/plugin-browser/src/routes/bridge.ts` and `workspace.ts` | plugin-browser owns real behavior | Inline fallbacks return empty snapshots/package helpers. Delete only after plugin route load is mandatory in relevant builds. |
| `GET/POST /api/workbench/todos` | `packages/agent/src/api/workbench-routes.ts`; `packages/app-core/src/api/workbench-compat-routes.ts` | agent owns workbench API; app-core compat should delegate or retire | Compare tag normalization, task shape, todo metadata, completion/update semantics. |
| `/api/cloud/status`, `/api/cloud/credits`, `/api/cloud/relay-status`, `/api/cloud/billing/*`, `/api/cloud/compat/*`, `/api/cloud/v1/*` | `packages/app-core/src/api/server.ts`; `packages/agent/src/api/server-route-dispatch.ts`; `plugins/plugin-elizacloud/src/plugin.ts` and `routes/*` | plugin-elizacloud owns `/api/cloud/*`; app-core keeps pre-dispatch exceptions | Deletion requires proof that plugin route dispatch has fresh config and mode guard behavior for billing/compat proxies. |

## Duplicate Types And Symbols

### Route and server state types

Candidates:

- `AgentStartupDiagnostics`: `packages/agent/src/api/server-helpers.ts` and `packages/agent/src/api/server-types.ts`.
- `ConversationMeta`: `packages/agent/src/api/server-helpers.ts` and `packages/agent/src/api/server-types.ts`.
- `StreamEventType` and `StreamEventEnvelope`: `packages/agent/src/api/plugin-discovery-helpers.ts` and `packages/agent/src/api/server-types.ts`.

Proposed owner: `packages/agent/src/api/server-types.ts`. Convert other files to imports/re-exports after circular imports are checked.

Parity tests:

- Typecheck agent, app-core, app-training, app-lifeops, and app-steward consumers.
- Add a type-only smoke test if the package API keeps exporting these names.

### Auth/security helpers

Candidates:

- `extractAuthToken`: `packages/agent/src/api/server-auth.ts` and `packages/agent/src/api/server-helpers-auth.ts`.
- `getConfiguredApiToken`: `packages/agent/src/api/server-auth.ts` and `packages/agent/src/api/server-helpers-auth.ts`.
- `isTrustedLocalRequest`: `packages/agent/src/api/server-auth.ts`, `packages/agent/src/api/server-helpers-auth.ts`, and `packages/app-core/src/api/compat-route-shared.ts`.
- `isSafeResetStateDir`: `packages/agent/src/api/server-auth.ts`, `packages/agent/src/api/server-helpers-config.ts`, and `packages/app-core/src/api/server-startup.ts`.
- `resolveTerminalRunRejection`, `resolveWebSocketUpgradeRejection`, `resolveWalletExportRejection`, and `resolveMcpTerminalAuthorizationRejection` also have agent/app-core mirror implementations or wrappers.

Proposed owner: pure auth/security helpers should move to `@elizaos/shared` or a single agent module with app-core importing from it. Keep app-core-specific session/bootstrap wrappers local.

Parity tests:

- Loopback trust matrix: remote address, Host, Origin, Referer, `sec-fetch-site`, proxy headers, cloud-provisioned env, and `ELIZA_REQUIRE_LOCAL_AUTH`.
- Timing-safe token comparison and header precedence.
- WebSocket query/header auth cases.

### Cloud API/client types

Candidates duplicated across `plugins/plugin-elizacloud/src/types/cloud.ts` and `plugins/plugin-elizacloud/src/utils/cloud-sdk/types.ts`:

- `ContainerStatus`
- `ContainerBillingStatus`
- `ContainerArchitecture`
- `CloudContainer`
- `CreateContainerRequest`
- `CreateContainerResponse`
- `ContainerListResponse`
- `ContainerGetResponse`
- `ContainerHealthResponse`
- `AgentSnapshot`
- `SnapshotListResponse`
- `GatewayRelaySession`
- `GatewayRelayRequest`
- `GatewayRelayResponse`
- `RegisterGatewayRelaySessionResponse`
- `PollGatewayRelayResponse`

Important risk: some similarly named types are not identical. For example `CreateContainerRequest` in `types/cloud.ts` uses fields such as `ecr_image_uri`, `ecr_repository_uri`, `image_tag`, and `architecture`; `utils/cloud-sdk/types.ts` uses `image` for the direct Hetzner/Docker backend shape. Do not blindly re-export by name.

Proposed owner: SDK wire contracts should live in `plugins/plugin-elizacloud/src/utils/cloud-sdk/types.ts` or the real cloud SDK package. Plugin-internal service shapes should either import those contracts or be renamed to make backend specificity explicit.

Parity tests:

- Type-level assignability tests for SDK request/response contracts.
- Runtime client tests against Worker route fixtures for containers, jobs, snapshots, gateway relay, credits, and redemptions.

### Workflow/conversation overlap

Candidates:

- `ConversationScope`, `ConversationAutomationType`, and `ConversationMetadata`: `packages/agent/src/api/server-types.ts` and `plugins/plugin-workflow/src/lib/automations-types.ts`.
- `isAutomationConversationMetadata`: `packages/agent/src/api/conversation-metadata.ts` and `plugins/plugin-workflow/src/lib/automations-types.ts`.
- `WorkbenchTaskView`: `packages/agent/src/api/workbench-helpers.ts` and `plugins/plugin-workflow/src/lib/automations-types.ts`.

Proposed owner: shared conversation/workbench UI contract should move to `@elizaos/shared` if plugin-workflow must not depend on `@elizaos/agent`.

Parity tests:

- Type-only tests in agent and workflow.
- Automation UI route tests for draft/task metadata.

## Barrels And Re-exports

High-risk barrels/re-export shims:

- `packages/agent/src/api/index.ts`: broad public barrel exporting route internals, helpers, plugin route adapters, wallet helpers, training helpers, and zip utilities.
- `packages/agent/src/api/server.ts`: still re-exports helper functions for backwards compatibility after extraction.
- `plugins/plugin-elizacloud/src/index.node.ts`: re-exports node-only route handlers and cloud helpers.
- `plugins/plugin-elizacloud/src/index.browser.ts`: browser no-op stubs for node-only names, ending with `export * from "./types"`.
- `plugins/plugin-elizacloud/src/utils/cloud-sdk/index.ts`: SDK barrel re-exporting client, HTTP, public routes, and `export type * from "./types.js"`.
- `plugins/plugin-local-inference/src/index.ts`: thin public re-export of `handleLocalInferenceRoutes` and local inference symbols.

Proposed rule: convert broad barrels to explicit public allowlists only after a downstream import inventory. Do not delete browser no-op stubs unless app-core/browser bundle tests prove the named exports are no longer statically required.

Import-risk examples from current tree:

- `plugins/app-training` imports `Trajectory`, `createZipArchive`, and training helpers from `@elizaos/agent`.
- `plugins/app-steward` imports route/helper symbols such as `loadElizaConfig`, `persistConfigEnv`, `extractCompatTextContent`, `createIntegrationTelemetrySpan`, and wallet helpers from `@elizaos/agent`.
- `plugins/app-lifeops` imports `handleConnectorAccountRoutes`, `CloudProxyConfigLike`, `hasOwnerAccess`, scheduling helpers, OAuth helpers, and telemetry helpers from `@elizaos/agent`.
- `packages/app-core` imports many root `@elizaos/agent` symbols plus deep API modules such as `@elizaos/agent/api/conversation-metadata` in generated desktop bundles.

Deletion gate: run a package API report before changing barrels, then migrate consumers in separate commits.

## Backend Slop Candidates

These are dry-run cleanup candidates, not approved deletions:

- `packages/agent/src/api/*.d.ts` and `packages/agent/src/api/*.d.ts.map`: 192 generated artifacts under source. Proposed action: verify they are not intentional source-of-truth exports, remove from source tree, and ensure build emits declarations only into `dist`.
- `cloud/apps/api/test/INVENTORY.md`, `FRONTEND_GAPS.md`, and `COVERAGE.md`: generated docs appear stale versus current `529` mounted routes. Proposed action: regenerate in a dedicated docs-only update after code owners approve.
- Comment-only extraction breadcrumbs in `packages/agent/src/api/server.ts` and `packages/app-core/src/api/server.ts`: keep while ownership is unclear; remove only after route ownership map and tests exist.
- Cloud Worker stubs returning deterministic 501/stub payloads: either real implementation or explicit sidecar ownership, not silent deletion.
- Empty/fallback route implementations such as `plugins/plugin-computeruse/src/routes/computer-use-routes.ts`: keep until import graph proves unused.

## Parity Test Matrix Required Before Deletion

Minimum route parity dimensions:

- Method, path, query, body schema, content type, CORS, cache headers, auth headers/cookies, rate limits, status code, response body shape, error body shape, telemetry/log side effects, DB writes, queue/enqueue behavior, and idempotency behavior.
- Host mode: Cloud Worker, standalone agent server, app-core wrapped desktop server, mobile/Capacitor host, and cloud-provisioned container.
- Auth mode: unauthenticated, trusted loopback, bearer/API token, cookie session, bootstrap token, service key, service JWT, wrong org, and expired token.
- Streaming mode: SSE heartbeat/close behavior for local inference, computer-use approvals, streaming/chat, and room/message streams.

Suggested targeted tests to add before deletion:

- Cloud compat/v1 agent lifecycle golden tests covering `/api/compat/agents*` and `/api/v1/agents*`.
- Cloud credits/checkout alias tests covering `/api/credits/balance`, `/api/v1/credits/balance`, `/api/stripe/create-checkout-session`, and `/api/v1/credits/checkout`.
- Cloud ElevenLabs alias tests proving same-origin forward preserves request body and response headers.
- Local route shadow tests that start both standalone `@elizaos/agent` and app-core-wrapped servers, then exercise `/api/auth/*`, `/api/agent/reset`, `/api/agents`, `/api/config`, and `/api/background/run-due-tasks`.
- Local inference host tests for app-core desktop and plugin-local-inference/mobile behavior.
- Plugin route loading tests proving browser/computer-use/workflow routes are registered before deleting inline fallbacks.

## Validation Commands

Run after implementation, not during the dry run:

```sh
node - <<'NODE'
import { collectRouteEntries } from './cloud/apps/api/src/_generate-router.mjs';
const result = await collectRouteEntries(new URL('./cloud/apps/api', import.meta.url).pathname);
const seen = new Map();
const duplicates = [];
for (const entry of result.entries) {
  if (seen.has(entry.path)) duplicates.push([entry.path, seen.get(entry.path), entry.import]);
  else seen.set(entry.path, entry.import);
}
console.log({ routeFiles: result.files.length, mounted: result.entries.length, unconverted: result.unconverted, duplicates });
if (result.unconverted || duplicates.length) process.exit(1);
NODE
```

```sh
bun run --cwd cloud/apps/api codegen
git diff --exit-code cloud/apps/api/src/_router.generated.ts
bun run --cwd cloud/apps/api typecheck
bun run --cwd cloud/apps/api test:audit
bun run --cwd cloud test:e2e:api
```

```sh
bun run --cwd packages/agent typecheck
bun run --cwd packages/agent test -- src/api/background-tasks-routes.test.ts src/api/connector-account-routes.test.ts src/api/permissions-routes.test.ts src/api/workbench-vfs-routes.test.ts
bun run --cwd packages/app-core typecheck
bun run --cwd packages/app-core test -- src/api/auth-pairing-routes.test.ts src/api/auth-session-routes.real.test.ts src/api/background-tasks-routes.test.ts src/api/local-inference-compat-routes.test.ts src/api/server-reset-hop.test.ts
```

```sh
bun run audit:package-barrels:check
bun run knip:strict
bun run test:server
```

## Risks

- Same path does not mean same route owner. In app-core, pre-dispatch routes can shadow upstream agent routes intentionally.
- Auth semantics differ sharply across route planes. Collapsing `/api/auth/*` or `/api/cloud/*` without session/bootstrap/service-key tests can create auth bypasses or lockouts.
- Compat envelopes are product contracts. `/api/compat/*` often returns `envelope(...)` or `errorEnvelope(...)`; v1 routes often return `{ success, data }` or raw resource shapes.
- Some duplicate type names are semantically different. `CreateContainerRequest` is a known example.
- Browser stubs may look dead but exist to satisfy static bundling.
- Cloud Worker stubs returning 501 may be preferable to 404 for current frontend behavior; deletion can break feature detection.
- Generated declaration files under `packages/agent/src/api` may be referenced by package exports or build scripts; prove they are artifacts before deletion.
- The worktree was already dirty during this audit, so implementation waves must avoid reverting unrelated changes.

## Staged Implementation Checklist

1. Freeze ownership map.
   - Add a route ownership allowlist for local same-path shadows.
   - Record which routes are canonical, compatibility, sidecar-owned, or stubbed.

2. Add parity tests before code movement.
   - Cover Cloud compat/v1 aliases.
   - Cover app-core shadow routes versus standalone agent routes.
   - Cover route plugin registration for browser, computer-use, workflow, and elizacloud.

3. Collapse exact duplicate implementations only.
   - Start with `POST /api/background/run-due-tasks` because agent/app-core implementations are near-identical.
   - Then route aliases that already forward, such as `POST /api/elevenlabs/tts` and `POST /api/elevenlabs/stt`, by making the alias policy explicit rather than duplicating logic.

4. Move shared types.
   - Promote `server-types.ts` duplicates to single imports.
   - Split or rename non-identical cloud SDK/plugin container types.
   - Move cross-package workflow/conversation contracts to `@elizaos/shared` if needed.

5. Narrow barrels.
   - Inventory all `@elizaos/agent` root and deep API imports.
   - Create explicit public API allowlist.
   - Migrate internal plugin imports before removing route internals from barrels.

6. Retire compatibility routes in stages.
   - Add deprecation headers or telemetry first.
   - Update SDK/frontend callers.
   - Require zero traffic or an explicit owner signoff.
   - Delete route file, regenerate Worker router, and run validation.

7. Clean backend artifacts.
   - Remove checked-in `packages/agent/src/api/*.d.ts` and `*.d.ts.map` only after package build/export tests prove declarations are emitted from `dist`.
   - Regenerate stale Cloud API audit docs in a docs-only commit.

8. Final gates.
   - Cloud route generated diff clean.
   - Typecheck all touched packages.
   - Targeted route tests pass.
   - `knip:strict` and package barrel audit pass or have documented owner exceptions.
