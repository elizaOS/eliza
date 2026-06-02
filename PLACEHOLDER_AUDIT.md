# Placeholder / Stub / TODO Audit

Last updated: 2026-06-02

Scope: package-by-package scan of source-level markers such as placeholder, stub,
TODO, incomplete, unfinished, "for now", no-op, and not implemented. Generated
files, tests mocks, input placeholder props, docs-only mentions, and intentional
platform no-ops are separated from actionable runtime gaps.

## Completed Fixes

### packages/cloud-services/agent-server

- Fixed `config-reload` system event handling in `src/handlers/event.ts`.
  The handler now emits the runtime config reload event and returns
  `{ reloaded: true }` instead of acting as a placeholder.
- Added/updated unit coverage for config reload and health handling.
- Verified with:
  - `bun run --cwd packages/cloud-services/agent-server test:unit`
  - `bun run --cwd packages/cloud-services/agent-server typecheck`

### packages/cloud-services/gateway-discord

- Finished voice attachment upload handling. Voice blobs now use the cloud
  storage proxy when `BLOB_READ_WRITE_TOKEN` and a cloud base URL are available,
  fall back to Discord CDN URLs only when storage is unconfigured, and clean up
  expired `voice/` objects.
- Added coverage in `tests/voice-message-handler.test.ts`.
- Verified with:
  - `bun run --cwd packages/cloud-services/gateway-discord test`
  - `bun run --cwd packages/cloud-services/gateway-discord typecheck`

### packages/core

- Fixed the `clearExisting` path in
  `src/services/pairing-migration.ts`. The migration no longer logs that clear
  is unimplemented; it now deletes existing pairing requests and allowlist rows
  for the target channel before importing legacy data. Dry-run mode reports the
  clear without deleting.
- Added `src/__tests__/pairing-migration.test.ts` for real clear behavior,
  dry-run behavior, and delete-before-import ordering.
- Finished the advanced-planning `PLAN` subactions in
  `src/features/advanced-planning/actions/plan.ts`. `create` now returns the
  generated plan body and honors `goal` / `phaseCount`; `update`, `review`, and
  `finalize` now perform concrete plan transformations, structural review, or
  persistence-ready patch/finalization generation instead of returning
  `not_implemented`.
- Added `src/features/advanced-planning/actions/plan.test.ts` covering all four
  subactions.
- Removed the stale `TODO(storage)` marker from
  `src/connectors/account-manager.ts`. The durable path already exists through
  an installed `ConnectorAccountStorage` service or the database adapter bridge;
  the in-memory class is the explicit tests/no-durable-storage fallback.
- Verified with:
  - `bun run --cwd packages/core test src/__tests__/pairing-migration.test.ts`
  - `bun run --cwd packages/core test src/features/advanced-planning/actions/plan.test.ts`
  - `bun run --cwd packages/core typecheck`
  - `bunx biome check packages/core/src/services/pairing-migration.ts packages/core/src/__tests__/pairing-migration.test.ts`
  - `bunx biome check packages/core/src/features/advanced-planning/actions/plan.ts packages/core/src/features/advanced-planning/actions/plan.test.ts`
  - `bunx biome check packages/core/src/connectors/account-manager.ts`

### packages/feed

- Finished the autonomous direct-executor entrypoints for
  `SHARE_INFORMATION` and `REQUEST_PAYMENT`. `DirectExecutors.ts` now delegates
  to the existing intel/payment executor implementation while preserving the
  nullable-ID result contract expected by `MultiStepExecutor`.
- Updated the stale WIP header in
  `packages/agents/src/autonomous/intel-payment-executors.ts` now that it is
  on the active execution path.
- Added wrapper coverage to
  `packages/agents/src/autonomous/__tests__/direct-send-money.test.ts`.
- Also moved `desc` in `DirectExecutors.ts` to a direct `drizzle-orm` import
  to avoid a brittle Bun named-import failure through the `@feed/db` barrel in
  isolated tests.
- Finished the NPC perp resize path in
  `packages/engine/src/npc/npc-investment-manager.ts`. Overweight perp
  positions now generate resize actions, and resize execution performs a real
  partial close by passing `closePercentage` through `TradingDecision` into
  `TradeExecutionService` / `PerpMarketService`. Prediction positions are
  explicitly skipped for resize because the current prediction sell flow closes
  a whole selected position.
