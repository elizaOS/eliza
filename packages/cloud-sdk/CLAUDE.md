# @elizaos/cloud-sdk

TypeScript SDK for the Eliza Cloud API: auth, agent management, inference, billing, containers, and typed public-route access.

## Purpose / role

Provides `ElizaCloudClient` — a typed fetch wrapper for every endpoint exposed by `api.elizacloud.ai`. Used directly by `plugins/plugin-elizacloud` (for auth / agent lifecycle calls from inside an agent runtime) and `packages/ui` (for UI-layer Cloud API calls). The secondary export `./cloud-setup-session` ships a service interface and mock implementation for the guided-setup flow that runs when a new tenant provisions a Cloud container.

## Layout

```
packages/cloud-sdk/
  src/
    index.ts                  Main barrel — re-exports everything below
    client.ts                 ElizaCloudClient (the primary class; all high-level methods)
    http.ts                   ElizaCloudHttpClient, CloudApiClient, CloudApiError, InsufficientCreditsError
    types.ts                  All request/response interfaces + ElizaCloudClientOptions
    types.cloud-api.ts        DTOs mirrored from the Cloud API (CurrentUserDto, AgentDetailDto, etc.)
    public-routes.ts          ELIZA_CLOUD_PUBLIC_ENDPOINTS map + ElizaCloudPublicRoutesClient
                              (generated — do not hand-edit; refresh with bun run generate:routes)
    client.test.ts            Unit tests for ElizaCloudClient (mock fetch)
    live.e2e.test.ts          Live integration tests gated by env flags
    cloud-setup-session/
      index.ts                Barrel for the ./cloud-setup-session sub-export
      types.ts                SetupSessionEnvelope, SetupTranscriptMessage, SetupExtractedFact, etc.
      service-interface.ts    CloudSetupSessionService interface
      mock-service.ts         MockCloudSetupSessionService (for tests / dev without a live session)
      policy.ts               DEFAULT_SETUP_POLICY + isActionAllowed
      __tests__/              Unit tests for mock-service and policy
  scripts/
    generate-public-routes.mjs  Reads the Cloud API route tree; writes src/public-routes.ts
    audit-api-routes.mjs        Audits generated wrappers against live route inventory
    route-discovery.mjs         Shared route-discovery logic used by the two above
  build.ts                    Custom Bun build script (ESM output to dist/)
  vitest.live.config.ts       Vitest config for the live e2e suite
```

## Key exports / surface

### Default export (`@elizaos/cloud-sdk`)

```ts
import {
  ElizaCloudClient,       // Primary client class
  createElizaCloudClient, // Factory: new ElizaCloudClient(options)
  ElizaCloudHttpClient,   // Low-level HTTP class (GET/POST/PUT/PATCH/DELETE)
  CloudApiClient,         // ElizaCloudHttpClient subclass with unauthenticated helpers
  CloudApiError,          // Thrown on non-2xx (statusCode, errorBody)
  InsufficientCreditsError, // 402 specialisation of CloudApiError
  ELIZA_CLOUD_PUBLIC_ENDPOINTS, // Record of all generated route descriptors
  ElizaCloudPublicRoutesClient, // Typed wrappers for every public route
} from "@elizaos/cloud-sdk";
```

`ElizaCloudClient` method groups (all are Promise-based):

