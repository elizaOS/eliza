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
- Finished the MCP `get_markets(type: "perpetuals" | "all")` path in
  `packages/mcp/src/handlers/tool-handlers.ts`. It now returns real
  `PerpMarketSnapshot` rows instead of an empty "not implemented" result, and
  the MCP result type/server description now expose the mixed prediction/perp
  shape.
- Replaced MCP chat unread-count zeros with the existing unread chat
  notification accounting used by the web API. `get_chats` now reports per-chat
  unread counts and `get_unread_count` reports unread chat notifications for
  the authenticated MCP user.
- Replaced MCP referral earnings zeros with the existing
  `FeeService.getReferralEarnings` aggregate.
- Replaced the plugin-experience "simple for now" content match with a
  normalized token scorer that filters punctuation and common stop words before
  combining Jaccard and overlap scores.
- Verified with:
  - `bun test /Users/shawwalters/eliza-workspace/milady/eliza/packages/feed/packages/agents/src/autonomous/__tests__/direct-send-money.test.ts --preload /Users/shawwalters/eliza-workspace/milady/eliza/packages/feed/packages/testing/unit/preload.ts`
  - `bun build packages/feed/packages/engine/src/npc/npc-investment-manager.ts --target=bun --outfile=/tmp/npc-investment-manager-check.js`
  - `bun build packages/feed/packages/engine/src/services/trade-execution-service.ts --target=bun --outfile=/tmp/trade-execution-service-check.js`
  - `bun build packages/feed/packages/mcp/src/handlers/tool-handlers.ts --target=bun --outfile=/tmp/feed-mcp-tool-handlers-check.js`
  - `bun build packages/feed/packages/agents/src/plugins/plugin-experience/src/utils/experienceRelationships.ts --target=bun --outfile=/tmp/feed-experience-relationships-check.js`
  - `git diff --check -- packages/feed/packages/agents/src/autonomous/DirectExecutors.ts packages/feed/packages/agents/src/autonomous/intel-payment-executors.ts packages/feed/packages/agents/src/autonomous/__tests__/direct-send-money.test.ts`
  - `git diff --check -- packages/feed/packages/mcp/src/handlers/tool-handlers.ts packages/feed/packages/mcp/src/types/mcp.ts packages/feed/packages/mcp/src/server/mcp-server.ts packages/feed/packages/agents/src/plugins/plugin-experience/src/utils/experienceRelationships.ts`
  - Marker scan on the touched Feed files
- Biome note: root `biome.json` excludes `packages/feed/**`, so Biome reports
  these files as ignored.
- Feed TypeScript note: direct `tsc --noEmit` on `packages/engine`,
  `packages/agents`, and `packages/mcp` currently fails on pre-existing
  project-reference `dist` outputs and unrelated strictness errors, so it is
  not a focused validation signal for these edits.

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

### packages/alberta

- Replaced the runtime "shifted-observation placeholder" wording in
  `alberta_framework/pipeline.py` with an explicit
  `observation_channel_cumulant_fn` compatibility helper. The default Step 3
  cumulant path is now a named, exported contract that validates dimensions and
  maps demons deterministically onto next-observation channels.
- Added `tests/test_pipeline.py` coverage for channel wrapping and invalid
  dimensions.
- Verified with:
  - marker scan on the touched Alberta files
- Not verified with pytest in this workspace: both the system Python and the
  bundled Codex Python are missing `jax`, so
  `python -m pytest packages/alberta/tests/test_pipeline.py -q` fails during
  conftest import before tests run.

### packages/chip

- Fixed PMC firmware DVFS corner handling in `fw/pmc/src/dvfs_arbiter.c`.
  Missing SS/FF characterization tables now fail closed by returning `NULL`
  instead of silently reusing the TT table.
- Fixed PMC droop telemetry in `fw/pmc/src/droop_telemetry.c`. Firmware now
  reports the hardware aggregate counter and clears per-rail fields until RTL
  exposes readable per-rail counters, instead of fabricating an equal split.
- Updated `fw/pmc/include/dvfs.h` and `fw/pmc/src/main.c` wording to describe
  the TT seed-table contract without placeholder language.
- Added `fw/pmc/tests/test_dvfs.c` and wired it into `make -C fw/pmc test`.
- Verified with:
  - `make -C fw/pmc clean all test`
  - marker scan and `git diff --check` on the touched PMC files

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

### plugins/plugin-agent-skills

- Replaced the stale auto-refresh watcher "for now" comment in
  `src/services/skills.ts`. The watcher scope is now documented as a deliberate
  workspace-skill contract; managed, bundled, and catalog skills refresh through
  load/sync flows.
- Verified with:
  - `bun run --cwd plugins/plugin-agent-skills typecheck`
  - `bunx biome check plugins/plugin-agent-skills/src/services/skills.ts`
  - marker scan and `git diff --check` on the touched Agent Skills file

### plugins/plugin-lifeops

- Removed misleading stub/not-implemented wording from
  `src/activity-profile/proactive-planner.ts`. The GN planner comment now
  describes the activity-feed message as a deterministic feed-only artifact,
  and the social-overuse planner comment now documents that block/task
  follow-ups are handled by normal LifeOps actions after the owner responds.
- Verified with:
  - `bun build plugins/plugin-lifeops/src/activity-profile/proactive-planner.ts --target=bun --outfile=/tmp/lifeops-proactive-planner-check.js`
  - marker scan and `git diff --check` on the touched LifeOps planner file

### plugins/plugin-local-inference

- Replaced stale "for now" wording in `src/services/device-bridge.ts`. The
  persisted generate restore path is now documented as a deliberate requeue
  contract for externally resolved requests.
