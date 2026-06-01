# @elizaos/plugin-elizacloud

Eliza Cloud integration — multi-model inference, container provisioning, agent bridge, and billing for elizaOS agents.

## Purpose / role

Connects an Eliza agent to Eliza Cloud for hosted AI inference (text, embeddings, TTS, STT, image), container lifecycle management, real-time agent bridging via WebSocket, and billing/credit flows. Auto-enables when `ELIZAOS_CLOUD_API_KEY` or `ELIZAOS_CLOUD_ENABLED=true` is present (see `auto-enable.ts`). This plugin has priority 50, which means it wins the default text-generation slot over other direct provider plugins (priority 0) when no explicit routing preference is configured.

The plugin has two distinct export surfaces:

- **`elizaOSCloudPlugin`** (`src/index.ts`) — inference model handlers, cloud providers, and cloud services. Safe in both browser and Node.
- **`elizaCloudRoutePlugin`** (`src/plugin.ts`) — registers `/api/cloud/*` HTTP routes. Node-only; loaded lazily via `src/register-routes.ts`.

## Plugin surface

### Model handlers (registered in `models` map)

| Slot | Handler | File |
|---|---|---|
| `TEXT_EMBEDDING` | `handleTextEmbedding` | `src/models/embeddings.ts` |
| `TEXT_NANO` | `handleTextNano` | `src/models/text.ts` |
| `TEXT_SMALL` | `handleTextSmall` | `src/models/text.ts` |
| `TEXT_MEDIUM` | `handleTextMedium` | `src/models/text.ts` |
| `TEXT_LARGE` | `handleTextLarge` | `src/models/text.ts` |
| `TEXT_MEGA` | `handleTextMega` | `src/models/text.ts` |
| `RESPONSE_HANDLER` | `handleResponseHandler` | `src/models/text.ts` |
| `ACTION_PLANNER` | `handleActionPlanner` | `src/models/text.ts` |
| `RESEARCH` | `handleResearch` | `src/models/research.ts` |
| `IMAGE` | `handleImageGeneration` | `src/models/image.ts` |
| `IMAGE_DESCRIPTION` | `handleImageDescription` | `src/models/image.ts` |
| `TEXT_TO_SPEECH` | `handleTextToSpeech` | `src/models/speech.ts` |

### Providers

| Name | File | Description |
|---|---|---|
| `elizacloud_status` | `src/cloud-providers/cloud-status.ts` | Container and connection status (position 90, contexts: settings/finance) |
| `elizacloud_credits` | `src/cloud-providers/credit-balance.ts` | Credit balance with 60 s cache, low/critical alerts (position 91) |
| `elizacloud_health` | `src/cloud-providers/container-health.ts` | Container health approximation from cached state; private (position 92) |
| `elizacloud_models` | `src/cloud-providers/model-registry.ts` | Available models grouped by provider, 5 min cache (position 92) |

### Services (started in dependency order)

| Service type | Class | File | Description |
|---|---|---|---|
| `CLOUD_AUTH` | `CloudAuthService` | `src/services/cloud-auth.ts` | Auth entry points — device auto-signup and Cloud SSO OAuth flow |
| `CLOUD_BOOTSTRAP` | `CloudBootstrapServiceImpl` | `src/services/cloud-bootstrap.ts` | Exposes Cloud trust-anchor (JWKS URL, issuer, container id) without importing app-core |
| `CLOUD_RELAY` | `CloudManagedGatewayRelayService` | `src/services/cloud-managed-gateway-relay.ts` | Long-poll relay enabling Cloud to push requests to a local agent |
| `CLOUD_MODEL_REGISTRY` | `CloudModelRegistryService` | `src/services/cloud-model-registry.ts` | Fetches and caches available models from Cloud (30 min TTL) |
| `CLOUD_CONTAINER` | `CloudContainerService` | `src/services/cloud-container.ts` | ECS container lifecycle: create, list, poll status, delete |
| `CLOUD_BRIDGE` | `CloudBridgeService` | `src/services/cloud-bridge.ts` | JSON-RPC 2.0 WebSocket bridge to cloud-hosted agents with exponential-backoff reconnect |
| `CLOUD_BACKUP` | `CloudBackupService` | `src/services/cloud-backup.ts` | Agent state snapshots/restore; periodic auto-backup and pre-eviction snapshots |
| `workflow_credential_provider` | `CloudCredentialProvider` | `src/services/cloud-credential-provider.ts` | Bridges plugin-workflow's credential slot to Cloud OAuth connector surface |