| Group | Methods |
|---|---|
| Auth | `startCliLogin`, `pollCliLogin`, `pairWithToken` |
| Inference | `listModels`, `createResponse`, `createChatCompletion`, `createEmbeddings`, `generateImage` |
| Credits | `getCreditsBalance`, `getCreditsSummary`, `createCreditsCheckout`, `getAppCreditsBalance`, `createAppCreditsCheckout`, `verifyAppCreditsCheckout` |
| App charges | `createAppCharge`, `listAppCharges`, `getAppCharge`, `createAppChargeCheckout` |
| X402 payments | `getX402Supported`, `verifyX402Payment`, `settleX402Payment`, `createX402PaymentRequest`, `listX402PaymentRequests`, `getX402PaymentRequest`, `settleX402PaymentRequest` |
| Affiliates | `getAffiliateCode`, `createAffiliateCode`, `updateAffiliateCode`, `linkAffiliateCode` |
| Earnings | `getAppEarnings`, `getAppEarningsHistory`, `withdrawAppEarnings` |
| Redemptions | `getRedemptionBalance`, `getRedemptionQuote`, `getRedemptionStatus`, `createRedemption`, `listRedemptions` |
| Containers | `listContainers`, `createContainer`, `getContainer`, `updateContainer`, `deleteContainer`, `getContainerHealth`, `getContainerMetrics`, `getContainerLogs`, `getContainerDeployments`, `getContainerQuota`, `createContainerCredentials` |
| Eliza agents | `listAgents`, `createAgent`, `getAgent`, `updateAgent`, `deleteAgent`, `provisionAgent`, `suspendAgent`, `resumeAgent`, `createAgentSnapshot`, `listAgentBackups`, `restoreAgentBackup`, `getAgentPairingToken` |
| Gateway relay | `registerGatewayRelaySession`, `pollGatewayRelayRequest`, `submitGatewayRelayResponse`, `disconnectGatewayRelaySession` |
| Jobs | `getJob`, `pollJob` |
| User | `getUser`, `updateUser` |
| API keys | `listApiKeys`, `createApiKey`, `updateApiKey`, `deleteApiKey`, `regenerateApiKey` |
| Workflows | `listWorkflows`, `createWorkflow`, `getWorkflow`, `updateWorkflow`, `deleteWorkflow`, `runWorkflow`, `getWorkflowExecution` |
| Generic | `request`, `requestRaw`, `callEndpoint`, `getOpenApiSpec` |

The `.routes` property on `ElizaCloudClient` is an `ElizaCloudPublicRoutesClient` instance providing one typed method per entry in `ELIZA_CLOUD_PUBLIC_ENDPOINTS`. JSON endpoints also have a `Raw` variant that returns `Response` (use for streaming).

### Sub-export (`@elizaos/cloud-sdk/cloud-setup-session`)

```ts
import type {
  CloudSetupSessionService,  // Interface: startSession / sendMessage / getStatus / finalizeHandoff / cancel
  SetupSessionEnvelope,
  SetupTranscriptMessage,
  SetupExtractedFact,
  ContainerHandoffEnvelope,
  SetupActionPolicy,
} from "@elizaos/cloud-sdk/cloud-setup-session";

import { MockCloudSetupSessionService, DEFAULT_SETUP_POLICY, isActionAllowed }
  from "@elizaos/cloud-sdk/cloud-setup-session";
```

## Commands

```bash
bun run --cwd packages/cloud-sdk build          # Compile to dist/ via build.ts
bun run --cwd packages/cloud-sdk typecheck      # tsgo --noEmit
bun run --cwd packages/cloud-sdk test           # Unit tests in src/
bun run --cwd packages/cloud-sdk test:e2e       # Live e2e (requires env flags below)
bun run --cwd packages/cloud-sdk lint           # biome check
bun run --cwd packages/cloud-sdk lint:fix       # biome check --write
```

Route generation (run from repo root via scripts/):

```bash
node packages/cloud-sdk/scripts/generate-public-routes.mjs  # Regenerate src/public-routes.ts
node packages/cloud-sdk/scripts/audit-api-routes.mjs        # Verify generated wrappers vs route tree
```

## Config / env vars

The SDK reads no env vars at runtime — callers must supply credentials via `ElizaCloudClientOptions`. The live e2e suite reads the following env flags:

