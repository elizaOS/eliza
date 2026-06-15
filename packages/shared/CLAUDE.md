# @elizaos/shared

Shared cross-platform contract library for elizaOS: types, configuration schemas, API contracts, and runtime utilities consumed by every layer of the stack.

## Purpose / role

`@elizaos/shared` is the lowest-level internal package that can be imported by both Node.js server code and browser/React code without pulling in either runtime's native modules. It provides the HTTP API contract types, the full elizaOS configuration schema, Eliza Cloud helpers, local-inference metadata, brand tokens, connector status types, auth session helpers, and miscellaneous utilities. Consumers include `@elizaos/agent`, `@elizaos/app-core`, `@elizaos/ui`, `@elizaos/app`, `@elizaos/cloud-api`, `@elizaos/cloud-frontend`, `@elizaos/cloud-shared`, `@elizaos/os-homepage`, and `@elizaos/browser-bridge-extension`.

The barrel must stay runtime-agnostic: the only React touchpoint is a type-only `import type { ReactNode } from "react"` in `config/config-catalog.ts`, which is erased at compile time, so the root `src/index.ts` is safe to import from a Node.js or Bun server boot path.

## Layout

```
packages/shared/
  src/
    index.ts                     Root barrel — safe for server + browser import
    api/
      agent-api-types.ts         StreamEventEnvelope, TriggerTask*, AgentAutomationMode
      http-helpers.ts            HTTP fetch helpers (shared between agent and UI)
      route-helpers.ts           Typed route builder utilities
    config/
      types.ts                   Barrel re-exporter for the config sub-type files (types.agents, types.gateway, …)
      types.eliza.ts             Master ElizaConfig shape (~47 top-level config sections)
      schema.ts                  CONNECTOR_IDS list, config schema constants
      env-vars.ts                (empty; kept to satisfy deep imports)
      boot-config.ts             Re-export forwarder for boot-config-store (store-only, React-free)
      boot-config-store.ts       AppBootConfig global-singleton store (getBootConfig/setBootConfig)
      branding.ts                Per-distribution branding tokens
      plugin-manifest.ts         Plugin manifest schema
      plugin-ui-spec.ts          Plugin UI declarative spec types
      runtime-mode.ts            RuntimeModeConfig + isCloudRuntimeMode() helper
      zod-schema.*.ts            Zod validation schemas (agent-runtime, core)
      ...                        30+ additional config sub-modules
    contracts/
      index.ts                   Re-exports all API route contracts
      agent-routes.ts            /api/agents/* route types
      apps*.ts                   /api/apps/* route types
      auth-routes.ts             /api/auth/* route types
      wallet*.ts                 /api/wallet/* route types
      inbox*.ts, skills*.ts      Domain-specific route contracts
      service-routing.ts         DEFAULT_ELIZA_CLOUD_* model constants
      theme.ts                   ThemeDefinition (type contract only)
      ...                        40+ contract modules
    elizacloud/
      index.ts                   Cloud provisioning, secrets, TTS server helpers
      base-url.ts                Eliza Cloud base URL resolver
    local-inference/
      index.ts                   Types + helpers for local model inference
      catalog.ts                 MODEL_CATALOG, Eliza-1 tier IDs, HuggingFace URLs
      gpu-profiles.ts            GpuProfile, KvCacheType, matchGpuProfile
      kokoro/                    Kokoro TTS execution provider types
      manifest-signature.ts      Ed25519 manifest signature verification
      network-policy.ts          NetworkPolicyPreferences, evaluateNetworkPolicy
      paths.ts                   elizaModelsDir, localInferenceRoot, registryPath
      routing-preferences.ts     RoutingPreferences, readRoutingPreferences
      types.ts                   CatalogModel, DownloadJob, HardwareProbe, ModelHub*
      verify.ts                  verifyInstalledModel
      voice-models.ts            VoiceModelVersion, VOICE_MODEL_VERSIONS
    steward-session-client/
      index.ts                   STEWARD_TOKEN_KEY, syncStewardSession, exchangeStewardCode
    brand/
      index.ts                   EXTERNAL_URLS, color palette, font stacks
      brand.css                  CSS custom properties for brand tokens
    brand-classic/               Eliza Classic variant brand tokens
    awareness/
      registry.ts                Awareness registry helpers
    i18n/
      keyword-matching.ts        i18n keyword matching utilities
      keywords/                  Source *.keywords.json files (hand-authored input)
      generated/                 build:i18n output (validation-keyword-data; do not hand-edit)
    events/
      index.ts                   Typed eliza:* custom DOM event name constants
    types/
      index.ts                   Connector status types (WhatsApp/Telegram/Discord/…)
                                 ConfigUiHint, CronJob, SkillStatusEntry, TranslateFn
    utils/
      asset-url.ts               resolveAppAssetUrl(), resolveApiUrl() — public/ + API URL resolvers
      errors.ts                  errorMessage(), isTimeoutError(), isRedirectResponse() guards
      eliza-globals.ts           ElizaWindow type + getElizaApiBase()/getElizaApiToken()
      eliza-root.ts              resolveElizaPackageRoot(), resolveElizaPackageRootSync() — package root resolver
      rate-limiter.ts            RateLimiter interface + createRateLimiter() factory
      streaming-text.ts          mergeStreamingText(), computeStreamingDelta(), resolveStreamingUpdate()
      trajectory-format.ts       Trajectory log format helpers
      ...                        25+ additional utility modules
    runtime-env.ts               resolveRuntimePorts, resolveApiSecurityConfig
    connector-cred-types.ts      ConnectorCredentialType
    connectors.ts                Connector source alias helpers (normalizeConnectorSource, …)
    character-presets.ts         Built-in character preset definitions
    voice.ts                     Voice system types (VoicePreset, …)
    spoken-text.ts               Spoken text normalization
    self-edit.ts                 Self-edit gating helpers (isSelfEditEnabled, env constants)
    restart.ts                   Agent restart request types
    recent-messages-state.ts     getRecentMessagesData() state accessor
    format-error.ts              formatError(), formatErrorWithStack()
    env-utils.ts                 isTruthyEnvValue, env parsing helpers
    app-hero-art.ts              SVG/asset path constants
  assets/                        Static brand assets (logos, favicons, OG embeds)
  assets-classic/                Eliza Classic brand assets
  scripts/
    generate-keywords.mjs        Builds i18n keyword data → src/i18n/generated/
    sync-to-public.mjs           Copies assets to consumer public/ dirs
```