### Events

| Event | Handler | File |
|---|---|---|
| `MODEL_USED` | `createWaifuMeteringHandler()` | `src/utils/waifu-metering.ts` |

Forwards per-inference token and USD spend to the Cloud metering endpoint when the container is a hosted agent. No-op otherwise.

### Routes (via `elizaCloudRoutePlugin`)

All paths use `rawPath: true`. Handled by three route groups:

- **Status** (`handleCloudStatusRoutes`): `GET /api/cloud/status`, `GET /api/cloud/credits`
- **Cloud routes** (`handleCloudRoute`): login, disconnect, relay-status, agents provisioning/connect/shutdown, coding-container create/sync/promotions
- **Billing proxy** (`handleCloudBillingRoute`): `GET|POST|PUT|PATCH|DELETE /api/cloud/billing/:path*` — forwards to authenticated Cloud API

## Layout

```
plugins/plugin-elizacloud/
  src/
    index.ts                        Main plugin object (elizaOSCloudPlugin)
    index.node.ts                   Node-specific re-exports
    index.browser.ts                Browser-compatible build entry
    plugin.ts                       Route-only plugin (elizaCloudRoutePlugin)
    register-routes.ts              Lazy-loads route plugin via registerAppRoutePluginLoader
    init.ts                         OpenAI-compatible client initialization
    auto-enable.ts                  Auto-enable check (reads ELIZAOS_CLOUD_API_KEY / ELIZAOS_CLOUD_ENABLED)
    cloud-setup.ts                  Interactive Cloud setup flow (runCloudSetup)
    cloud-voice-catalog.ts          Fetches available TTS voice catalog from Cloud
    models/
      text.ts                       Text generation handlers for all model tiers
      embeddings.ts                 TEXT_EMBEDDING handler
      image.ts                      IMAGE and IMAGE_DESCRIPTION handlers
      speech.ts                     TEXT_TO_SPEECH handler + CloudTtsUnavailableError
      research.ts                   RESEARCH handler
      transcription.ts              TRANSCRIPTION handler
      tokenization.ts               TEXT_TOKENIZER_ENCODE/DECODE handlers
      index.ts                      Re-exports all model handlers
    services/
      cloud-auth.ts                 CloudAuthService (CLOUD_AUTH)
      cloud-bootstrap.ts            CloudBootstrapServiceImpl (CLOUD_BOOTSTRAP)
      cloud-managed-gateway-relay.ts CloudManagedGatewayRelayService (CLOUD_RELAY)
      cloud-model-registry.ts       CloudModelRegistryService (CLOUD_MODEL_REGISTRY)
      cloud-container.ts            CloudContainerService (CLOUD_CONTAINER)
      cloud-bridge.ts               CloudBridgeService (CLOUD_BRIDGE)
      cloud-backup.ts               CloudBackupService (CLOUD_BACKUP)
      cloud-credential-provider.ts  CloudCredentialProvider (workflow_credential_provider)
    cloud-providers/
      cloud-status.ts               elizacloud_status provider
      credit-balance.ts             elizacloud_credits provider
      container-health.ts           elizacloud_health provider
      model-registry.ts             elizacloud_models provider
    routes/
      cloud-routes.ts               Core cloud login/disconnect/agent routes
      cloud-routes-autonomous.ts    Autonomous-mode cloud route handler
      cloud-status-routes.ts        /api/cloud/status and /api/cloud/credits
      cloud-billing-routes.ts       /api/cloud/billing/* proxy
      cloud-relay-routes.ts         Relay-status route
      cloud-provisioning.ts         isCloudProvisionedContainer helper
      cloud-coding-container-routes.ts  Coding-container management
      cloud-compat-routes.ts        Compat route shims
      cloud-features-routes.ts      Feature-flag routes
    cloud/
      auth.ts                       Auth helpers
      auth-service-types.ts         CloudAuthApiKeyService interface
      base-url.ts                   resolveCloudApiBaseUrl, normalizeCloudSiteUrl
      bridge-client.ts              ElizaCloudClient, CloudWalletDescriptor
      cloud-api-key.ts              resolveCloudApiKey, normalizeCloudApiKey
      cloud-manager.ts              CloudManager orchestrator
      cloud-proxy.ts                Proxy utilities
      cloud-wallet.ts               Wallet descriptor types
      clack-observer.ts             ClackObserver (interactive CLI setup feedback)
      null-observer.ts              NullCloudSetupObserver
      setup-observer.ts             CloudSetupObserver interface
      reconnect.ts                  Reconnect helpers
      validate-url.ts               validateCloudBaseUrl
      index.ts                      Barrel
    lib/
      cloud-connection.ts           CloudAuthLike interface
      cloud-secrets.ts              getCloudSecret, clearCloudSecrets, scrubCloudSecretsFromEnv
      config-env.ts                 Env-to-config mapping
      config-like.ts                ElizaConfig type
      credential-type-map.ts        credTypeToConnector mapping
      feature-flags.ts              Feature flag helpers
      http.ts                       sendJson HTTP helper
      server-cloud-tts.ts           TTS compat layer, resolveCloudTtsBaseUrl
      state-paths.ts                State directory path helpers
      tts-debug.ts                  TTS debug utilities
    providers/
      openai.ts                     createOpenAIClient (Vercel AI SDK OpenAI-compatible adapter)
    utils/
      cloud-api.ts                  CloudApiClient — base HTTP client for Cloud API
      sdk-client.ts                 createCloudApiClient, createElizaCloudClient
      waifu-metering.ts             createWaifuMeteringHandler (MODEL_USED event bridge)
      config.ts                     Model string resolution helpers (getNanoModel, getLargeModel, …)
      events.ts                     emitModelUsageEvent, ModelUsageEventMeta
      helpers.ts                    Misc internal helpers
      responses-output.ts           extractResponsesOutputText (Responses API output parser)
      cloud-sdk/                    Internal SDK surface wrappers
    types/
      cloud.ts                      CloudContainer, DevicePlatform, DEFAULT_CLOUD_CONFIG, and all Cloud API types
      index.ts                      Type barrel
  __tests__/
    unit/                           Unit tests (no live API)
    integration/                    Integration tests
    *.test.ts                       Feature-level test suites
  auto-enable.ts                    Auto-enable entry point (package.json elizaos.plugin.autoEnableModule)
  build.ts                          Dual-target (node + browser) build script
  package.json
```