- Verified with:
  - `bun test /Users/shawwalters/eliza-workspace/milady/eliza/packages/feed/packages/agents/src/autonomous/__tests__/direct-send-money.test.ts --preload /Users/shawwalters/eliza-workspace/milady/eliza/packages/feed/packages/testing/unit/preload.ts`
  - `bun build packages/feed/packages/engine/src/npc/npc-investment-manager.ts --target=bun --outfile=/tmp/npc-investment-manager-check.js`
  - `bun build packages/feed/packages/engine/src/services/trade-execution-service.ts --target=bun --outfile=/tmp/trade-execution-service-check.js`
  - `git diff --check -- packages/feed/packages/agents/src/autonomous/DirectExecutors.ts packages/feed/packages/agents/src/autonomous/intel-payment-executors.ts packages/feed/packages/agents/src/autonomous/__tests__/direct-send-money.test.ts`
  - Marker scan on the touched Feed files
- Biome note: root `biome.json` excludes `packages/feed/**`, so Biome reports
  these files as ignored.
- Feed TypeScript note: direct `tsc --noEmit` on `packages/engine` and
  `packages/agents` currently fails on pre-existing project-reference `dist`
  outputs and unrelated strictness errors, so it is not a focused validation
  signal for these edits.

### packages/plugin-worker-runtime

- Finished dynamic remote-plugin surface announcement. Worker bootstrap now
  snapshots static plugin surfaces, runs `init()`, and announces appended
  actions/providers/evaluators/models/events/services before `init-complete`.
- Added worker-runtime tests for dynamic announcements.
- Verified with package focused tests and typecheck.

### packages/plugin-remote-manifest

- Removed the stale stub wording in `scripts/sign-manifest.ts`. The CLI already
  performs real Ed25519 signing via the configured KMS backend; the updated
  comment now describes that behavior and the Steward-backed release-flow
  expectation.
- Verified with:
  - `bunx biome check packages/plugin-remote-manifest/scripts/sign-manifest.ts`
  - `bun run --cwd packages/plugin-remote-manifest typecheck`

### packages/os/usb-installer

- Replaced the server-side `executeWritePlan is not implemented on this
  platform` marker with an explicit backend capability error. Real platform
  backends already implement raw write execution; the server now reports that a
  selected custom/dry-run backend does not support raw write execution instead
  of implying unfinished platform code.
- Verified with:
  - `bun run --cwd packages/os/usb-installer test src/__tests__/server.test.ts`
  - `bun run --cwd packages/os/usb-installer typecheck`
  - `bunx biome check packages/os/usb-installer/server.ts`

### packages/scenario-runner

- Reworded the cleanup error for cancelled agent-skills lazy service startup
  from "unfinished" to "pending" in `src/runtime-factory.ts`. This is an
  in-flight cleanup path, not incomplete scenario-runner behavior.
- Verified with:
  - `bun run --cwd packages/scenario-runner typecheck`
  - `bunx biome check packages/scenario-runner/src/runtime-factory.ts`

### packages/agent

- Finished host-side registration for dynamically announced remote-plugin
  surfaces. The host bridge materializes stubs, merges the tracked plugin,
  registers dynamic actions/providers/evaluators/models/events/services, and
  merges dynamic routes into the runtime route surface when available.
- Updated docs that previously described dynamic action callbacks as no-ops.
- Fixed the Windows `local-safe` shell-router gap in
  `src/services/shell-execution-router.ts`. The agent shell chokepoint no
  longer throws a hardcoded Windows not-implemented error; it delegates
  platform support to the resolved `SandboxManager` backend and still refuses
  host fallback when no manager is available.
- Added coverage in `src/services/shell-execution-router.test.ts` that
  simulates Windows and verifies `local-safe` commands route through
  `SandboxManager.run`.
- Verified with:
  - focused remote-plugin adapter coverage and typecheck
  - `bun run --cwd packages/agent test src/services/shell-execution-router.test.ts`
  - `bun run --cwd packages/agent typecheck`
  - `bunx biome check packages/agent/src/services/shell-execution-router.ts packages/agent/src/services/shell-execution-router.test.ts`
  - marker scan on the touched shell-router files

### packages/ui