## Key exports / surface

All items below are re-exported from the root `@elizaos/shared` barrel unless noted.

**Config types** — `ElizaConfig` plus ~150 named sub-types defined across `src/config/types.*.ts` (`types.eliza`, `types.agents`, `types.gateway`, `types.hooks`, `types.messages`, `types.tools`, `types.agent-defaults`), barrel-collected by `src/config/types.ts` and aliased into the root barrel via the `export type { AgentConfig, … }` block in `src/index.ts`.

**Runtime env** — `resolveRuntimePorts`, `resolveApiSecurityConfig`, `ELIZA_RUNTIME_ENV_KEYS`, `isMobilePlatform` from `src/runtime-env.ts`. Key env vars read: `ELIZA_PORT`, `ELIZA_API_PORT`, `ELIZA_UI_PORT`, `ELIZA_API_BIND`, `ELIZA_API_TOKEN`, `ELIZA_ALLOWED_ORIGINS`, `ELIZA_ALLOWED_HOSTS`, `ELIZA_ALLOW_NULL_ORIGIN`, `ELIZA_DISABLE_AUTO_API_TOKEN`, `ELIZA_PLATFORM`.

**API contracts** — All `*-routes.ts` types in `src/contracts/` (agent, apps, auth, character, connectors, conversations, inbox, memory, plugins, skills, subscriptions, wallet, workbench, …). Import from `@elizaos/shared` root.

**Steward auth** — `syncStewardSession`, `exchangeStewardCode`, `clearStewardSession`, `readStoredStewardToken`, `STEWARD_TOKEN_KEY`, `STEWARD_SESSION_ENDPOINT`, `StewardSessionError` from `@elizaos/shared/steward-session-client`.

**Local-inference metadata** — `MODEL_CATALOG`, `ELIZA_1_TIER_IDS`, `GPU_PROFILES`, `matchGpuProfile`, `verifyInstalledModel`, `readRoutingPreferences`, `evaluateNetworkPolicy`, `VOICE_MODEL_VERSIONS`, `verifyManifestSignature` from `@elizaos/shared/local-inference`.

**Brand** — `EXTERNAL_URLS`, palette constants from `@elizaos/shared/brand`; CSS via `@elizaos/shared/brand.css`.

**Events** — `AGENT_READY_EVENT`, `BRIDGE_READY_EVENT`, `COMMAND_PALETTE_EVENT`, `NETWORK_STATUS_CHANGE_EVENT`, … from `src/events/index.ts`.

**Eliza Cloud helpers** — `@elizaos/shared/elizacloud` (base URL resolver, cloud provisioning types, server TTS helpers).

**Config sub-path exports** — `@elizaos/shared/config/allowed-hosts`, `@elizaos/shared/runtime-env`, `@elizaos/shared/character-presets`, `@elizaos/shared/local-inference`, `@elizaos/shared/brand`, `@elizaos/shared/steward-session-client`, `@elizaos/shared/dev-settings-*`.

