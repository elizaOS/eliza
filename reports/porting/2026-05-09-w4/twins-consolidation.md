# W4-C — `services/local-inference/` twin consolidation

**Date:** 2026-05-09
**Worktree:** `agent-a6c093873d0f9c3cd`
**Branch:** `worktree-agent-a6c093873d0f9c3cd`

## Scope

Investigate then partially deduplicate the twin
`packages/{app-core,ui}/src/services/local-inference/` namespaces:

- `packages/app-core/src/services/local-inference/` — 44 files, 1 subdir
  (`__stress__/`). Server-side: KV cache management, llama-server
  lifecycle, conversation registry, metrics scraping, full backend
  dispatch, downloader.
- `packages/ui/src/services/local-inference/` — 32 files. UI-side
  mirror. Used by panels (`hub-utils.ts`, `FirstRunOffer.tsx`), the
  HTTP/native client (`api/client-local-inference.ts`,
  `api/ios-local-agent-kernel.ts`), and onboarding
  (`onboarding/auto-download-recommended.ts`).

Per the AGENTS.md "Shared Types Consolidation" + "Deduplication" agents:
extract genuine duplicates, leave legitimate twins alone, do not
centralize unlike concepts.

## Inventory

`cmp` was used to find byte-identical files; `diff` was used to assess
the divergent ones. Imports were traced both inside the twin tree and
out to UI consumers.

| File | Status | UI external consumers | Notes |
| --- | --- | --- | --- |
| `active-model.runtime.test.ts` | app-core only | n/a | server runtime test |
| `active-model.test.ts` | divergent twin | none | UI test asserts only `resolveLocalInferenceLoadArgs`; app-core test additionally exercises `isForkOnlyKvCacheType` |
| `active-model.ts` | divergent twin | (internal) | app-core resolves load args against server-only KV-cache + GPU-layer overrides |
| `assignments.ts` | byte-identical | none in UI | thin file wrapping `paths` + `registry` |
| `backend.ts` / `backend.test.ts` | app-core only | n/a | server backend dispatch |
| `bundled-models.ts` | byte-identical | none in UI | seeding helper, server-side |
| `cache-bridge.ts` / `cache-bridge.test.ts` | app-core only | n/a | server KV-cache slot management |
| `catalog.ts` / `catalog.test.ts` | divergent twin | yes (`MODEL_CATALOG` from `FirstRunOffer.tsx`, `hub-utils.ts`, `ios-local-agent-kernel.ts`) | app-core adds `contextLength`, `optimizations.requiresKernel`, DFlash drafter variants; UI keeps the public subset |
| `conversation-registry.ts` / `.test.ts` | app-core only | n/a | server conversation registry |
| `device-bridge.ts` | divergent twin | type-only (`DeviceBridgeStatus`) | app-core adds `promptCacheKey` plumbing |
| `dflash-cache-flow.test.ts` | app-core only | n/a | server cache flow test |
| `dflash-doctor.ts` / `.test.ts` | divergent twin | none | app-core asserts catalog tokenizer parity using server-only catalog metadata |
| `dflash-server.ts` | divergent twin | none | app-core owns the full llama-server lifecycle and metrics scraping |
| `dflash-server.test.ts` | byte-identical | none in UI | duplicated test of the public surface (`dflashEnabled`, `getDflashRuntimeStatus`, `parseDflashMetrics`, `resolveDflashBinary`) |
| `downloader.ts` / `downloader.test.ts` | byte-identical | none in UI | server downloader; UI never calls it |
| `engine.e2e.test.ts` | byte-identical | none in UI | excluded from UI vitest by `*.e2e.test.{ts,tsx}` |
| `engine.ts` | divergent twin | none | app-core wires backend / cache-bridge / catalog into the loader |
| `external-scanner.ts` | byte-identical | none in UI | LM Studio / Jan / Ollama scanner, server-side |
| `handler-registry.ts` | divergent twin | type-only (`PublicRegistration`) | app-core adds `PatchMarkedRegisterModel` |
| `hardware.ts` | divergent twin | (internal) | app-core uses node-llama-cpp module id constant; UI variant inlines the path |
| `hf-search.ts` | byte-identical | none in UI | HuggingFace search, server-side |
| `index.ts` | divergent twin | none directly | app-core re-exports `BackendDispatcher`; UI omits |
| `llama-server-metrics.ts` / `.test.ts` | app-core only | n/a | server metrics scraping |
| `paths.ts` | **EXTRACTED to shared** | indirect (via `routing-preferences`, `verify`) | extracted (see below) |
| `providers.ts` | divergent twin | type-only (`ProviderStatus`) | app-core wires `getDefaultAccountPool` and richer blurb |
| `readiness.ts` / `readiness.test.ts` | byte-identical | none in UI | thin module on top of catalog + recommendation |
| `recommendation.ts` / `recommendation.test.ts` | divergent twin | yes (`assessCatalogModelFit`, `selectRecommendedModels`) | app-core adds kernel-availability filtering |
| `registry.ts` | byte-identical | none in UI | persistent installed-model registry, server-side |
| `router-handler.ts` | divergent twin | none | app-core adds full logger import |
| `routing-policy.ts` | byte-identical | none in UI | policy derivation helper |
| `routing-preferences.ts` | **EXTRACTED to shared** | yes (`RoutingPreferences`) | extracted |
| `service.ts` | divergent twin | none | app-core wires the full `ActiveModelCoordinator` |
| `session-pool.ts` | app-core only | n/a | server session pool |
| `__stress__/*` | app-core only | n/a | stress tests |
| `types.ts` | **shared subset EXTRACTED to shared** | yes (multiple) | `AgentModelSlot`, `InstalledModel`, `ModelAssignments`, `TextGenerationSlot`, `AGENT_MODEL_SLOTS` extracted; everything else stays per-package |
| `verify.ts` | **EXTRACTED to shared** | yes (`VerifyResult`) | extracted |