- Fixed `WidgetHost` declarative `uiSpec` fallback. It now renders via
  `UiRenderer` and dispatches widget UI actions through
  `WIDGET_UI_ACTION_EVENT` with typed detail.
- Added `src/widgets/WidgetHost.test.tsx`.
- Verified with:
  - `bun run --cwd packages/ui test src/widgets/WidgetHost.test.tsx`
  - `bun run --cwd packages/ui typecheck`
  - `bunx biome check` on touched UI files
  - `git diff --check`

### plugins/plugin-browser

- Fixed the `BrowserBridgeAdapter` placeholder. It now uses
  `BrowserBridgeRouteService`, maps the current bridge page to `MessageRef`,
  and supports filtered list/get behavior.
- Added focused adapter tests.
- Verified with focused test, typecheck, and diff check.

### plugins/plugin-ainex

- Removed stale placeholder wording from `src/types.ts`; the
  `RobotProfileDescriptor` is the concrete bridge/Python profile mirror.
- Reworded the focused action test helper comment to avoid marking a deliberate
  minimal test fake as a source stub, and applied Biome's mechanical cleanup in
  the touched test file.
- Verified with:
  - `bun run --cwd plugins/plugin-ainex test test/service-actions.test.ts`
  - `bun run --cwd plugins/plugin-ainex typecheck`
  - `bunx biome check plugins/plugin-ainex/src/types.ts plugins/plugin-ainex/test/service-actions.test.ts`
  - marker scan on the touched AiNex files

### plugins/plugin-coding-tools

- Fixed the Windows `local-safe` shell sandbox gap in
  `src/lib/run-shell.ts`. The plugin no longer throws that Windows local-safe is
  not implemented; it now uses the same `SandboxManager.exec` abstraction as
  other platforms, preserving the existing checks for sandbox availability and
  workspace-contained cwd.
- Added coverage in `src/lib/run-shell.test.ts` that simulates Windows and
  verifies commands route through the runtime sandbox manager.
- Verified with:
  - `bun run --cwd plugins/plugin-coding-tools test src/lib/run-shell.test.ts`
  - `bun run --cwd plugins/plugin-coding-tools typecheck`
  - `bunx biome check plugins/plugin-coding-tools/src/lib/run-shell.ts plugins/plugin-coding-tools/src/lib/run-shell.test.ts`

### plugins/plugin-computeruse

- Removed the dead `DARWIN_JXA` draft block in `src/platform/displays.ts`.
  Active macOS display enumeration remains the `system_profiler` path with JXA
  primary-display fallback.
- Fixed OSWorld `MOUSE_DOWN` / `MOUSE_UP` conversion in
  `src/osworld/action-converter.ts` and `src/osworld/adapter.ts`. The stateless
  converter keeps the previous compatibility fallback, while `OSWorldAdapter`
  now preserves pointer state and converts a down/up sequence into a real
  `drag` action. Reset clears pending pointer state.
- Added `src/__tests__/osworld-action-converter.test.ts`.
- Verified with:
  - `bun run --cwd plugins/plugin-computeruse test src/__tests__/scene-multimon-coords.test.ts`
  - `bun run --cwd plugins/plugin-computeruse test src/__tests__/osworld-action-converter.test.ts`
  - `bun run --cwd plugins/plugin-computeruse typecheck`
  - `bunx biome check` on touched plugin-computeruse files

### plugins/plugin-documents

- Removed stale fallback-stub wording from `CLAUDE.md`, `AGENTS.md`, and
  `README.md`. The image upload route already stores explicit
  extraction/description-unavailable text and returns warnings when image
  description fails; the docs now describe that real behavior.
- Verified with marker scan and `git diff --check` on the touched docs.

### plugins/plugin-elevenlabs

- Removed the browser-mode synthetic API key from `src/index.ts`. TTS and STT
  now share a client-config guard: use a real `ELEVENLABS_API_KEY`, or in
  browser mode use `ELEVENLABS_BROWSER_URL` and let the proxy inject
  credentials. Missing credentials/proxy fail before contacting the SDK.
- Updated package-local `CLAUDE.md` and `AGENTS.md` to document the real
  browser credential contract.
- Added streaming-suite coverage that verifies browser proxy mode sends no
  synthetic API key and that missing browser proxy/API key fails early.