## Commands

Only scripts defined in `packages/shared/package.json`:

```bash
bun run --cwd packages/shared build          # generate-keywords + tsc dist
bun run --cwd packages/shared build:i18n     # regenerate src/i18n/generated/
bun run --cwd packages/shared build:dist     # tsc only (does not regenerate i18n)
bun run --cwd packages/shared typecheck      # tsgo --noEmit
bun run --cwd packages/shared test           # vitest run
bun run --cwd packages/shared lint           # biome check src
bun run --cwd packages/shared lint:fix       # biome check --write src
bun run --cwd packages/shared format:fix     # biome format --write src
bun run --cwd packages/shared clean          # rm -rf dist
bun run --cwd packages/shared sync           # copy assets to consumer public/ dirs
```

## Config / env vars

`src/runtime-env.ts` reads these env vars (checked in precedence order):

| Purpose | Env vars |
|---|---|
| API bind host | `ELIZA_API_BIND` |
| API auth token | `ELIZA_API_TOKEN` |
| Allowed CORS origins | `ELIZA_ALLOWED_ORIGINS`, `CORS_ORIGINS` |
| Allowed hosts | `ELIZA_ALLOWED_HOSTS` |
| Allow null origin | `ELIZA_ALLOW_NULL_ORIGIN` |
| Disable auto token | `ELIZA_DISABLE_AUTO_API_TOKEN` |
| API port (desktop) | `ELIZA_API_PORT`, `ELIZA_PORT` |
| UI port | `ELIZA_UI_PORT` |
| Single-process port | `ELIZA_PORT`, `ELIZA_UI_PORT` |
| Platform (mobile) | `ELIZA_PLATFORM` (`android`/`ios`) |

## How to extend

**Add a new API route contract:** create `src/contracts/<domain>-routes.ts` with request/response types, add `export * from "./<domain>-routes.js"` to `src/contracts/index.ts`. The types will appear in the root barrel automatically.

**Add a new config key:** edit `src/config/types.eliza.ts` (the main config shape). Update the Zod schema in `src/config/zod-schema.agent-runtime.ts` if runtime validation is required. Export via the existing `export type { … }` block in `src/index.ts`.

**Add a new shared utility:** place it in `src/utils/<name>.ts`, then add `export * from "./utils/<name>.js"` to `src/index.ts`.

**Add i18n keyword data:** edit the source `*.keywords.json` files in `src/i18n/keywords/`, then run `bun run --cwd packages/shared build:i18n` to regenerate `src/i18n/generated/`.

**Add brand assets:** drop files under `assets/` or `assets-classic/`, update `src/brand/index.ts` constants, then run `bun run --cwd packages/shared sync` to propagate to consumers.

## Conventions / gotchas

- **No Node.js-only imports at the root barrel level.** The root `src/index.ts` must be importable in both browser and Node.js contexts. The only React reference is a type-only `import type { ReactNode }` in `config/config-catalog.ts` (erased at compile time); never add a value-level React import to a barrel-reachable module.
- **Sub-path exports are the escape hatch.** Modules with heavier or environment-specific concerns use dedicated sub-path exports (`/brand`, `/local-inference`, `/steward-session-client`, `/dev-settings-*`) so consumers opt in.
- **Cycle guard in `src/config/env-vars.ts`.** This file is an empty compatibility module kept so older deep imports fail closed without creating a `shared → agent` cycle. `src/config/config.ts` contains migration helpers (`migrateCloudEnabledToProviders`) and re-exports `ElizaConfig` from `types.eliza.ts` for backward compatibility. Do not import from `@elizaos/agent` in either file or you will break the bench-server boot.
- **`src/contracts/theme.ts` exports only types**, not the runtime theme engine. The runtime helpers (`ELIZA_DEFAULT_THEME`, `applyThemeToDocument`) live in `@elizaos/ui`.
- **`assets/` and `assets-classic/` are published** (listed in `files`). Do not place generated build artifacts there.
- **i18n keyword files** under `src/i18n/generated/` are produced by `scripts/generate-keywords.mjs` from the hand-authored `*.keywords.json` sources in `src/i18n/keywords/`; edit the sources, then regenerate — never hand-edit the `generated/` output.
- **`STEWARD_REFRESH_TOKEN_KEY` / `readStoredStewardRefreshToken` / `writeStoredStewardRefreshToken` are deprecated.** Refresh tokens now live exclusively in the HttpOnly `steward-refresh-token` cookie. New callers must use `STEWARD_REFRESH_ENDPOINT` with `credentials: "include"`.
- See the root `AGENTS.md` for monorepo-wide rules (ESM, logger-only, architecture layer rules, naming).