### Identical-but-unused-in-UI summary

Nine files in `packages/ui/src/services/local-inference/` are
byte-identical to their app-core twins **and** have no consumer
elsewhere in the UI package: `assignments.ts`, `bundled-models.ts`,
`downloader.ts`, `external-scanner.ts`, `hf-search.ts`, `registry.ts`,
`routing-policy.ts`, plus the test files `downloader.test.ts`,
`engine.e2e.test.ts`, `dflash-server.test.ts`, `readiness.test.ts`.

These exist only to satisfy the local dependency graph of the UI's
divergent `service.ts` / `engine.ts` / `active-model.ts` /
`router-handler.ts` files (which are themselves never imported from
elsewhere in UI). They are dead weight on the UI side, but removing
them is **out of scope** for this task — the unused-code agent owns
that cleanup. Documenting them here so the next pass can take them out
in one shot.

## What was extracted to `@elizaos/shared/local-inference`

New directory: `packages/shared/src/local-inference/` (re-exported from
the package barrel `packages/shared/src/index.ts`).

| Shared module | Source bytes (sum app-core + ui) | Shared bytes | Notes |
| --- | --- | --- | --- |
| `types.ts` | 21068 (sum, partial) → 20164 after thinning | 2805 | only the byte-identical subset is in `shared/types.ts`; the per-package files keep their richer twin-specific declarations |
| `paths.ts` | 1773 + 1773 | 1773 | re-exporters in both packages now ~400 B each |
| `routing-preferences.ts` | 3423 + 3423 | 3429 (incl. `.js` extensions) | both re-exporters now ~480 B |
| `verify.ts` | 3821 + 3821 | 3827 (incl. `.js` extensions) | both re-exporters now ~430 B |

### Public-surface preservation

Every existing import path in both `@elizaos/app-core` and `@elizaos/ui`
keeps working because the local files (`paths.ts`, `verify.ts`,
`routing-preferences.ts`, `types.ts`) become thin re-exporters that
pull from `@elizaos/shared`. No external import sites moved.