## Commands

```bash
bun run --cwd plugins/plugin-elizacloud build       # compile node + browser bundles
bun run --cwd plugins/plugin-elizacloud typecheck   # type check only (tsgo --noEmit)
bun run --cwd plugins/plugin-elizacloud test        # run all tests via vitest
bun run --cwd plugins/plugin-elizacloud test:unit   # unit tests only
bun run --cwd plugins/plugin-elizacloud test:integration  # integration tests only
bun run --cwd plugins/plugin-elizacloud test:e2e    # live smoke test via app-core script
bun run --cwd plugins/plugin-elizacloud lint        # biome check --write --unsafe
bun run --cwd plugins/plugin-elizacloud clean       # rm -rf dist .turbo
```

## Config / env vars

All settings are optional except `ELIZAOS_CLOUD_API_KEY` (required for any authenticated call).

### Required

| Var | Description |
|---|---|
| `ELIZAOS_CLOUD_API_KEY` | API key (`eliza_xxxxx`). Get from https://www.elizacloud.ai/dashboard/api-keys |

### Optional — core

| Var | Default |
|---|---|
| `ELIZAOS_CLOUD_BASE_URL` | `https://www.elizacloud.ai/api/v1` |
| `ELIZAOS_CLOUD_ENABLED` | `false` — when true, enables container provisioning, device auth, bridge, and backup services |
| `ELIZAOS_CLOUD_EXPERIMENTAL_TELEMETRY` | `false` |
| `ELIZAOS_CLOUD_APP_VERSION` | `2.0.0-beta.0` |

### Optional — model tiers (each has a fallback bare env alias)

| Cloud var | Bare fallback | Default |
|---|---|---|
| `ELIZAOS_CLOUD_NANO_MODEL` | `NANO_MODEL` | `openai/gpt-oss-120b:nitro` |
| `ELIZAOS_CLOUD_SMALL_MODEL` | `SMALL_MODEL` | `openai/gpt-oss-120b:nitro` |
| `ELIZAOS_CLOUD_MEDIUM_MODEL` | `MEDIUM_MODEL` | `openai/gpt-oss-120b:nitro` |
| `ELIZAOS_CLOUD_LARGE_MODEL` | `LARGE_MODEL` | `openai/gpt-oss-120b:nitro` |
| `ELIZAOS_CLOUD_MEGA_MODEL` | `MEGA_MODEL` | falls back to large |
| `ELIZAOS_CLOUD_RESPONSE_HANDLER_MODEL` | `RESPONSE_HANDLER_MODEL` | nano model |
| `ELIZAOS_CLOUD_ACTION_PLANNER_MODEL` | `ACTION_PLANNER_MODEL` | medium model |
| `ELIZAOS_CLOUD_RESEARCH_MODEL` | `RESEARCH_MODEL` | large model |