- Verified with:
  - `bun run --cwd plugins/plugin-elevenlabs test __tests__/streaming.test.ts`
  - `bun run --cwd plugins/plugin-elevenlabs typecheck`
  - `bunx biome check plugins/plugin-elevenlabs/src/index.ts plugins/plugin-elevenlabs/__tests__/streaming.test.ts plugins/plugin-elevenlabs/CLAUDE.md plugins/plugin-elevenlabs/AGENTS.md`
  - marker scan on the touched ElevenLabs files

### plugins/plugin-instagram

- Removed synthetic Instagram API behavior from `src/service.ts`. DM sends,
  comment posts, user lookups, social actions, thread listing, and thread
  message listing now fail explicitly until a concrete Instagram client backend
  is configured, rather than logging and returning generated IDs, generated
  users, or empty success data.
- Replaced `console.*` service logging with the structured `logger` import.
- Updated `README.md`, `CLAUDE.md`, and `AGENTS.md` to describe the connector
  surface and concrete API backend boundary.
- Added regression coverage in `src/__tests__/accounts.test.ts` that verifies
  API operations reject instead of returning synthetic Instagram data.
- Verified with:
  - `bun run --cwd plugins/plugin-instagram test src/__tests__/accounts.test.ts`
  - `bun run --cwd plugins/plugin-instagram typecheck`
  - `bunx biome check plugins/plugin-instagram/src/service.ts plugins/plugin-instagram/src/__tests__/accounts.test.ts plugins/plugin-instagram/CLAUDE.md plugins/plugin-instagram/AGENTS.md plugins/plugin-instagram/README.md`
  - marker scan and `git diff --check` on the touched Instagram files

### plugins/plugin-music

- Finished `BLOCKING` backpressure behavior in
  `src/core/streamMultiplexer.ts`. Slow consumers now pause the source stream
  until their `PassThrough` drains, and removing a slow consumer also resumes
  the source when no blocked consumers remain.
- Added `src/core/streamMultiplexer.test.ts` covering drain-based resume and
  remove-consumer resume.
- Verified with:
  - `bun run --cwd plugins/plugin-music test src/core/streamMultiplexer.test.ts`
  - `bun run --cwd plugins/plugin-music typecheck`
  - `bunx biome check plugins/plugin-music/src/core/streamMultiplexer.ts plugins/plugin-music/src/core/streamMultiplexer.test.ts`
  - marker scan on the touched stream multiplexer files

### plugins/plugin-native-talkmode

- Implemented iOS `useLocalInferenceTts`.
  The iOS bridge now calls the local-inference TTS route, validates RIFF/WAVE
  PCM output, emits playback start, plays through AVFoundation, and respects
  interruption handling.
- Verified with plugin build and tests.
- Not verified on a real iOS device/simulator in this workspace.

### plugins/plugin-sql

- Finished `BaseDrizzleAdapter.patchComponents()` with JSON patch operations.
- Replaced the placeholder cleanup-agents integration test with real coverage.
- Added component patch integration coverage.
- Verified with plugin typecheck, integration tests, and lint check.

### plugins/plugin-training

- Replaced the generic training-orchestrator baseline fallback in
  `src/core/training-orchestrator.ts` with concrete task baselines for
  `should_respond`, `context_routing`, `action_planner`, `response`, and
  `media_description`. Native optimizer runs no longer start from placeholder
  prompt text when runtime prompt exports are unavailable.
- Exported `loadBaselineForTask` and added
  `src/core/training-orchestrator.test.ts` to cover all supported training
  tasks.
- Verified with:
  - `bun run --cwd plugins/plugin-training test src/core/training-orchestrator.test.ts`
  - `bun run --cwd plugins/plugin-training build:types`
  - `bunx biome check plugins/plugin-training/src/core/training-orchestrator.ts plugins/plugin-training/src/core/training-orchestrator.test.ts`
  - marker scan and `git diff --check` on touched training files

### plugins/plugin-wechat

- Removed the synthetic placeholder default account from
  `src/connector-account-provider.ts`. When WeChat is not configured,
  `listAccounts()` now returns an empty list instead of exposing a disabled
  account that can be mistaken for real connector state; configured env or
  character accounts still surface normally.
- Added `src/connector-account-provider.test.ts` covering empty config and
  env-configured single-account behavior.
