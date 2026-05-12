# `services/local-inference/` (ui, client mirror)

This is the **UI-side** mirror of the local-inference service. It exists
so UI code can reach the **catalog**, **recommendation**, **routing
preferences**, **type contract**, and **path helpers** without dragging
in the server runtime (KV cache management, llama-server lifecycle,
conversation registry, metrics scraping). Those server pieces live in
`@elizaos/app-core` and stay there.

The canonical server-side service is at
[`packages/app-core/src/services/local-inference/`](../../../../app-core/src/services/local-inference/README.md).

## Real consumers in this package

UI imports from this directory are limited to:

- `packages/ui/src/components/local-inference/FirstRunOffer.tsx` —
  `MODEL_CATALOG`, `selectRecommendedModels`.
- `packages/ui/src/components/local-inference/hub-utils.ts` —
  `MODEL_CATALOG`, `assessCatalogModelFit`.
- `packages/ui/src/api/client-local-inference.ts` — type imports for
  `DeviceBridgeStatus`, `PublicRegistration`, `ProviderStatus`,
  `RoutingPreferences`, `VerifyResult`, plus `routing-preferences`
  values.
- `packages/ui/src/api/ios-local-agent-kernel.ts` — catalog,
  recommendation, routing-preferences, types (incl. `AGENT_MODEL_SLOTS`).
- `packages/ui/src/onboarding/auto-download-recommended.ts` — types only.

Anything else in this directory exists to satisfy the local dependency
graph for those files (e.g. `recommendation.ts` reaches into
`hardware.ts` and the local `types.ts`).

## Shared with `@elizaos/app-core` via `@elizaos/shared`

The following files are byte-identical with the server-side twins and
have identical semantics. They have been extracted to
`@elizaos/shared/local-inference` and the local files in this directory
are thin re-exports:

- `paths.ts` — `localInferenceRoot`, `elizaModelsDir`, `registryPath`,
  `downloadsStagingDir`, `isWithinElizaRoot`.
- `routing-preferences.ts` — `RoutingPolicy`, `RoutingPreferences`,
  `DEFAULT_ROUTING_POLICY`, `readRoutingPreferences`,
  `writeRoutingPreferences`, `setPreferredProvider`, `setPolicy`.
- `verify.ts` — `VerifyState`, `VerifyResult`, `hashFile`,
  `verifyInstalledModel`.
- `types.ts` — `AgentModelSlot`, `InstalledModel`, `ModelAssignments`,
  `TextGenerationSlot`, `AGENT_MODEL_SLOTS` (the rest of the file holds
  the UI-side public subset of catalog / hardware / readiness shapes).

## What stays a twin (and why)

The server-side counterparts of these files are strict supersets carrying
server-only DFlash runtime metadata, llama-server lifecycle code, KV-cache
plumbing, etc. Forcing them to share would either leak server-only types
into the UI bundle or cripple the server, so they remain split:

- `catalog.ts` — UI carries the public subset of `MODEL_CATALOG`; the
  server adds DFlash drafter variants and `optimizations.requiresKernel`.
- `recommendation.ts` — UI omits the server-only kernel-availability
  filter.
- `active-model.ts`, `device-bridge.ts`, `dflash-server.ts`,
  `dflash-doctor.ts`, `engine.ts`, `handler-registry.ts`, `hardware.ts`,
  `index.ts`, `providers.ts`, `router-handler.ts`, `service.ts` — UI
  keeps a slimmer surface for type-only / catalog-only consumers.

If a twin pair becomes byte-identical with identical semantics, extract
it to `packages/shared/src/local-inference/` and replace both copies
with a thin re-export, the same way `paths.ts` / `verify.ts` /
`routing-preferences.ts` were handled.