### Why no further extraction

Per AGENTS.md (Deduplication & Shared Types agents): "Be conservative.
Only extract what is identical or near-identical content with identical
semantics on both sides … Do not DRY code that should remain separate
because the domains differ."

The remaining twin pairs (`catalog.ts`, `recommendation.ts`,
`active-model.ts`, `device-bridge.ts`, `dflash-server.ts`,
`dflash-doctor.ts`, `engine.ts`, `handler-registry.ts`, `hardware.ts`,
`index.ts`, `providers.ts`, `router-handler.ts`, `service.ts`) are
strict supersets in app-core that carry server-only DFlash kernel
metadata, llama-server lifecycle, KV-cache plumbing, and full backend
dispatch. Forcing them into a shared module would either leak
server-only types into the UI bundle or cripple the server. Both
README files document this contract.

## Documentation

- `packages/app-core/src/services/local-inference/README.md` (new) —
  server side; lists what stays a twin and why.
- `packages/ui/src/services/local-inference/README.md` (new) — UI side;
  same.

## Test results

| Suite | Result |
| --- | --- |
| `packages/ui` — `bun run test src/services/local-inference` | 6 files / **20 tests passed** |
| `packages/app-core` — `bun run test src/services/local-inference` | 19 files / **163 tests passed** |
| `packages/ui` — `bun run typecheck` | clean for `local-inference/*` |
| `packages/app-core` — `bun run typecheck` | clean for `local-inference/*` (one pre-existing `dflash-doctor.ts:133` `getMetrics` error unrelated to this task; same error reproduces on the pre-change tree) |
| `packages/{shared,ui,app-core}` — `bun run lint` | clean for the files this task touched (pre-existing biome format / `noNonNullAssertion` warnings in other twin files were not modified) |

## Bytes saved (rough)

Net reduction on the duplicated portion only:

- `paths.ts`: was 2 × 1773 B (3546 B) duplicated; now 1 canonical
  module at 1773 B + 2 re-exporters at ~400 B each ≈ 2573 B → saves
  ~973 B.
- `routing-preferences.ts`: was 2 × 3423 B (6846 B) duplicated; now 1
  canonical at ~3429 B + 2 re-exporters at ~480 B ≈ 4389 B → saves
  ~2457 B.
- `verify.ts`: was 2 × 3821 B (7642 B) duplicated; now 1 canonical at
  ~3827 B + 2 re-exporters at ~430 B ≈ 4687 B → saves ~2955 B.
- `types.ts` (partial): roughly 1 KB removed from each twin (subset
  types now imported from shared instead of redeclared) → saves ~2 KB.

**Total ~8.4 KB of source removed, three modules now have a single
source of truth, all import paths preserved.**

## Commits

```
ad09b16202 refactor(shared): extract local-inference shared subset to @elizaos/shared
5e75af2bd6 refactor(shared): consolidate local-inference shared types in twin types.ts
```

(README + this report committed separately.)

## Out of scope (for the next pass)

- Deleting the nine identical-but-unused files in
  `packages/ui/src/services/local-inference/` (`assignments.ts`,
  `bundled-models.ts`, `downloader.ts`, `external-scanner.ts`,
  `hf-search.ts`, `registry.ts`, `routing-policy.ts`,
  `downloader.test.ts`, `engine.e2e.test.ts`,
  `dflash-server.test.ts`, `readiness.test.ts`) plus the divergent
  files that depend only on them (`service.ts`, `engine.ts`,
  `active-model.ts`, `router-handler.ts`, `dflash-server.ts`,
  `dflash-doctor.ts`, `hardware.ts`, `bundled-models.ts`). None are
  imported from outside this directory in `@elizaos/ui`. Owning agent:
  the Unused Code Removal agent.
- Renaming `services/local-inference/` to anything else.
- Touching `plugins/plugin-local-inference/`.