- Verified with:
  - `bun run --cwd plugins/plugin-wechat test src/connector-account-provider.test.ts`
  - `bun run --cwd plugins/plugin-wechat check`
  - `bunx biome check plugins/plugin-wechat/src/connector-account-provider.ts plugins/plugin-wechat/src/connector-account-provider.test.ts`
  - marker scan on the touched WeChat provider files

### plugins/plugin-wallet

- Fixed Birdeye market-cap placeholder behavior. Token market snapshots now
  carry `marketCapUsd`, the service reads common market-cap fields, and the
  provider renders the value.
- Verified with focused service test and:
  - `bun run --cwd plugins/plugin-wallet check`

## Remaining Runtime Gaps / Boundaries

### packages/elizaos

- `src/commands/deploy.ts` still has a real deploy path that is not wired to a
  complete backend contract. This cannot be finished safely without defining the
  deployment API behavior and auth/target semantics.

### packages/security

- `src/kms/steward-adapter.ts` still depends on Steward KMS endpoint behavior
  that is not present in this workspace. Treat as blocked on the external KMS
  API contract rather than a local code stub.

### plugins/plugin-capacitor-bridge

- `src/ios/bridge.ts` still returns an explicit not-implemented error for the
  iOS full Bun local-inference route.
- Android `computeruse` files carry device-validation TODO markers. These are
  validation checklists for native/AOSP device behavior and require hardware or
  emulator smoke evidence.

### plugins/plugin-computeruse

- Remaining native/sandbox markers are platform boundaries:
  - AOSP privileged input actor is documented as a stub for consumer flavor.
  - Optional VLM adapter is a typed endpoint stub.
  - OCR no-op fallback is intentionally used when no OCR provider is present.
  - QEMU backend is a Phase 2 stub.
  - Android process-list and native capture paths remain stubs or host
    fallbacks until Android-native providers are available.

### plugins/plugin-health

- Wave-1 connector dispatch is still a placeholder boundary. The package docs
  describe this as a soft-dependency architecture depending on connector
  registry runtime context, grants, tokens, and OAuth routing. A correct fix
  needs those connector contracts rather than local fake dispatch.

### plugins/plugin-local-inference

- Image generation backends still include AOSP, Core ML, and TensorRT stub
  adapters. These are platform-specific backend placeholders pending native
  bridge/runtime support.
- Vision AOSP / GGML markers indicate native-model backend readiness gaps, not
  simple TypeScript placeholders.

### plugins/plugin-native-canvas

- Cross-origin iframe snapshot fallback renders a placeholder by design because
  browsers cannot serialize cross-origin iframe content. This is a security
  limitation, not a local TODO.
- Package docs still mention adding native stubs/implementations for new native
  methods as a contributor workflow.

### plugins/plugin-native-eliza-tasks

- Android support is listed as not yet implemented; web/non-iOS support is a
  deliberate no-op fallback (`supported: false`) because BGTaskScheduler is
  iOS-only.

### plugins/plugin-openrouter

- Audio transcription is intentionally not implemented. Package docs explicitly
  say not to add a stub handler until real support is built.

### plugins/plugin-polymarket-app

- Signed CLOB trading remains documented as not yet implemented. The status
  endpoint may report credentials present, but `place_order` is still readiness
  reporting only.

### plugins/plugin-vision

- Mobile camera and MediaPipe/GGML face-detector stubs remain until native
  bridge/model support is wired. Existing code logs explicit unavailability
  rather than pretending detection/capture succeeded.

### packages/robot

- Robot profile/gait TODOs remain calibration tasks requiring real robot or
  simulator evidence. The current values are starting poses and tuning notes,
  not locally verifiable code stubs.

### packages/benchmarks

- Several TODOs are in benchmark fixture code and research harnesses. They were
  not treated as product runtime gaps unless they affect exported package
  behavior.

## Intentional / False-Positive Marker Classes

- Input `placeholder=` props and i18n keys named `*Placeholder`.
- Vitest mocks, `stubGlobal`, and fixture stubs.
- Browser-safe export-condition stubs for Node-only plugins, when package docs
  explicitly state the browser build must proxy to a server.
- Scenario-runner deterministic embedding stubs used to avoid live model
  downloads in CI.
- Web/no-op fallbacks for native-only Capacitor plugins where `supported: false`
  is the intended contract.
- Generated output, lockfiles, bundled app artifacts, and docs describing
  marker policy rather than unfinished behavior.