### Optional — embeddings

| Var | Default |
|---|---|
| `ELIZAOS_CLOUD_EMBEDDING_MODEL` | `text-embedding-3-small` |
| `ELIZAOS_CLOUD_EMBEDDING_DIMENSIONS` | `1536` |
| `ELIZAOS_CLOUD_EMBEDDING_URL` | unset (uses base URL) |
| `ELIZAOS_CLOUD_EMBEDDING_API_KEY` | falls back to `ELIZAOS_CLOUD_API_KEY` |

### Optional — image / audio

| Var | Default |
|---|---|
| `ELIZAOS_CLOUD_IMAGE_DESCRIPTION_MODEL` | `gpt-5.4-mini` |
| `ELIZAOS_CLOUD_IMAGE_DESCRIPTION_MAX_TOKENS` | `8192` |
| `ELIZAOS_CLOUD_IMAGE_GENERATION_MODEL` | service default |
| `ELIZAOS_CLOUD_TTS_MODEL` | `gpt-5-mini-tts` |
| `ELIZAOS_CLOUD_TTS_VOICE` | `nova` |
| `ELIZAOS_CLOUD_TTS_INSTRUCTIONS` | unset |
| `ELIZAOS_CLOUD_TRANSCRIPTION_MODEL` | service default |

### Browser-only proxy vars (no secrets in client bundles)

| Var |
|---|
| `ELIZAOS_CLOUD_BROWSER_BASE_URL` |
| `ELIZAOS_CLOUD_BROWSER_EMBEDDING_URL` |

## How to extend

### Add a model handler

1. Add a handler function in the appropriate file under `src/models/`.
2. Export it from `src/models/index.ts`.
3. Register it in the `models` map in `src/index.ts` keyed by the `ModelType` constant.
4. Use `createCloudApiClient(runtime)` for raw API-base calls (see `src/utils/sdk-client.ts`).
5. Call `emitModelUsageEvent(runtime, type, prompt, usage, meta)` after each inference call.

### Add a provider

1. Create a new file in `src/cloud-providers/` exporting a `Provider` object.
2. Export it from `src/cloud-providers/index.ts`.
3. Add it to the `providers` array in `src/index.ts`.
4. Gate it with `contextGate` so it only fires in relevant context windows.

### Add a service

1. Create a new file in `src/services/` with a class extending `Service` from `@elizaos/core`.
2. Set a static `serviceType` string (used for `runtime.getService(...)` lookups).
3. Add it to the `services` array in `src/index.ts` in dependency order.
4. Add a matching `await runtime.getService(YourService.serviceType)?.stop()` line in `dispose()`.

## Conventions / gotchas

- **No direct `fetch()` for Cloud API calls.** Use `createCloudApiClient(runtime)` or `createElizaCloudClient(runtime)` from `src/utils/sdk-client.ts`. The one exception is the plugin test suite downloading a public audio fixture.
- **`ELIZAOS_CLOUD_ENABLED` gates infrastructure services.** When false, only inference model handlers are active. Container, bridge, backup, and relay services start only when this flag is true.
- **Browser build is separate.** `src/index.browser.ts` is the entry for `dist/browser/`. It must not import Node-only modules. The route plugin (`src/plugin.ts`) is Node-only and is excluded from the browser bundle.
- **Routes use `rawPath: true`.** All `/api/cloud/*` routes bypass the plugin-name prefix so paths stay stable.
- **TTS routing precedence.** This plugin's priority (50) does not govern TTS routing. The router-handler in `plugin-local-inference` runs at `MAX_SAFE_INTEGER` priority and enforces the `prefer-local` policy. Cloud TTS is a fallback; `CloudTtsUnavailableError` (from `src/models/speech.ts`) signals the router to try the next provider.
- **Services start in dependency order.** `CloudAuthService` must be first; every other service calls `runtime.getService("CLOUD_AUTH")`. `dispose()` stops them in reverse order.
- **`CloudBootstrapService` fails closed.** `getExpectedIssuer()` throws when `ELIZA_CLOUD_ISSUER` is unset. Never add a silent default — see `docs/security/remote-auth-hardening-plan.md` §3.2.
- **No `as` casts or `?? 0` fallbacks for missing pipeline data.** Follow the architecture rules in `AGENTS.md` at the repo root.
