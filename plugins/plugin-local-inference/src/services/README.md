# `services/local-inference/` (app-core, server-side)

This is the **server-side** local-inference service used by the agent
runtime (`@elizaos/app-core`). It owns:

- KV-cache slot management (`cache-bridge.ts`, `dflash-cache-flow.test.ts`).
- llama-server lifecycle (`dflash-server.ts`, `dflash-doctor.ts`,
  `llama-server-metrics.ts`, `session-pool.ts`).
- Conversation registry (`conversation-registry.ts`).
- Backend dispatch (`backend.ts`, `engine.ts`, `handler-registry.ts`,
  `router-handler.ts`, `service.ts`).
- Provider snapshot, hardware probe, model catalog, recommendation, and
  download orchestration (`providers.ts`, `hardware.ts`, `catalog.ts`,
  `recommendation.ts`, `downloader.ts`, `assignments.ts`,
  `bundled-models.ts`, `external-scanner.ts`, `hf-search.ts`,
  `registry.ts`, `paths.ts`, `routing-policy.ts`).

## Server / client split

The UI client mirror lives in
[`packages/ui/src/services/local-inference/`](../../../../ui/src/services/local-inference/README.md).
That mirror exists because UI code (panels, hooks, the iOS/Android local
agent kernel) needs access to the **catalog**, **recommendation**, and
the **type contract** for status payloads, but must not pull in the
server runtime (KV cache, llama-server lifecycle, conversation
registry).

Some files are byte-identical between the two trees and have identical
semantics. Those have been extracted to `@elizaos/shared/local-inference`
and the local files in this directory are thin re-exports:

- `paths.ts` — re-exports `localInferenceRoot` etc. from
  `@elizaos/shared`.
- `routing-preferences.ts` — re-exports `readRoutingPreferences` etc.
  from `@elizaos/shared`.
- `verify.ts` — re-exports `verifyInstalledModel` etc. from
  `@elizaos/shared`.
- `types.ts` — re-exports `AgentModelSlot`, `InstalledModel`,
  `ModelAssignments`, `TextGenerationSlot`, and `AGENT_MODEL_SLOTS` from
  `@elizaos/shared`. Server-only types (DFlash kernel metadata,
  `LocalRuntimeOptimizations`, `loadedCacheTypeK`/`...V`/`GpuLayers`,
  etc.) remain declared in this file because the UI public client has
  no consumer for them.

## What stays a twin (and why)

These files exist in both `packages/app-core` and `packages/ui` and are
intentionally **not** consolidated:

- `catalog.ts` — server adds `contextLength`, `optimizations.requiresKernel`,
  and DFlash drafter variants that the UI public catalog does not surface.
- `recommendation.ts` — server has kernel-availability filtering
  (`recommendation.test.ts` covers DFlash gating) that depends on
  server-only `LocalRuntimeOptimizations.requiresKernel`.
- `active-model.ts` — server resolves load args against the loader's
  KV-cache type / GPU-layer overrides (server-only types).
- `device-bridge.ts` — server forwards `promptCacheKey` from the runtime
  cache plan.
- `dflash-server.ts` — server owns the full llama-server lifecycle, the
  in-process binding fallback, and metrics scraping.
- `dflash-doctor.ts` — uses tokenizer parity catalog metadata that only
  the server catalog declares.
- `engine.ts`, `handler-registry.ts`, `hardware.ts`, `index.ts`,
  `providers.ts`, `router-handler.ts`, `service.ts` — server-side
  superset; the UI mirror keeps a slim subset of the same surface for
  type-only / catalog-only consumers.

If a twin pair becomes byte-identical with identical semantics, extract
it to `packages/shared/src/local-inference/` and replace both copies
with a thin re-export, the same way `paths.ts` / `verify.ts` /
`routing-preferences.ts` were handled.