| Variable | Purpose |
|---|---|
| `ELIZA_CLOUD_SDK_LIVE` | `"1"` to run any live tests |
| `ELIZAOS_CLOUD_API_KEY` / `ELIZA_CLOUD_API_KEY` | API key for authenticated checks |
| `ELIZA_CLOUD_SESSION_TOKEN` | Bearer token for browser-session checks |
| `ELIZA_CLOUD_BASE_URL` | Override base URL (default `https://www.elizacloud.ai`) |
| `ELIZA_CLOUD_API_BASE_URL` | Override API base URL (default `https://api.elizacloud.ai/api/v1`) |
| `ELIZA_CLOUD_SDK_LIVE_GENERATION` | `"1"` to enable paid generation checks |
| `ELIZA_CLOUD_SDK_LIVE_RELAY` | `"1"` to enable gateway relay checks |
| `ELIZA_CLOUD_SDK_LIVE_DESTRUCTIVE` | `"1"` + resource flag to allow create/mutate |
| `ELIZA_CLOUD_SDK_LIVE_CONTAINERS` | `"1"` + `ELIZA_CLOUD_SDK_CONTAINER_IMAGE_URI` |
| `ELIZA_CLOUD_SDK_LIVE_AGENT` | `"1"` to enable Eliza agent lifecycle checks |
| `ELIZA_CLOUD_SDK_LIVE_PROFILE_WRITE` | `"1"` + `ELIZA_CLOUD_SDK_PROFILE_FIELD` + `ELIZA_CLOUD_SDK_PROFILE_VALUE` to enable profile write checks |
| `ELIZA_CLOUD_SDK_LIVE_OPENAPI` | `"1"` to force the OpenAPI spec check |
| `ELIZA_CLOUD_PAIR_TOKEN` / `ELIZA_CLOUD_PAIR_ORIGIN` | Pairing token live test |

## How to extend

**Add a new API method to `ElizaCloudClient`:**

1. Add the request/response interfaces to `src/types.ts`.
2. Add the method to `ElizaCloudClient` in `src/client.ts`, using `this.request<T>` (or `this.v1.post/get` for `/api/v1` paths).
3. Re-export any new types from `src/index.ts` if callers need them.
4. Add a test in `src/live.e2e.test.ts` gated by the appropriate flag.

**Regenerate public routes after changing the Cloud API route tree:**

```bash
node packages/cloud-sdk/scripts/generate-public-routes.mjs
node packages/cloud-sdk/scripts/audit-api-routes.mjs
```

`src/public-routes.ts` is fully generated — never edit it by hand.

**Implement `CloudSetupSessionService` for production:**

Implement the five methods on the interface in `src/cloud-setup-session/service-interface.ts`. Use `MockCloudSetupSessionService` as the reference implementation. `DEFAULT_SETUP_POLICY` defines the allowed action types and token/turn budgets.

## Conventions / gotchas

- `ElizaCloudClient` exposes two auth surfaces: `apiKey` (sent as `Authorization: Bearer` and `X-API-Key`) and `bearerToken` (sent as `Authorization: Bearer` only). The bearer token wins over the API key when both are set. Call `setApiKey` / `setBearerToken` to update credentials on an existing instance without constructing a new one.
- `CloudApiError` is thrown on any non-2xx response; `InsufficientCreditsError` is its 402 specialisation and exposes `requiredCredits`.
- `cloud.v1` is a `CloudApiClient` scoped to the `/api/v1` base path. Use `cloud.v1.post("/foo", body)` instead of `cloud.request("POST", "/api/v1/foo", ...)` when targeting that prefix — it is shorter and avoids double-prefix bugs.
- `cloud.routes` methods are generated and include both a typed JSON method and a `Raw` variant returning `Response`. Use `Raw` for streaming endpoints.
- The `./cloud-setup-session` sub-export is a distinct entry point (`exports[./cloud-setup-session]`), not part of the root barrel. Import it separately.
- `src/types.cloud-api.ts` contains DTOs mirrored from the Cloud API schema. These must stay in sync with the actual API — do not add computed fields to them.