- Replaced "catalog placeholder ids" wording in `src/services/engine.ts` with
  "catalog seed ids"; these are normal Eliza-1 tier identifiers, not runtime
  placeholders.
- Verified with:
  - `bun build plugins/plugin-local-inference/src/services/device-bridge.ts --target=bun --outfile=/tmp/local-inference-device-bridge-check.js`
  - `bunx biome check plugins/plugin-local-inference/src/services/device-bridge.ts plugins/plugin-local-inference/src/services/engine.ts`
  - `git diff --check -- plugins/plugin-local-inference/src/services/device-bridge.ts plugins/plugin-local-inference/src/services/engine.ts`
- Not verified with direct `bun build` of `src/services/engine.ts`: bundling
  resolves optional `node-llama-cpp` platform packages such as
  `@node-llama-cpp/mac-x64`, which are not installed in this workspace.

### plugins/plugin-2004scape

- Finished gateway WebSocket backpressure handling in `src/gateway/index.ts`.
  Gateway sends now go through a helper that consumes Bun's `ServerWebSocket`
  send result, records sockets whose messages were queued under backpressure,
  clears that state on `drain`, and closes/removes unhealthy sockets when Bun
  reports a dropped send.
- Verified with:
  - `bun run --cwd plugins/plugin-2004scape build:types`
  - `bunx biome check plugins/plugin-2004scape/src/gateway/index.ts`
  - marker scan and `git diff --check` on the touched gateway file

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

### plugins/plugin-ollama

- Removed misleading "not implemented" wording from `README.md`, `CLAUDE.md`,
  and `AGENTS.md` for schema-only streaming calls. The adapter already has a
  deliberate, covered fallback: `stream: true` with only `responseSchema` stays
  on `generateText` so structured `format` remains on the completion path and
  nested schema calls do not throw.
- Verified with:
  - `bun run --cwd plugins/plugin-ollama test __tests__/native-plumbing.shape.test.ts`
  - `bun run --cwd plugins/plugin-ollama typecheck`
  - marker scan and `git diff --check` on the touched Ollama docs
- Biome note: package markdown docs are ignored by the active Biome config.

### plugins/plugin-phone

- Finished the companion Pairing manual-entry path in
  `src/companion/components/Pairing.tsx`. Manual entry now accepts the same
  base64 JSON pairing payload used by QR scanning, decodes it with
  `decodePairingPayload`, persists native pairing status, and calls `onPaired`
  instead of returning a T9a "for now" error.
- Added `src/companion/components/Pairing.test.tsx` coverage for pasted payload
  pairing.
- Verified with:
  - `bun run --cwd plugins/plugin-phone test src/companion/components/Pairing.test.tsx src/companion/services/session-client.test.ts`
  - `bun run --cwd plugins/plugin-phone typecheck`
  - `bunx biome check plugins/plugin-phone/src/companion/components/Pairing.tsx plugins/plugin-phone/src/companion/components/Pairing.test.tsx`
  - marker scan on the touched Pairing files; only the HTML input
    `placeholder` prop remains as a false positive

### plugins/plugin-native-talkmode

- Implemented iOS `useLocalInferenceTts`.
  The iOS bridge now calls the local-inference TTS route, validates RIFF/WAVE
  PCM output, emits playback start, plays through AVFoundation, and respects
  interruption handling.
- Verified with plugin build and tests.
- Not verified on a real iOS device/simulator in this workspace.

### plugins/plugin-native-appblocker

- Removed stale "not implemented" wording from `README.md`, `CLAUDE.md`, and
  `AGENTS.md` for iOS timed app blocks. The package now documents this as an
  explicit unsupported capability requiring a DeviceActivity extension, while
  preserving the current fail-closed `blockApps(durationMinutes > 0)` behavior.
- Verified with:
  - `bun run --cwd plugins/plugin-native-appblocker build`
  - marker scan and `git diff --check` on the touched appblocker files

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

### plugins/plugin-x

- Replaced the duplicate-tweet "simple for now" similarity path in
  `src/utils/memory.ts` with a deterministic normalized token-similarity check
  that honors the existing `similarityThreshold` parameter. The guard still
  catches exact and substring duplicates, and now also catches reordered
  near-duplicates without adding embedding/model dependencies to the posting
  path.
- Added `src/utils/memory.test.ts` coverage for reordered near-duplicates and
  threshold behavior.
- Replaced wildcard engagement's search-only timeline placeholder in
  `src/interactions.ts` with `fetchHomeTimeline(20)`, retaining the popular
  search query as a logged fallback when the home timeline is unavailable.
- Verified with:
  - `bun run --cwd plugins/plugin-x test src/utils/memory.test.ts`
  - `bun run --cwd plugins/plugin-x build`
  - `bun run --cwd plugins/plugin-x typecheck` (package script currently skips release typecheck)
  - `bunx biome check plugins/plugin-x/src/utils/memory.ts plugins/plugin-x/src/utils/memory.test.ts plugins/plugin-x/src/interactions.ts`
  - marker scan and `git diff --check` on the touched X files

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
- Voice pipeline markers are fail-closed safety paths:
  - seeded Samantha/I-wave speaker presets trigger regeneration, Kokoro
    fallback, or a loud startup error;
  - `StubOmniVoiceBackend` cannot start live voice or synthesize speech because
    it emits silence;
  - the renamed openWakeWord "hey jarvis" head warns that it is experimental
    and not the final Eliza-1 wake phrase.
  These should remain visible until real native voice artifacts/backends are
  staged.

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

### plugins/plugin-native-appblocker

- Reliable iOS timed app blocking still requires a DeviceActivity extension.
  The current iOS Family Controls path supports indefinite shields plus
  explicit `unblockApps`; timed requests fail closed with an unsupported
  capability error instead of pretending a timer is enforced.

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
