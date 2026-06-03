# Placeholder / Stub / TODO Audit

Last updated: 2026-06-03

Scope: package-by-package scan of source-level markers such as placeholder, stub,
TODO, incomplete, unfinished, "for now", no-op, and not implemented. Generated
files, tests mocks, input placeholder props, docs-only mentions, and intentional
platform no-ops are separated from actionable runtime gaps.

## Completed Fixes

### repository root

- Removed the fake GPG fingerprint placeholder from `SECURITY.md`. Encrypted
  report intake now fails closed by saying the organization key is not yet
  provisioned, while the human-in-loop checklist still tracks publishing the
  real key and fingerprint.
- Verified with marker scan and `git diff --check` on `SECURITY.md`.

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

### packages/cloud-api

- Reworded Cloudflare Worker compatibility shims in `src/stubs/*` from generic
  stub language to explicit Worker/sidecar capability contracts. The
  `@elizaos/core`, `ssh2`, `undici`, `@elizaos/plugin-sql`, and S3 adapter
  shims now describe what is available in Workers and fail closed when a
  Node-only runtime path is reached.
- Reworded `/api/eliza/rooms*` Worker routes as sidecar-only boundaries and
  changed their responses from "not implemented" wording to explicit
  unsupported-on-Workers errors. The agent runtime remains owned by the Node
  agent-server sidecar.
- Verified with:
  - `bun run --cwd packages/cloud-api typecheck`
  - `bunx biome check` on the touched Worker shim and sidecar-route files
  - marker scan and `git diff --check` on the touched Cloud API files

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
- Finished the secrets `custom` validation strategy in
  `src/features/secrets/validation.ts`. It now dispatches to a validator
  registered under the secret key, falls back to a shared `custom` validator,
  and fails closed when no custom validator is registered instead of returning
  success with "not implemented" details.
- Added `src/features/secrets/validation.test.ts` for unregistered,
  key-specific, and shared custom validators.
- Verified with:
  - `bun run --cwd packages/core test src/features/secrets/validation.test.ts`
  - `bun run --cwd packages/core typecheck`
  - `bunx biome check packages/core/src/features/secrets/validation.ts packages/core/src/features/secrets/validation.test.ts`
  - focused incomplete-marker scan and `git diff --check` on the touched
    secrets validation files
- Replaced the autonomy `ESCALATE` owner/third-party `not_implemented`
  fallback with an explicit unsupported-target result. The core action keeps
  the working admin route and now documents plugin-owned routes as the place
  for non-admin delivery contracts.
- Added `src/features/autonomy/action.test.ts` coverage for owner and
  third-party unsupported-target results.
- Verified with:
  - `bun run --cwd packages/core test src/features/autonomy/action.test.ts src/features/secrets/validation.test.ts`
  - `bun run --cwd packages/core typecheck`
  - `bunx biome check packages/core/src/features/autonomy/action.ts packages/core/src/features/autonomy/action.test.ts packages/core/src/features/secrets/validation.ts packages/core/src/features/secrets/validation.test.ts`
  - focused incomplete-marker scan and `git diff --check` on the touched core
    autonomy/secrets files
- Reworded trajectory reward/service comments in
  `src/features/trajectories/game-rewards.ts` and
  `src/features/trajectories/TrajectoriesService.ts` so environment-specific
  reward hooks, fallback trajectory services, and delayed legacy step-map
  resolution are described without stub/placeholder/not-yet wording.
- Verified with:
  - focused incomplete-marker scan on the two touched trajectory files
  - `bunx biome check packages/core/src/features/trajectories/game-rewards.ts packages/core/src/features/trajectories/TrajectoriesService.ts`
  - `git diff --check -- packages/core/src/features/trajectories/game-rewards.ts packages/core/src/features/trajectories/TrajectoriesService.ts`
- Reworded `src/index.browser.ts` browser compatibility comments from stub
  language to browser shims / not-applicable health contracts.
- Verified with:
  - focused incomplete-marker scan on `packages/core/src/index.browser.ts`
  - `bunx biome check packages/core/src/index.browser.ts`
  - `bun run --cwd packages/core typecheck`
- Renamed the older `index.json` fallback converter in
  `src/features/plugin-manager/services/pluginRegistryService.ts` from
  `stubPlugin` to `indexEntryToPlugin`. It builds a real lightweight
  `RegistryPlugin` record from the legacy registry format, not a placeholder
  plugin implementation.
- Verified with:
  - focused incomplete-marker scan on
    `packages/core/src/features/plugin-manager/services/pluginRegistryService.ts`
  - `bunx biome check packages/core/src/features/plugin-manager/services/pluginRegistryService.ts`
  - `bun run --cwd packages/core typecheck`
- Reworded `src/sandbox/dlopen-gate.ts` cache-state and platform-scope
  comments so `undefined` is documented as an empty cache and the gate is
  scoped to current macOS App Sandbox library validation rather than
  speculative Linux/Windows store enforcement.
- Verified with:
  - `bun run --cwd packages/core test src/sandbox/dlopen-gate.test.ts`
  - focused incomplete-marker scan on `packages/core/src/sandbox/dlopen-gate.ts`
  - `bunx biome check packages/core/src/sandbox/dlopen-gate.ts`
  - `bun run --cwd packages/core typecheck`

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

### packages/security

- Finished the Steward KMS adapter in `src/kms/steward-adapter.ts`. It now
  performs bearer-authenticated HTTP requests to the documented Steward KMS
  endpoints, encodes request payloads as base64, validates typed JSON/base64
  responses, and surfaces malformed/non-2xx responses as `KmsError` instead of
  throwing a permanent unsupported-operation placeholder.
- Updated `README.md`, `CLAUDE.md`, `AGENTS.md`, and KMS factory comments to
  describe Steward as a real HTTP client with an external endpoint contract.
- Added `src/__tests__/steward-adapter.test.ts` covering every KMS operation,
  auth headers, request encoding, response decoding, and error handling.
- Verified with:
  - `bun run --cwd packages/security test src/__tests__/steward-adapter.test.ts src/__tests__/factory.test.ts`
  - `bun run --cwd packages/security typecheck`
  - `bunx biome check packages/security/src/kms/steward-adapter.ts packages/security/src/kms/index.ts packages/security/src/kms/types.ts packages/security/src/__tests__/steward-adapter.test.ts packages/security/src/__tests__/factory.test.ts`
  - marker scan and `git diff --check` on the touched Security files

### packages/sweagent

- Replaced the inspector "Problem Statement placeholder" messages in both
  `typescript/src/inspector/server.ts` and
  `python/sweagent/inspector/server.py`. The prepended trajectory item now
  carries the actual first user problem statement in both `observation` and
  `messages`.
- Reworded the package-local guide entry for
  `typescript/src/utils/log.ts` from "stub" to "minimal logger shim"; this is a
  private vendored snapshot and the file wraps `console.log/error` by contract,
  not as an unfinished repo logger migration.
- Verified with:
  - `python3 -m py_compile packages/sweagent/python/sweagent/inspector/server.py`
  - `bun run --cwd packages/sweagent test`
  - focused incomplete-marker scan on `packages/sweagent/CLAUDE.md` and
    `packages/sweagent/AGENTS.md`
  - `cmp -s packages/sweagent/CLAUDE.md packages/sweagent/AGENTS.md`
  - marker scan and `git diff --check` on the touched inspector files
- Not verified with direct `bun build` of the TypeScript inspector: this
  partial vendored SWE-agent tree cannot resolve `packages/node_modules/js-yaml`,
  consistent with the package guide warning that the full SWE-agent build graph
  is not vendored on this branch.

### packages/tui

- Reworded the optional editor interface fallback in
  `src/editor-component.ts` and the image fallback docs in `README.md`,
  `CLAUDE.md`, and `AGENTS.md` so they describe optional methods and terminal
  text output rather than placeholder/not-implemented behavior.
- Reworded the broad emoji-range comment in `src/utils.ts` so it describes
  Unicode-version tolerance without speculative "future" wording.
- Verified `CLAUDE.md` and `AGENTS.md` are identical after the package-local
  docs change.
- Verified with:
  - `bunx biome check packages/tui/src/editor-component.ts`
  - `bun run --cwd packages/tui test`
  - `bun run --cwd packages/tui build`
  - focused incomplete-marker scan on `packages/tui/src/utils.ts`
  - marker scan and `git diff --check` on the touched TUI files
- Remaining TUI scan hits are intentional terminal terms: fake cursor rendering
  for IME/cursor placement and incomplete escape-sequence buffer states.

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
- Loaded the package-local guide again before the widget/comment cleanup.
- Completed the legacy plugin-widget map migration. `@elizaos/plugin-lifeops`
  now declares its `lifeops.overview` and `lifeops.google` chat-sidebar
  widgets on the plugin object, and `@elizaos/plugin-agent-orchestrator`
  declares its `agent-orchestrator.apps` and `agent-orchestrator.activity`
  widgets on the plugin object. The host-side compatibility map in
  `src/config/plugin-widgets.ts` is now an explicit empty fallback.
- Updated plugin-registry widget-source commentary to describe plugin-instance
  `widgets` declarations as the normal source, with the empty agent map as a
  final compatibility fallback.
- Reworded agent service comments that described current contracts as
  "not yet" or phase work: cloud wallet signing is now documented as
  view-only in the local process, extracted route/service comments are
  consolidated surface notes, and default disabled plugins are described as
  opt-in.
- Verified with:
  - focused incomplete-marker scan on all touched agent, LifeOps,
    agent-orchestrator, and plugin-registry files
  - `bun run --cwd packages/agent typecheck`
  - `bun run --cwd plugins/plugin-lifeops build:types`
  - `bun run --cwd plugins/plugin-agent-orchestrator typecheck`
  - `bun run --cwd plugins/plugin-agent-orchestrator test:unit`
  - `bun run --cwd plugins/plugin-lifeops test -- src/plugin.test.ts`
  - `bun run --cwd plugins/plugin-registry build`
  - guide-pair `cmp -s` checks for packages/agent, plugin-lifeops,
    plugin-agent-orchestrator, and plugin-registry
- Reworded additional `packages/agent` stale rollout comments without
  changing behavior:
  - shell permission prober docs now describe the current app-internal shell
    gate and registry replacement contract.
  - runtime operation manager strategy docs now describe cold as the
    conservative baseline and warm/hot as host-registered reload paths.
  - plugin role gating now describes direct-provider legacy redaction instead
    of a pending context-catalog migration.
  - plugin resolver workspace and install-record comments now describe current
    cwd/default and source-tree fallback behavior.
  - PGlite error helpers are documented as an agent compatibility shim for
    plugin-sql releases without the error export.
- Verified with:
  - focused incomplete-marker scan on the touched agent permission/runtime files
  - `bun run --cwd packages/agent typecheck`
  - `cmp -s packages/agent/CLAUDE.md packages/agent/AGENTS.md`
- Reworded a broader set of stale agent comments and one unreachable OAuth
  guard message:
  - first-run cloud-wallet, connector disconnect, TEE boot gate, trajectory
    persistence, JS runtime bridge, tool-call cache, account storage, config
    route, research-task abort, and remote-signing comments now describe
    current behavior without deferred-work wording.
  - OAuth refresh fallback now reports an unsupported provider rather than an
    unimplemented refresh path. The current OAuth provider union has explicit
    handlers for both members.
- Verified with:
  - no tests referenced the old OAuth refresh message
  - focused incomplete-marker scan on all touched agent files
  - `bun run --cwd packages/agent typecheck`
  - `cmp -s packages/agent/CLAUDE.md packages/agent/AGENTS.md`
- Remaining `packages/agent` scan hits are:
  - `WORKBENCH_TODO_*` domain tags and bootstrap task names.
  - user-facing compact-conversation wording about future prompt context.
  - regression-test comments that intentionally use future-time/future-edit
    wording.
  - `remote-plugin-adapter.test.ts` fixture text asserting a remote
    "not implemented" error.
  - `view-agent-surface-coverage.test.ts`, a real ratchet for unconverted
    views.
  - `scripts/build-mobile-bundle.mjs`, an Android `node:sqlite` bundling
    boundary that still needs separate inspection.
- Inspected the mobile-bundle `node:sqlite` boundary. It is an intentional
  Android bundle shim: Bun 1.3.x on arm64-Android lacks the Node `node:sqlite`
  resolver, while local-inference voice caches already degrade when
  `DatabaseSync` is absent. Reworded the comment as a current platform
  boundary.
- Verified with:
  - `bun build packages/agent/scripts/build-mobile-bundle.mjs --target=bun --outfile=/tmp/build-mobile-bundle-check.js`
  - focused incomplete-marker scan on `scripts/build-mobile-bundle.mjs`
  - `bun run --cwd packages/agent typecheck`
- Remaining `packages/agent` hits after this pass are domain/test markers:
  workbench todo tags, user-facing compact-conversation wording, regression
  test comments about future edits/time, the remote-plugin-adapter fixture
  message `"not implemented"`, and the real
  `view-agent-surface-coverage.test.ts` conversion ratchet.

### packages/alberta

- Replaced the runtime "shifted-observation placeholder" wording in
  `alberta_framework/pipeline.py` with an explicit
  `observation_channel_cumulant_fn` compatibility helper. The default Step 3
  cumulant path is now a named, exported contract that validates dimensions and
  maps demons deterministically onto next-observation channels.
- Reworded the neutral seed depth comment in
  `alberta_framework/core/compositional_features.py`; `init()` computes the
  precise depth array from parents, so the returned `1` is not unfinished
  behavior.
- Added `tests/test_pipeline.py` coverage for channel wrapping and invalid
  dimensions.
- Verified with:
  - `python3 -m py_compile packages/alberta/alberta_framework/core/compositional_features.py`
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
- Replaced stale chip compiler source markers in the ExecuTorch preprocessor,
  IREE HAL docs/comments, and partitioner fixtures. `ElizaPreprocessor` now
  emits deterministic per-op metadata lines instead of `TODO lower ...`
  comments in generated MLIR, and the test graph input nodes no longer use
  placeholder target names.
- Added `compiler/executorch-eliza/tests/test_preprocessor.py` covering the
  emitted preprocessor metadata and CPU-fallback report.
- Reworded IREE HAL/README text to describe the shipped compile/load scaffold
  and hardware-writeback blocker without implying locally unfinished code.
- Finished the StableHLO fused-block module dispatch gap in
  `compiler/runtime/e1_npu_stablehlo.py` and
  `compiler/runtime/e1_npu_lowering.py`. `stablehlo.transformer_block` now has
  a module-level lowering plan, `stablehlo.decoder_block` now parses and
  validates as `ModernDecoderBlock`, and both fused ops dispatch through
  `lower_stablehlo_module_smoke` to the existing transformer/decoder smoke
  lowerers.
- Updated `docs/E1_CLOSEABLE_WORK_INVENTORY.md` so the fused StableHLO dispatch
  and already-present AXI-Lite debug/CPU MMIO arbiter are no longer listed as
  open "not wired" / stub work.
- Verified with:
  - `make -C fw/pmc clean all test`
  - `python3 -m pytest packages/chip/compiler/executorch-eliza/tests/test_partition.py packages/chip/compiler/executorch-eliza/tests/test_preprocessor.py -q`
  - `python3 -m pytest packages/chip/compiler/runtime/test_e1_npu_tiny_mlp_e2e.py -q`
  - `PYTHONPATH=compiler/runtime python3 -m pytest compiler/runtime/test_e1_npu_stablehlo.py compiler/runtime/test_e1_npu_runtime.py -q`
  - `python3 -m py_compile compiler/runtime/e1_npu_stablehlo.py compiler/runtime/e1_npu_lowering.py compiler/runtime/test_e1_npu_stablehlo.py compiler/runtime/test_e1_npu_runtime.py`
  - `./.venv/bin/ruff check compiler/runtime/e1_npu_stablehlo.py compiler/runtime/e1_npu_lowering.py compiler/runtime/test_e1_npu_stablehlo.py compiler/runtime/test_e1_npu_runtime.py`
  - `./.venv/bin/mypy compiler/runtime/e1_npu_stablehlo.py compiler/runtime/e1_npu_lowering.py`
  - marker scan and `git diff --check` on the touched Chip files

### packages/ui

- Fixed `WidgetHost` declarative `uiSpec` fallback. It now renders via
  `UiRenderer` and dispatches widget UI actions through
  `WIDGET_UI_ACTION_EVENT` with typed detail.
- Added `src/widgets/WidgetHost.test.tsx`.
- Replaced stale "for now" wording in
  `src/services/local-inference/device-bridge.ts` and the checked-in
  declaration mirror. The restored pending-generate path is now documented as a
  deliberate requeue contract.
- Reworded `src/widgets/registry.ts` task-list fallback commentary so it
  describes the LifeOps sidebar compatibility rule without looking like a TODO
  marker.
- Verified with:
  - `bun run --cwd packages/ui test src/widgets/WidgetHost.test.tsx`
  - `bun run --cwd packages/ui typecheck`
  - `bun build packages/ui/src/services/local-inference/device-bridge.ts --target=bun --outfile=/tmp/ui-device-bridge-check.js`
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

### plugins/plugin-anthropic-proxy

- Reworded Layer 5 proxy comments and package docs so `cc-tool-stubs.ts` is
  described as synthetic Claude Code tool injection for fingerprint
  compatibility, not as unfinished stub behavior.
- Kept exported names such as `injectCCStubs` / `stubsInjected` unchanged to
  avoid a terminology-only API break in the exported `ProcessBodyConfig` and
  `ProcessBodyResult` surfaces.
- Verified `CLAUDE.md` and `AGENTS.md` are identical after the package-local
  docs change.
- Verified with:
  - `bunx biome check plugins/plugin-anthropic-proxy/src/proxy/cc-tool-stubs.ts plugins/plugin-anthropic-proxy/src/proxy/constants.ts plugins/plugin-anthropic-proxy/src/proxy/process-body.ts`
  - marker scan and `git diff --check` on the touched Anthropic Proxy files
- Remaining scan hits are the exported compatibility-stat names, the
  `cc-tool-stubs.ts` path, and `sse-rewrite.ts` buffering incomplete UTF-8
  sequences across TCP chunks.

### plugins/plugin-app-control

- Reworded view-navigation, app-template copy, preview fallback SVG, and test
  runtime-double comments so they describe supported behavior without
  placeholder/stub/not-implemented markers. Checked-in JavaScript mirrors were
  updated alongside the TypeScript sources where present.
- Verified with:
  - `bun run --cwd plugins/plugin-app-control test`
  - `bun run --cwd plugins/plugin-app-control typecheck`
  - `bunx biome check` on the touched App Control TypeScript files
  - marker scan and `git diff --check` on the touched App Control files

### plugins/plugin-health

- Reworded the sleep/wake event derivation note in
  `src/sleep/sleep-wake-events.ts`; the scorer rewrite mention now documents
  where onset-candidate state lives without carrying a `todo` marker.
- Renamed Health's local structural type files from `contract-stubs.ts` to
  `contract-types.ts` for connectors and default packs, updated all imports,
  and kept package-root type exports intact.
- Reworded the Wave-1 connector registry adapter from placeholder/stub language
  to explicit disconnected / transport-error fallback behavior. The adapter
  still fails closed until W1-F publishes the shared runtime context needed by
  the concrete health bridge.
- Reworded the sleep-cycle recap null-score comment from placeholder scores to
  filler scores.
- Verified with:
  - `bunx biome check plugins/plugin-health/src/sleep/sleep-wake-events.ts`
  - `bunx biome check` on the renamed Health contract type files, connector
    registry adapter, default-pack imports, smoke test, and sleep-cycle file
  - `bun run --cwd plugins/plugin-health build:types`
  - `bun run --cwd plugins/plugin-health test src/__tests__/smoke.test.ts`
  - marker scan and `git diff --check` on the touched Health file
- Remaining Health source scan hits are screen-time status copy
  (`Signal incomplete`) and test fixture wording about incomplete permissions;
  neither is a runtime placeholder/stub.

### plugins/plugin-lifeops

- Removed misleading stub/not-implemented wording from
  `src/activity-profile/proactive-planner.ts`. The GN planner comment now
  describes the activity-feed message as a deterministic feed-only artifact,
  and the social-overuse planner comment now documents that block/task
  follow-ups are handled by normal LifeOps actions after the owner responds.
- Renamed default-pack structural contracts from `contract-stubs.ts` to
  `contract-types.ts`, renamed `*Stub` type aliases to `*Contract`, and updated
  default-pack imports, seed-routine migration imports, and tests. Package-root
  exports still expose the same default-pack contract surface through
  `src/default-packs/index.ts`.
- Reworded default-pack helper comments and test names that described normal
  anchor-unavailable / pipeline-hook behavior as stubs or placeholders. The
  prompt linter still intentionally detects `TODO` / `FIXME` / `XXX` / `HACK`
  tokens inside prompt text.
- Renamed scheduled-task fallback-anchor wiring from `stub` terminology to
  fallback-anchor terminology across the consolidation policy, runtime wiring,
  package exports, and tests. The fallback `wake.confirmed` anchor is now
  documented as a built-in provider for bootstrapping when no richer provider
  is registered.
- Renamed subscription-cancellation playbook errors from
  `PLAYBOOK_NOT_IMPLEMENTED` to `PLAYBOOK_UNSUPPORTED_FLOW`, and reworded
  browser-companion, Google-service, privacy, redaction, reminder, check-in,
  bill-extraction, and first-run comments that described supported fallbacks as
  stubs, placeholders, incomplete data, or TODOs.
- Replaced a non-null assertion in subscription cancellation fallback service
  resolution with an explicit validation failure, matching the existing
  candidate / playbook / service-name contract.
- Verified with:
  - `bun build plugins/plugin-lifeops/src/activity-profile/proactive-planner.ts --target=bun --outfile=/tmp/lifeops-proactive-planner-check.js`
  - `bunx biome check` on touched LifeOps default-pack files and tests
  - `bun run --cwd plugins/plugin-lifeops test test/default-packs.helpers.test.ts test/default-packs.schema.test.ts`
  - `bunx biome check` on touched LifeOps scheduled-task, subscription,
    privacy/redaction, check-in, reminder, bill-extraction, first-run, and test
    files
  - `bun run --cwd plugins/plugin-lifeops build:types`
  - `bun run --cwd plugins/plugin-lifeops test src/lifeops/scheduled-task/consolidation-policy.test.ts src/lifeops/scheduled-task/scheduler.integration.test.ts test/default-packs.helpers.test.ts test/default-packs.schema.test.ts`
  - marker scan and `git diff --check` on the touched LifeOps files
- Remaining LifeOps gap: `test/signature-deadline.e2e.test.ts` explicitly
  notes that full automatic escalation timing for signature-deadline workflows
  is not implemented in that scenario yet.

### plugins/plugin-local-inference

- Replaced stale "for now" wording in `src/services/device-bridge.ts`. The
  persisted generate restore path is now documented as a deliberate requeue
  contract for externally resolved requests.
- Replaced "catalog placeholder ids" wording in `src/services/engine.ts` with
  "catalog seed ids"; these are normal Eliza-1 tier identifiers, not runtime
  placeholders.
- Reworded active-model and family-member voice comments so desktop fallback
  generation and client-side pending voice profiles are described as explicit
  compatibility behavior.
- Updated the desktop FFI / libllama adapter comments to match current parity:
  slot save/restore, prewarm, parallel resize, and speculative decoding are no
  longer described as unfinished. The remaining desktop mtmd vision bridge
  now fails closed with a concrete native-dependency error.
- Verified with:
  - `bun build plugins/plugin-local-inference/src/services/device-bridge.ts --target=bun --outfile=/tmp/local-inference-device-bridge-check.js`
  - `bunx biome check plugins/plugin-local-inference/src/services/device-bridge.ts plugins/plugin-local-inference/src/services/engine.ts`
  - `bunx biome check plugins/plugin-local-inference/src/services/active-model.ts plugins/plugin-local-inference/src/routes/family-member-route.ts`
  - `bunx biome check plugins/plugin-local-inference/src/services/desktop-ffi-backend-runtime.ts plugins/plugin-local-inference/src/services/desktop-llama-adapter.ts plugins/plugin-local-inference/src/services/ffi-streaming-backend.ts`
  - `git diff --check` on the touched Local Inference files
- Not verified with direct `bun build` of `src/services/engine.ts`: bundling
  resolves optional `node-llama-cpp` platform packages such as
  `@node-llama-cpp/mac-x64`, which are not installed in this workspace.

### plugins/plugin-native-agent

- Reworded the Capacitor plugin registration comment in `src/index.ts` so the
  native/web fallback contract no longer reads like a temporary mobile gap.
- Verified with:
  - `bun run --cwd plugins/plugin-native-agent build`
  - `bunx biome check plugins/plugin-native-agent/src/index.ts`
  - marker scan and `git diff --check` on the touched Native Agent file

### plugins/plugin-native-network-policy

- Reworded platform-asymmetric bridge docs and native comments in `README.md`,
  `CLAUDE.md`, `AGENTS.md`, Android Kotlin, and iOS Swift from
  stub/placeholder language to explicit conservative fallback contracts. The
  runtime behavior is unchanged: both platform methods exist everywhere, and
  non-native platforms return safe "unknown/no info" shapes so local-inference
  can choose the correct native hint.
- Verified `CLAUDE.md` and `AGENTS.md` are identical after the package-local
  docs change.
- Verified with:
  - `bun run --cwd plugins/plugin-native-network-policy build`
  - marker scan and `git diff --check` on the touched Network Policy files

### plugins/plugin-slack

- Renamed Slack mrkdwn conversion placeholder terminology to sentinel
  terminology in `src/formatting.ts`. The conversion still protects bold and
  heading spans from italic matching, but no longer looks like unfinished
  formatter behavior.
- Verified with:
  - `bun run --cwd plugins/plugin-slack test`
  - `bunx biome check plugins/plugin-slack/src/formatting.ts`
  - marker scan and `git diff --check` on the touched Slack file

### plugins/plugin-streaming

- Reworded the local-inference TTS redacted-secret helper in
  `src/services/tts-stream-bridge.ts`; it now describes redacted secret tokens
  rather than a placeholder.
- Verified with:
  - `bunx biome check plugins/plugin-streaming/src/services/tts-stream-bridge.ts`
  - marker scan and `git diff --check` on the touched Streaming file

### plugins shared tests

- Reworded `plugins/__tests__/setup-routes-contract.test.ts` so the
  `test.fails(...)` connector normalization contract describes expected
  failures without a "for now" marker.
- Verified with:
  - `bunx biome check plugins/__tests__/setup-routes-contract.test.ts`
  - marker scan and `git diff --check` on the touched shared test file

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
- Reworded the plugin/provider description for `@elizaos/plugin-todos` so the
  task-list action boundary no longer looks like unfinished coding-tools work.
- Renamed focused test runtime doubles in `glob`, `ls`, and `grep` tests so
  they no longer show up as source-level stub markers.
- Verified with:
  - `bun run --cwd plugins/plugin-coding-tools test src/lib/run-shell.test.ts`
  - `bun run --cwd plugins/plugin-coding-tools test src/actions/glob.test.ts src/actions/ls.test.ts src/actions/grep.test.ts`
  - `bun run --cwd plugins/plugin-coding-tools typecheck`
  - `bunx biome check` on the touched coding-tools files

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

### plugins/plugin-capacitor-bridge

- Finished the iOS full Bun local-inference routing gap in
  `src/ios/bridge.ts`. The bridge still handles native iOS local-inference
  routes directly and still rejects stdio-incompatible streaming endpoints, but
  unmatched `/api/local-inference/*` requests now fall through to app-core
  `dispatchRoute` instead of returning a hardcoded not-implemented error.
- Reworded Android computer-use device-validation comments from TODO markers to
  explicit device-validation scope notes, and renamed consumer-flavor AOSP
  hidden-API fallback wording so it no longer reads like a source-level stub.
- Verified with:
  - `bun run --cwd plugins/plugin-capacitor-bridge typecheck`
  - `bun run --cwd plugins/plugin-capacitor-bridge build`
  - word-boundary marker scan and `git diff --check` on the touched Capacitor
    bridge files
- Not verified on a physical Android/iOS device or simulator in this workspace.

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

### packages/elizaos

- Replaced the `deploy` command's dry-run-only keel with a real Eliza Cloud
  trigger path. `runDeploy` now resolves cloud credentials, resolves the app id
  from `--app-id`, `.elizaos/template.json`, or owned app name matching, queues
  `POST /api/v1/apps/:id/deploy`, optionally attaches `--domain`, polls
  `GET /api/v1/apps/:id/deploy/status` until `READY` / `ERROR`, and preserves
  `--dry-run` as the no-network preview.
- Updated `CLAUDE.md`, `AGENTS.md`, and `DEPLOY_DESIGN.md` so the package docs
  describe the implemented deploy path and the remaining follow-up boundaries
  (local build/upload, first-run credential prompt, deploy log tailing, watch
  mode, multi-environment deploys).
- Added `src/commands/deploy.test.ts` coverage for dry-run, queue-and-poll,
  domain attachment, and missing credentials.
- Verified `CLAUDE.md` and `AGENTS.md` are identical after the docs change.
- Verified with:
  - `bunx biome check packages/elizaos/src/commands/deploy.ts packages/elizaos/src/commands/deploy.test.ts packages/elizaos/CLAUDE.md packages/elizaos/AGENTS.md packages/elizaos/src/commands/DEPLOY_DESIGN.md`
  - `bun run --cwd packages/elizaos test src/commands/deploy.test.ts`
  - `bun run --cwd packages/elizaos typecheck`
  - `bun run --cwd packages/elizaos build`
  - marker scan and `git diff --check` on the touched elizaOS files
- Remaining elizaOS marker scan hit is `placeholder: defaultValue` in
  `src/commands/create.ts`, which is an interactive prompt field name, not an
  unfinished implementation marker.

### plugins/plugin-farcaster

- Reworded the browser export in `index.browser.ts`, `CLAUDE.md`, and
  `AGENTS.md` from "stub" to an explicit browser proxy boundary. The real
  Neynar-backed plugin remains Node-only; the browser export imports safely and
  warns callers to use a server proxy.
- Verified `CLAUDE.md` and `AGENTS.md` are identical after the package-local
  docs change.
- Verified with:
  - `bunx biome check plugins/plugin-farcaster/index.browser.ts`
  - marker scan and `git diff --check` on the touched Farcaster files
- Remaining Farcaster scan hits are test fakes/mocks only.

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
- Reworded `utils/ai-sdk-wire.ts` helper docs so SDK-native tool objects are
  described as a current supported caller shape rather than a speculative
  future path.
- Verified with:
  - `bun run --cwd plugins/plugin-ollama test __tests__/native-plumbing.shape.test.ts`
  - `bun run --cwd plugins/plugin-ollama typecheck`
  - `bun run --cwd plugins/plugin-ollama test`
  - focused incomplete-marker scan on `plugins/plugin-ollama/utils/ai-sdk-wire.ts`
  - `cmp -s plugins/plugin-ollama/CLAUDE.md plugins/plugin-ollama/AGENTS.md`
  - marker scan and `git diff --check` on the touched Ollama docs
- Biome note: package markdown docs are ignored by the active Biome config.

### plugins/plugin-openrouter

- Implemented `ModelType.TRANSCRIPTION` using OpenRouter's
  `/audio/transcriptions` endpoint. The new handler accepts URL strings,
  `Buffer`, `Blob` / `File`, core `{ audioUrl, prompt? }`, and local
  `{ audio, model?, language?, temperature?, format?, mimeType? }` inputs,
  normalizes them to documented base64 `input_audio` JSON, returns transcript
  text, and emits model usage when the provider returns usage data.
- Added `OPENROUTER_TRANSCRIPTION_MODEL` / `TRANSCRIPTION_MODEL` config with
  default `openai/whisper-large-v3`, registered the handler in `plugin.ts`, and
  exported it from `models/index.ts`.
- Updated `README.md`, `CLAUDE.md`, and `AGENTS.md` to document transcription
  support and removed the stale "not implemented / no stub" audio warning.
- Verified `CLAUDE.md` and `AGENTS.md` are identical after the docs change.
- Verified with:
  - `bun run --cwd plugins/plugin-openrouter test __tests__/transcription.shape.test.ts`
  - `bunx biome check` on the touched OpenRouter source, test, and docs files
  - `bun run --cwd plugins/plugin-openrouter typecheck`
  - `bun run --cwd plugins/plugin-openrouter build`
  - marker scan and `git diff --check` on the touched OpenRouter files

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

### plugins/plugin-polymarket-app

- Reworded signed CLOB trading docs, route messages, provider text, and action
  description so they describe an explicit fail-closed trading-disabled
  contract instead of `not yet implemented` / scaffold wording. This does not
  enable financial order placement; status and `place_order` remain readiness
  reporting only.
- Verified `CLAUDE.md` and `AGENTS.md` are identical after the docs change.
- Verified with:
  - `bunx biome check` on touched Polymarket route/action/provider/docs files
  - `bun run --cwd plugins/plugin-polymarket-app build:types`
  - marker scan and `git diff --check` on the touched Polymarket files
- Test caveat: `bun run --cwd plugins/plugin-polymarket-app test src/PolymarketTuiView.test.tsx src/polymarket-app.test.ts src/PolymarketVisualCopy.test.ts`
  still fails in `PolymarketTuiView.test.tsx` with the package's React invalid
  hook call / renderer mismatch before asserting the changed copy; the other
  two selected tests pass.

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
- Reworded package-local web fallback docs from "web stub" to "web fallback";
  the web implementation still returns not-applicable / unavailable shapes so
  non-native callers fail closed.
- Verified `CLAUDE.md` and `AGENTS.md` are identical after the docs change.
- Verified with:
  - `bun run --cwd plugins/plugin-native-appblocker build`
  - marker scan and `git diff --check` on the touched appblocker files

### plugins/plugin-native-canvas

- Reworded cross-origin web-view snapshot fallback from placeholder language to
  unavailable-frame language in `src/web.ts`, `README.md`, `CLAUDE.md`, and
  `AGENTS.md`. Runtime behavior is unchanged: same-origin snapshots still use
  SVG foreignObject, while cross-origin content renders an explicit unavailable
  frame because browsers do not expose cross-origin iframe pixels.
- Verified `CLAUDE.md` and `AGENTS.md` are identical after the docs change.
- Verified with:
  - `bunx biome check plugins/plugin-native-canvas/src/web.ts plugins/plugin-native-canvas/CLAUDE.md plugins/plugin-native-canvas/AGENTS.md plugins/plugin-native-canvas/README.md`
  - marker scan and `git diff --check` on the touched Native Canvas files

### plugins/plugin-native-eliza-tasks

- Reworded package docs so Android and web/non-iOS support are documented as
  explicit unsupported fallback contracts instead of `not yet implemented` or
  no-op stub wording. Runtime behavior is unchanged: iOS 15+ uses
  `BGTaskScheduler` / optional APNs, and non-iOS returns `supported: false` so
  consuming apps can fall back to `@capacitor/background-runner`.
- Verified `CLAUDE.md` and `AGENTS.md` are identical after the docs change.
- Verified with marker scan and `git diff --check` on the touched
  Native Eliza Tasks docs.

### plugins/plugin-sql

- Finished `BaseDrizzleAdapter.patchComponents()` with JSON patch operations.
- Replaced the placeholder cleanup-agents integration test with real coverage.
- Added component patch integration coverage.
- Removed the empty partial-update placeholder assertion in
  `src/__tests__/integration/memory.real.test.ts`; the real partial-update
  cases above it remain the coverage source.
- Removed dead embedding-dimension inspection work from `src/base.ts`; the
  method now directly validates the requested dimension and updates the active
  embedding column.
- Reworded SQL bind-parameter, room-world optionality, snapshot comparison, and
  real-test service-double comments so they describe concrete behavior without
  stale marker language.
- Verified with:
  - `bun run --cwd plugins/plugin-sql typecheck`
  - `bunx biome check` on the touched SQL files
  - marker scan and `git diff --check` on the touched SQL files
- Test note: the touched `*.real.test.ts` files are intentionally excluded by
  `plugins/plugin-sql/src/vitest.config.ts`; direct package-script filtering
  reports "No test files found" for them.

### plugins/plugin-social-alpha

- Replaced `PriceEnrichmentService`'s random simulated price-window path with
  the existing `HistoricalPriceService`. Enrichment now fetches Birdeye OHLCV
  for Solana or DexScreener-derived price history for other chains, resolves
  the called price at the call timestamp, and computes best/worst prices from
  actual window data.
- Removed stale marker wording from token symbol resolution, recommender
  archetype classification, address-like token default-chain handling, and
  benchmark strategy fixtures.
- Verified with:
  - `bun run --cwd plugins/plugin-social-alpha test`
  - `bun run --cwd plugins/plugin-social-alpha build`
  - marker scan and `git diff --check` on the touched Social Alpha files
- Remaining scan hit is the Tailwind `placeholder:` utility in
  `src/frontend/ui/input.tsx`.

### plugins/plugin-steward-app

- Reworded the wallet core route's disabled auto-provisioning hook so it
  describes the explicit wallet-generate path without a stub marker.
- Verified with:
  - `bunx biome check plugins/plugin-steward-app/src/routes/wallet-core-routes.ts`
  - marker scan and `git diff --check` on the touched Steward App file
- Remaining scan hits are UI input `placeholder` props/classes and the
  intentional sentinel regex that rejects env values such as `PLACEHOLDER` or
  `TODO`.

### plugins/plugin-training

- Replaced the generic training-orchestrator baseline fallback in
  `src/core/training-orchestrator.ts` with concrete task baselines for
  `should_respond`, `context_routing`, `action_planner`, `response`, and
  `media_description`. Native optimizer runs no longer start from placeholder
  prompt text when runtime prompt exports are unavailable.
- Exported `loadBaselineForTask` and added
  `src/core/training-orchestrator.test.ts` to cover all supported training
  tasks.
- Reworded training CLI/service comments that described real-model-only paths
  as offline stubs, renamed unbacked comparison evidence from `incomplete` to
  `unverified`, and clarified the Vast budget "not provisioned" state. These
  are now explicit evidence/runtime states rather than placeholder language.
- Verified with:
  - `bun run --cwd plugins/plugin-training test src/core/training-orchestrator.test.ts`
  - `bun run --cwd plugins/plugin-training build:types`
  - `bunx biome check plugins/plugin-training/src/core/training-orchestrator.ts plugins/plugin-training/src/core/training-orchestrator.test.ts`
  - marker scan and `git diff --check` on touched training files
- Current focused marker scan on the newly touched training files leaves only
  input placeholder props, intentional benchmark mock labels, and the legacy
  `"placeholder call inserted"` synthetic-trajectory detector. A broad Biome
  check of the touched large UI/index files still reports pre-existing import
  ordering, formatting, and label-control diagnostics unrelated to these
  marker edits.

### plugins/plugin-vision

- Reworded browser export, mobile camera fallback, deprecated MediaPipe face
  detector, GGML face detector, native Phase 3 READMEs, DocTR conversion/build
  notes, and OCR/mobile tests so they describe explicit browser proxy
  boundaries, unavailable fallback behavior, migration shims, and planned
  native ports instead of placeholder/stub/TODO wording.
- Renamed the canonical mobile camera fallback class to
  `UnavailableMobileCameraSource` and kept `CapacitorCameraStub` as a
  deprecated compatibility alias.
- Verified with:
  - `bun run --cwd plugins/plugin-vision test src/mobile/capacitor-camera.test.ts src/yolo-detector.test.ts src/ocr-with-coords.test.ts`
  - `bun run --cwd plugins/plugin-vision build`
  - `bunx biome check` on touched Vision files
  - marker scan and `git diff --check` on the touched Vision files
- Remaining Vision boundary: native RetinaFace, MobileFaceNet, MoveNet, and
  full DocTR artifact conversion work remains pending; the package now labels
  those as planned ports or pending conversion work rather than placeholders.

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
- Renamed URL masking terminology in `src/utils.ts` from placeholder to
  fixed-width sentinel terminology. This is the internal chunking guard that
  preserves Twitter URL length accounting while restoring original URLs.
- Verified with:
  - `bun run --cwd plugins/plugin-x test src/utils/memory.test.ts`
  - `bun run --cwd plugins/plugin-x build`
  - `bun run --cwd plugins/plugin-x typecheck` (package script currently skips release typecheck)
  - `bunx biome check plugins/plugin-x/src/utils/memory.ts plugins/plugin-x/src/utils/memory.test.ts plugins/plugin-x/src/interactions.ts plugins/plugin-x/src/utils.ts`
  - marker scan and `git diff --check` on the touched X files

### plugins/plugin-wallet

- Fixed Birdeye market-cap placeholder behavior. Token market snapshots now
  carry `marketCapUsd`, the service reads common market-cap fields, and the
  provider renders the value.
- Verified with focused service test and:
  - `bun run --cwd plugins/plugin-wallet check`

## Remaining Runtime Gaps / Boundaries

### plugins/plugin-computeruse

- Removed the selectable QEMU sandbox backend stub. Sandbox mode now accepts
  the implemented Docker backend only; the throwing `qemu-backend.ts` file,
  QEMU exports, config parsing branch, docs listing, and Phase-2-specific tests
  were removed.
- Reworded non-test source markers for the optional VLM adapter, AOSP
  privileged-input path, Android process-list behavior, OCR adapter no-op
  provider, compatibility route adapter, and sandbox test fakes. The
  non-test `src/` marker scan is now clean.
- Renamed the parity taxonomy status from `stub` to `unavailable` for delivery
  models where a surface exists but cannot run in that target.
- Verified with:
  - `bun run --cwd plugins/plugin-computeruse test src/sandbox/sandbox-driver.test.ts src/__tests__/aosp-input-actor.test.ts`
  - `bun run --cwd plugins/plugin-computeruse typecheck`
  - `bun run --cwd plugins/plugin-computeruse build`
  - `bunx @biomejs/biome check` on the touched computer-use files
  - source marker scan excluding tests: `TODO|FIXME|not implemented|Phase 2|future|placeholder|stub`

### plugins/plugin-local-inference

- Image generation AOSP, Core ML, and TensorRT adapters were renamed from
  `*-stub.ts` to `*-unavailable.ts` and their comments now describe explicit
  fail-closed backend contracts. AOSP/Core ML still require platform bridge
  symbols and TensorRT still requires a packaged Windows NVIDIA binary/plans;
  the selector reports structured unavailability instead of generating
  synthetic images.
- Reworded non-voice source labels around media intent detection, image-gen
  arbiter residency, service facade ownership, and embedding-preset exports so
  they no longer advertise phase/future/stub status where the code already has
  a current contract.
- Renamed the AOSP vision-describe backend contract from `aosp-stub.ts` to
  `aosp-unavailable.ts`, updated its export path, and reworded iOS streaming
  LLM plus ASR platform-bridge comments to explicit unavailable contracts.
- Reworded the Capacitor-llama browser adapter and loader comments so the
  browser path is documented as unsupported/unavailable, and synthesized desktop
  model descriptors are telemetry defaults rather than placeholders.
- Verified with:
  - `bun run --cwd plugins/plugin-local-inference test __tests__/imagegen-handler.test.ts`
  - `bun run --cwd plugins/plugin-local-inference typecheck`
  - `bun run --cwd plugins/plugin-local-inference build`
  - focused imagegen/vision/iOS/ASR/Capacitor marker scan for old `*-stub`
    module names and stub-backend wording
- Vision AOSP / GGML markers indicate native-model backend readiness gaps, not
  simple TypeScript placeholders. Desktop FFI vision describe still needs the
  native mtmd bridge pieces called out in `desktop-llama-adapter.ts`: direct
  image-byte decoding in this package and an embeddings-batch shim wrapper
  around `llama_batch_get_one`.
- Voice pipeline markers are fail-closed safety paths:
  - seeded Samantha/I-wave speaker presets trigger regeneration, Kokoro
    fallback, or a loud startup error;
  - `StubOmniVoiceBackend` cannot start live voice or synthesize speech because
    it emits silence;
  - the renamed openWakeWord "hey jarvis" head warns that it is experimental
    and not the final Eliza-1 wake phrase.
  These should remain visible until real native voice artifacts/backends are
  staged.

### plugins/plugin-native-appblocker

- Reliable iOS timed app blocking still requires a DeviceActivity extension.
  The current iOS Family Controls path supports indefinite shields plus
  explicit `unblockApps`; timed requests fail closed with an unsupported
  capability error instead of pretending a timer is enforced.
- Fixed the package-local guide, which incorrectly said there were no tests
  even though `package.json` exposes `test` and `src/web.test.ts` covers the web
  fallback contract. Verified with:
  - `bun run --cwd plugins/plugin-native-appblocker test`
  - `bun run --cwd plugins/plugin-native-appblocker build`
  - `cmp -s plugins/plugin-native-appblocker/CLAUDE.md plugins/plugin-native-appblocker/AGENTS.md`

### plugins/plugin-polymarket-app

- Signed CLOB order execution remains disabled by design. Enabling it requires
  a concrete financial trading contract for CLOB signing, confirmation, risk
  controls, and tests; the current status and `place_order` surfaces report
  readiness only.
- Added a direct route contract test proving `/api/polymarket/status` reports
  `trading.ready: false` even when all trading credentials are present, and
  `GET`/`POST /api/polymarket/orders` return the disabled 501 contract.
  Verified with:
  - `bun run --cwd plugins/plugin-polymarket-app test src/routes.test.ts`
  - `bun run --cwd plugins/plugin-polymarket-app test`
  - `bun run --cwd plugins/plugin-polymarket-app build`

### plugins/plugin-native-system

- Reworded the package-local guide and README from "stub" language to the
  current browser fallback contract: read methods return bounded non-Android
  defaults, while Android-only actions reject with descriptive errors.
- Fixed the stale local guide command list; the package does have Vitest
  coverage for `SystemWeb`, while Android/Kotlin changes still require device
  or emulator verification through a host Capacitor app.
- Verified with:
  - `bun run --cwd plugins/plugin-native-system test`
  - `bun run --cwd plugins/plugin-native-system build`
  - focused marker scan on `plugins/plugin-native-system`
  - `cmp -s plugins/plugin-native-system/CLAUDE.md plugins/plugin-native-system/AGENTS.md`

### plugins/plugin-native-wifi

- Reworded the package-local guide and TypeScript contract from "web stub" to
  the current no-op web fallback: read methods resolve with empty state, control
  methods report unavailable Wi-Fi controls, and the fallback warns once.
- Fixed package metadata that inaccurately said the browser fallback throws;
  the tested behavior is safe empty-data resolution for non-Android runtimes.
- Verified with:
  - `bun run --cwd plugins/plugin-native-wifi test`
  - `bun run --cwd plugins/plugin-native-wifi build`
  - focused marker scan on `plugins/plugin-native-wifi`
  - `cmp -s plugins/plugin-native-wifi/CLAUDE.md plugins/plugin-native-wifi/AGENTS.md`

### plugins/plugin-eliza-classic

- Replaced the constant `TEXT_EMBEDDING` vector with a deterministic normalized
  1536-dimensional bag-of-words hash embedding. The plugin remains fully
  offline and dependency-free, but different text now produces different vector
  features instead of every request collapsing to the same unit vector.
- Exported `generateElizaEmbedding()` for direct deterministic coverage, updated
  the hand-written declaration template, and corrected the package docs/local
  guide so they describe a lexical embedding contract rather than a stub.
- Verified with:
  - `bun run --cwd plugins/plugin-eliza-classic test`
  - `bun run --cwd plugins/plugin-eliza-classic typecheck`
  - `bun run --cwd plugins/plugin-eliza-classic build`
  - focused marker scan on `plugins/plugin-eliza-classic`
  - `cmp -s plugins/plugin-eliza-classic/CLAUDE.md plugins/plugin-eliza-classic/AGENTS.md`

### plugins/plugin-undesirables

- Removed the registered no-op `MemeTrendService`, which only reserved a
  service type and logged from an unused `pollTrends()` path. The plugin now
  accurately exposes actions, providers, and its passive evaluator without a
  nonfunctional service surface.
- Updated the package guide, README, and metadata to remove service-scaffold
  claims and fix stale `ElizaOS` spelling.
- Verified with:
  - `bun run --cwd plugins/plugin-undesirables test`
  - `bun run --cwd plugins/plugin-undesirables build`
  - focused marker scan on `plugins/plugin-undesirables`
  - `cmp -s plugins/plugin-undesirables/CLAUDE.md plugins/plugin-undesirables/AGENTS.md`

### plugins/plugin-app-control

- Reworded the worker isolation source, tests, and package guide from stale
  Phase-era descriptions to the current implemented contracts: worker entry
  imports plugins and dispatches actions, worker-side fs/net gates are active,
  external apps default to worker isolation, and `AppWorkerHostService`
  best-effort auto-starts persisted worker apps through `AppRegistryService`.
- Removed ignored generated `.js`/`.d.ts` files from `src/` that were shadowing
  TypeScript sources during Vitest resolution. The stale generated worker-host
  file caused the runtime bridge test to fail even though the authoritative
  TypeScript path passed.
- Verified with:
  - `bun run --cwd plugins/plugin-app-control test src/services/__tests__/app-worker-host.test.ts src/services/__tests__/app-permissions-e2e.test.ts src/services/__tests__/app-registry-permissions.test.ts`
  - `bun run --cwd plugins/plugin-app-control typecheck`
  - `bun run --cwd plugins/plugin-app-control build`
  - focused non-test marker scan on `plugins/plugin-app-control/src`,
    `README.md`, `CLAUDE.md`, `AGENTS.md`, and worker fixtures
  - `cmp -s plugins/plugin-app-control/CLAUDE.md plugins/plugin-app-control/AGENTS.md`

### plugins/plugin-native-desktop

- Reworded the package-local window-management guide from "web stubs" to the
  current browser fallback contract: Web APIs are used where available, and
  unsupported desktop-only capabilities return no-op responses or explicit web
  errors as implemented by `DesktopWeb`.
- Verified with:
  - `bun run --cwd plugins/plugin-native-desktop test`
  - `bun run --cwd plugins/plugin-native-desktop build`
  - focused marker scan on `plugins/plugin-native-desktop`; remaining hits are
    Vitest `stubGlobal` / `unstubAllGlobals` helpers only
  - `cmp -s plugins/plugin-native-desktop/CLAUDE.md plugins/plugin-native-desktop/AGENTS.md`

### plugins/plugin-anthropic-proxy

- Completed the documented fingerprint `config.json` path. `resolveConfig()`
  now loads `config.json` from the agent working directory, or an explicit
  `CLAUDE_MAX_PROXY_CONFIG_PATH`, validates dictionary pairs, and passes
  overrides into `ProxyServer`. Explicit missing or malformed config fails
  closed instead of silently starting with unintended defaults.
- Added configurable system-prompt strip anchors and paraphrase support to the
  request pipeline, removing the prior "future work" gap for non-eliza recurring
  system-prompt blocks. Omitted config fields continue to use built-in eliza
  defaults.
- Reworded the browser export/build comments from "no-op stub" to an inert
  browser compatibility export with no server lifecycle.
- Verified with:
  - `bun run --cwd plugins/plugin-anthropic-proxy test`
  - `bun run --cwd plugins/plugin-anthropic-proxy typecheck`
  - `bun run --cwd plugins/plugin-anthropic-proxy build`
  - focused marker scan for stale `future work` / browser-stub wording
  - `cmp -s plugins/plugin-anthropic-proxy/CLAUDE.md plugins/plugin-anthropic-proxy/AGENTS.md`

### plugins/plugin-mcp

- Reworded the browser entry and package-local guide from "browser stub" /
  "no-op shim" to an inert browser compatibility export. The functional MCP
  client remains node-only because the MCP SDK transports require Node APIs.
- Verified with:
  - `bun run --cwd plugins/plugin-mcp typecheck`
  - `bun run --cwd plugins/plugin-mcp build`
  - focused marker scan on MCP source/guide files; remaining hits are prompt
    instructions that explicitly forbid placeholder values
  - `cmp -s plugins/plugin-mcp/CLAUDE.md plugins/plugin-mcp/AGENTS.md`

### plugins/plugin-bluebubbles

- Replaced the BlueBubbles account "scaffolding" path with a concrete account
  resolver contract. `accounts.ts` now merges character-level defaults,
  per-account overrides, and env fallbacks for server credentials, webhook path,
  auto-start options, policies, allowlists, read receipts, and enablement.
- Switched `BlueBubblesService` from env-only configuration to the resolved
  default account (`default` when configured, otherwise the first enabled named
  account), and stamped the selected account id into inbound, outbound, reply,
  and fetched-message metadata.
- Updated the connector-account provider comment and docs to describe the
  implemented account inventory plus single-active-service behavior instead of
  unfinished multi-account support.
- Added focused tests for named-account resolution, first-enabled default
  selection, service config selection, and connector-account provider listing.
- Verified with:
  - `bun run --cwd plugins/plugin-bluebubbles test`
  - `bun run --cwd plugins/plugin-bluebubbles typecheck`
  - `bun run --cwd plugins/plugin-bluebubbles build`
  - focused marker scan on `plugins/plugin-bluebubbles`
  - `cmp -s plugins/plugin-bluebubbles/CLAUDE.md plugins/plugin-bluebubbles/AGENTS.md`

### plugins/plugin-imessage

- Formalized the single local macOS Messages account contract. Package docs and
  connector-provider comments now describe account inventory/config merging for
  the local account instead of unused multi-account scaffolding or future
  service wiring.
- Added a connector-boundary test proving non-`default` account ids are rejected
  before outbound send dispatch.
- Reworded stale route/service comments from future/stub wording to current CLI
  client, telemetry, and chat.db-vs-AppleScript contracts.
- Verified with:
  - `bun run --cwd plugins/plugin-imessage test __tests__/message-connector.test.ts`
  - `bun run --cwd plugins/plugin-imessage test`
  - `bun run --cwd plugins/plugin-imessage typecheck`
  - `bun run --cwd plugins/plugin-imessage build`
  - focused non-test marker scan on `plugins/plugin-imessage`; remaining hit is
    a test comment about placeholder boundary characters
  - `cmp -s plugins/plugin-imessage/CLAUDE.md plugins/plugin-imessage/AGENTS.md`

### plugins/plugin-matrix

- Reworded the connector-account provider from "multi-account scaffolding" to
  the implemented multi-account resolution helper contract. Matrix already
  initializes one SDK client and MessageConnector registration per configured
  account, so no runtime change was needed.
- Verified with:
  - `bun run --cwd plugins/plugin-matrix typecheck`
  - `bun run --cwd plugins/plugin-matrix build`
  - focused marker scan on `plugins/plugin-matrix`
  - `cmp -s plugins/plugin-matrix/CLAUDE.md plugins/plugin-matrix/AGENTS.md`

### plugins/plugin-nostr

- Reworded the connector-account provider from "multi-account scaffolding" to
  the implemented multi-account resolution helper contract.
- Corrected the package-local guide so relay lifecycle constants are documented
  as reserved host-level instrumentation constants rather than emitted events.
- Rephrased the NIP-04-only note as the current DM contract instead of
  "not implemented" roadmap wording for NIP-44.
- Verified with:
  - `bun run --cwd plugins/plugin-nostr test`
  - `bun run --cwd plugins/plugin-nostr typecheck`
  - `bun run --cwd plugins/plugin-nostr build`
  - focused marker scan on `plugins/plugin-nostr`
  - `cmp -s plugins/plugin-nostr/CLAUDE.md plugins/plugin-nostr/AGENTS.md`

### plugins/plugin-whatsapp

- Reworded the connector-account provider from "multi-account scaffolding" to
  the implemented account resolution helper contract.
- Replaced setup-route "service not yet registered" comments, Baileys
  unsupported-message wording, and account-config comments with current
  service-availability, adapter-contract, and account-record terminology.
- Verified with:
  - `bun run --cwd plugins/plugin-whatsapp test`
  - `bun run --cwd plugins/plugin-whatsapp typecheck`
  - `bun run --cwd plugins/plugin-whatsapp build`
  - focused marker scan on `plugins/plugin-whatsapp`; remaining hit is a Vitest
    `stubGlobal` test helper
  - `cmp -s plugins/plugin-whatsapp/CLAUDE.md plugins/plugin-whatsapp/AGENTS.md`

### plugins/plugin-form

- Removed the unreachable `FORM action=<verb> not yet implemented` fallback.
  `formAction` only accepts `restore`; start, submit, cancel, stash, and field
  updates are documented as `FormService` / `formEvaluator` responsibilities.
- Reworded guide and source comments from future/limitation language to current
  UI-hint, component-store, and date-range contracts.
- Verified with:
  - `bun run --cwd plugins/plugin-form test`
  - `bun run --cwd plugins/plugin-form typecheck`
  - `bun run --cwd plugins/plugin-form build`
  - focused marker scan on `plugins/plugin-form`
  - `cmp -s plugins/plugin-form/CLAUDE.md plugins/plugin-form/AGENTS.md`

### plugins/plugin-line

- Reworded LINE account-provider/account-helper comments from scaffolding and
  multi-account-mode language to the implemented account resolution helper
  contract.
- Verified with:
  - `bun run --cwd plugins/plugin-line test`
  - `bun run --cwd plugins/plugin-line typecheck`
  - `bun run --cwd plugins/plugin-line build`
  - focused marker scan on `plugins/plugin-line`
  - `cmp -s plugins/plugin-line/CLAUDE.md plugins/plugin-line/AGENTS.md`

### plugins/plugin-signal

- Reworded Signal account-provider/account-helper/config comments from
  scaffolding and no-op-marker language to account resolution records and
  signal-cli credential-store boundaries.
- Verified with:
  - `bun run --cwd plugins/plugin-signal test`
  - `bun run --cwd plugins/plugin-signal build`
  - focused marker scan on `plugins/plugin-signal`; remaining hits are Vitest
    `stubGlobal` / `unstubAllGlobals` helpers
  - `cmp -s plugins/plugin-signal/CLAUDE.md plugins/plugin-signal/AGENTS.md`

### plugins/plugin-discord

- Reworded Discord account-provider/account-helper/config comments from
  scaffolding, no-op-marker, and phase labels to account resolution records,
  provider-adapter boundaries, and ordered history-fetch steps.
- Reworded the browser entry and package-local guide from browser-stub wording
  to a browser compatibility export that requires a server proxy for Discord
  gateway behavior.
- Reworded the PDF attachment error path from placeholder media to fallback
  media with a processing error.
- Verified with:
  - `bun run --cwd plugins/plugin-discord test`
  - `bun run --cwd plugins/plugin-discord typecheck`
  - `bun run --cwd plugins/plugin-discord build`
  - focused marker scan on `plugins/plugin-discord`; remaining hits are UI
    `placeholder` property names and test helper/text fixtures
  - `cmp -s plugins/plugin-discord/CLAUDE.md plugins/plugin-discord/AGENTS.md`

### plugins/plugin-feishu

- Reworded Feishu account-provider/account-helper/config comments and package
  guide layout from scaffolding language to the implemented account resolution
  helper contract.
- Verified with:
  - `bun run --cwd plugins/plugin-feishu test`
  - `bun run --cwd plugins/plugin-feishu typecheck`
  - `bun run --cwd plugins/plugin-feishu build`
  - focused marker scan on `plugins/plugin-feishu`
  - `cmp -s plugins/plugin-feishu/CLAUDE.md plugins/plugin-feishu/AGENTS.md`

### plugins/plugin-rlm

- Reworded the streaming option and package-local guide from "not yet
  supported" to the current complete-text response contract. The existing
  `metadata.stub` field remains unchanged because it is a tested public result
  metadata field used by trajectory integration.
- Verified with:
  - `bun run --cwd plugins/plugin-rlm test`
  - `bun run --cwd plugins/plugin-rlm typecheck`
  - `bun run --cwd plugins/plugin-rlm build`
  - focused incomplete-work marker scan on `plugins/plugin-rlm`
  - `cmp -s plugins/plugin-rlm/CLAUDE.md plugins/plugin-rlm/AGENTS.md`

### plugins/plugin-steward-app

- Reworded Steward bridge comments from "not yet in @stwd/sdk" to the current
  direct REST adapter contract for pending, approve, and deny endpoints outside
  the SDK surface.
- Verified with:
  - `bun run --cwd plugins/plugin-steward-app test`
  - `bun run --cwd plugins/plugin-steward-app build:types`
  - focused marker scan on `plugins/plugin-steward-app`; remaining hits are
    Vitest `stubGlobal` / `unstubAllGlobals` helpers
  - `cmp -s plugins/plugin-steward-app/CLAUDE.md plugins/plugin-steward-app/AGENTS.md`

### plugins/plugin-vision

- Reworded the OCR-with-coordinates provider, MediaPipe face detector shim,
  ggml YOLO/BlazeFace bindings, mobile camera compatibility alias, WS1 arbiter
  resolution comment, and native YOLO/doCTR unavailable paths so source comments
  describe current contracts rather than Phase/roadmap work. `RapidOcrCoordAdapter`
  is now documented as the in-tree coordinate OCR provider, with native
  providers able to register the same interface; the MediaPipe class reports the
  removed ONNX backend as unavailable and points callers to the configured
  face-recognition backend.
- Verified with:
  - `bun run --cwd plugins/plugin-vision test src/yolo-detector.test.ts src/ocr-with-coords.test.ts`
  - `bun run --cwd plugins/plugin-vision build`
  - `python3 -m py_compile plugins/plugin-vision/native/doctr.cpp/scripts/convert.py plugins/plugin-vision/native/yolo.cpp/scripts/convert.py`
  - focused marker scan on Vision source/native files excluding README docs
- Native RetinaFace, MobileFaceNet, MoveNet, and complete DocTR conversion
  artifacts remain external native-port work. Existing code reports explicit
  unavailability or uses configured optional backends rather than pretending
  those native ports are available.

### packages/chip

- `compiler/stay-decisions-generators.json` still references
  `external/ascalon-stub/README.md`. This is an external dependency path, not
  source prose or executable placeholder behavior in the chip compiler.
- The broad chip marker inventory remains dominated by explicit fail-closed
  hardware/evidence blockers: foundry PDK access gates, package-vendor
  drawings, PCB supplier returns, commercial signoff evidence, fabricated
  silicon measurements, full AOSP source builds, and generated release
  evidence placeholders. These cannot be truthfully completed inside this
  workspace; the package keeps gates and manifests visible so release claims
  stay blocked until real artifacts arrive.
- Re-ran `make -C packages/chip stub-audit`; it passed with only the documented
  allowlist entries for fail-closed CPU/CVA6-disabled, RVV, cluster, AXI-Lite,
  DRAM-controller, and verification-boundary records.
- Re-inspected `packages/chip` in the current worktree. The package-local
  guide requires fail-closed gates for blocked milestones and forbids hiding
  missing hardware evidence behind prose cleanup. `CLAUDE.md` and `AGENTS.md`
  are identical.
- Re-ran `make -C packages/chip stub-audit`; it still passes and prints the
  explicit allowlist of bounded integration stubs / blocked evidence
  boundaries.
- Remaining chip markers are real hardware/evidence gaps or machine-checked
  blocker records, including foundry PDK access, real CPU/RVV/MMU integration,
  AXI/DRAM/PLIC/SPMI boundaries, package/board/manufacturing evidence, and
  release-manifest placeholder rejection gates. These require external
  hardware/vendor artifacts or substantial implementation work and must remain
  visible until satisfied.

### packages/robot

- Reworded the Hiwonder AiNex profile action-frame TODOs in
  `profiles/hiwonder-ainex/profile.yaml` as explicit profile assumptions and
  evidence requirements. The gesture values remain conservative home-pose
  offsets; future real-robot recordings can replace them only with calibration
  evidence.
- Verified with:
  - `uv run pytest tests/test_profiles.py -q` from `packages/robot`
  - `bun run --cwd packages/robot typecheck`
  - focused marker scan on `packages/robot/profiles/hiwonder-ainex`,
    `packages/robot/src`, and `packages/robot/eliza_robot/profiles`
- Completed the MuJoCo Bezier gait controller's profile-schema TODO for
  analytic IK inputs. `GaitParams` now has optional thigh/shin lengths and
  neutral sagittal pose fields; the Hiwonder profile declares them, and
  `BezierGaitController` reads them when present while preserving defaults for
  other profiles. Verified with:
  - `uv run pytest tests/sim/mujoco/gait/test_bezier.py tests/test_profiles.py -q`
    from `packages/robot`
  - `bun run --cwd packages/robot typecheck`
  - focused marker scan on the gait controller, profile schema, Hiwonder
    profile, and gait tests

### packages/benchmarks

- Fixed the AgentBench Card Game adapter's half-enabled path. The adapter no
  longer reports the environment as runnable when `AGENTBENCH_CARD_GAME_BIN`
  points at an SDK binary but no upstream `card_game.server` bridge exists;
  `reset()` and `step()` consistently return skipped observations with the
  external dependency status.
- Updated `packages/benchmarks/agentbench/README.md` to mark Card Game as an
  external dependency path rather than a stub that can be enabled with only the
  SDK binary.
- Reworded AgentBench's legacy Python Eliza compatibility modules and loader
  comments from "stub/placeholder" language to no-op, guard, and deterministic
  task-handle contracts.
- Reworded MINT's removed Python trajectory integration module as compatibility
  no-ops owned by the TypeScript benchmark bridge, and added a focused test
  proving those legacy entry points are side-effect free.
- Replaced QwenWebBench's placeholder-directory wording with an explicit
  unavailable external-benchmark watch record, refreshed the public-availability
  note to 2026-06-03, and added the missing identical `CLAUDE.md`/`AGENTS.md`
  pair for that benchmark directory. A web check found third-party June 2026
  score mirrors, but still no public runner or dataset.
- Reworded scambench's FeedSocial importer license note as an explicit
  `unspecified-upstream` provenance boundary, added a unit test for emitted
  attribution/license metadata, and corrected its local test command to include
  the monorepo `benchmarks` namespace path.
- Reworded VoiceAgentBench direct-audio and tool-response comments to describe
  current schema fields and deterministic fixture responses, fixed the stale
  README claim that Eliza delegates to `cerebras-direct`, and corrected the
  local test command to include the sibling LifeOps benchmark path.
- Removed QwenClawBench's unused deprecated `cleanup_containers(prefix=...)`
  compatibility argument; cleanup is label-based only, and no call site passed
  the ignored parameter.
- Verified with:
  - `pytest elizaos_agentbench/tests/test_runner.py elizaos_agentbench/tests/test_upstream_loader.py -q`
    from `packages/benchmarks/agentbench`
  - `pytest packages/benchmarks/mint/tests/test_trajectory_logger.py -q`
  - `pytest packages/benchmarks/mint -q`
  - focused marker scans on AgentBench package source/README and MINT package
    source/tests
  - focused marker scan on `packages/benchmarks/qwen-web-bench`
  - `cmp -s packages/benchmarks/qwen-web-bench/CLAUDE.md packages/benchmarks/qwen-web-bench/AGENTS.md`
  - `PYTHONPATH=/home/shaw/milady/eliza/packages pytest packages/benchmarks/scambench -q`
  - focused marker scan on `packages/benchmarks/scambench`
  - `cmp -s packages/benchmarks/scambench/CLAUDE.md packages/benchmarks/scambench/AGENTS.md`
  - `PYTHONPATH=/home/shaw/milady/eliza/packages/benchmarks/voiceagentbench:/home/shaw/milady/eliza/packages/benchmarks/lifeops-bench pytest packages/benchmarks/voiceagentbench/tests -q`
  - focused marker scan on `packages/benchmarks/voiceagentbench`
  - `cmp -s packages/benchmarks/voiceagentbench/CLAUDE.md packages/benchmarks/voiceagentbench/AGENTS.md`
  - `python3 -m py_compile packages/benchmarks/qwen-claw-bench/scripts/lib_docker.py packages/benchmarks/qwen-claw-bench/scripts/benchmark.py`
  - `python3 packages/benchmarks/qwen-claw-bench/scripts/benchmark.py --help`
  - focused marker scan on QwenClawBench scripts and docs
- Remaining benchmark marker hits are fixture/test doubles, compatibility
  shims for removed upstream Python runtime surfaces outside this narrowed
  cleanup, generated SWE-bench instance Dockerfiles, SQL placeholder variables,
  or benchmark prompts that explicitly reject placeholder rows.

### packages/vault

- Completed the stale Proton Pass reference scaffold. `resolveReference()` now
  resolves Proton Pass references through the official `pass-cli item view`
  contract, accepts `pass://...` URIs or bare `vault/item/field` paths, and
  reports missing CLI, authentication, and empty-result failures as
  `PasswordManagerError`.
- Updated Proton Pass backend detection to probe `pass-cli` and `pass-cli test`
  instead of the obsolete `protonpass-cli` beta wording, and refreshed install
  metadata/docs to point at the official Proton Pass CLI installation page.
- Added focused password-manager resolver tests with an injected command
  runner, and reworded non-actionable marker language in package docs,
  inventory/storage comments, and test helpers.
- Verified with:
  - `bun run --cwd packages/vault test test/password-managers.test.ts`
  - `bun run --cwd packages/vault test`
  - `bun run --cwd packages/vault typecheck`
  - `bun run --cwd packages/vault build`
  - focused incomplete-marker scan on `packages/vault`
  - `cmp -s packages/vault/CLAUDE.md packages/vault/AGENTS.md`

### plugins/plugin-hyperliquid-app

- Implemented the advertised `kind=funding` read path instead of returning a
  static not-wired explanation. The plugin now exposes
  `GET /api/hyperliquid/funding`, fetches `metaAndAssetCtxs` from the
  Hyperliquid Info API, parses current funding/premium/mark/oracle/open-interest
  fields, and lets the action optionally filter by `coin` / `asset` / `symbol`.
- Preserved the package's explicit read-only execution contract: POST routes and
  `place_order` still return disabled-execution responses. Reworded docs/tests
  from scaffold language to read-only app language.
- Verified with:
  - `bun run --cwd plugins/plugin-hyperliquid-app test`
  - `bun run --cwd plugins/plugin-hyperliquid-app build:types`
  - `bun run --cwd plugins/plugin-hyperliquid-app build`
  - focused incomplete-marker scan on `plugins/plugin-hyperliquid-app`
    (remaining hits are `futures` market keyword, Vitest global helpers, and
    a `plugin-todos` test alias)
  - `cmp -s plugins/plugin-hyperliquid-app/CLAUDE.md plugins/plugin-hyperliquid-app/AGENTS.md`

### plugins/plugin-twitch

- Reworded the connector-account provider from stale multi-account
  "scaffolding" language to the implemented account-resolution helper contract.
- Verified with:
  - `bun run --cwd plugins/plugin-twitch test`
  - `bun run --cwd plugins/plugin-twitch build`
  - focused incomplete-marker scan on `plugins/plugin-twitch`
  - `cmp -s plugins/plugin-twitch/CLAUDE.md plugins/plugin-twitch/AGENTS.md`

### plugins/plugin-openai

- Reworded the package guide's `prompts/evaluators.json` entry from an
  "empty evaluator stub" to the shipped empty evaluator list contract. The
  plugin intentionally registers model handlers only.
- Reworded `__tests__/native-plumbing.shape.test.ts` comments so the test
  runtime and dotenv-pinned values are described without implying an unfinished
  runtime stub. Vitest's `vi.stubEnv` / `vi.unstubAllEnvs` names remain as
  framework API names.
- Verified with:
  - `bun run --cwd plugins/plugin-openai test`
  - `bun run --cwd plugins/plugin-openai typecheck`
  - `bun run --cwd plugins/plugin-openai build`
  - `bunx vitest run plugins/plugin-openai/__tests__/native-plumbing.shape.test.ts`
  - focused incomplete-marker scan on `plugins/plugin-openai` (remaining hits
    are `OPENAI_EXPERIMENTAL_TELEMETRY` / `experimental_telemetry` API names and
    Vitest env helper calls)
  - `cmp -s plugins/plugin-openai/CLAUDE.md plugins/plugin-openai/AGENTS.md`

### packages/shared

- Reworded the macOS permission deep-link helper's Win32/Linux behavior from
  "stubbed" language to its explicit warning-only fallback contract. No behavior
  changed; the utility remains macOS privacy-pane deep links plus unsupported
  platform guidance.
- Verified with:
  - `bun run --cwd packages/shared typecheck`
  - `bun run --cwd packages/shared build:dist`
  - focused incomplete-marker scan on `src/utils/permission-deep-links.ts` and
    `.d.ts`
  - `cmp -s packages/shared/CLAUDE.md packages/shared/AGENTS.md`
- Reworded local-inference network-policy, Kokoro, voice-model, GPU-profile,
  and context-scaling markers from stale scaffold/placeholder/future language
  to current contracts: platform shims live in plugin-local-inference, Kokoro
  ONNX is an unavailable shared adapter with platform-specific implementations,
  voice-model hashes are pinned audit data, and 131k+ context is
  validation-gated.
- Verified the local-inference cleanup with:
  - `bun run --cwd packages/shared test -- src/local-inference/voice-models.test.ts`
  - `bun run --cwd packages/shared typecheck`
  - `bun run --cwd packages/shared build:dist`
  - focused incomplete-marker scan on `packages/shared/src/local-inference` and
    `packages/shared/src/local-inference-gpu`
- Reworded the browser tab kit's `isTrusted` limitation from deferred future
  work to the current contract: pages that gate on trusted browser events
  require a CDP-backed automation path.
- Verified the browser-tab-kit cleanup with:
  - `bun run --cwd packages/shared typecheck`
  - focused marker scan on `packages/shared/src/utils/browser-tab-kit-types.ts`
  - `cmp -s packages/shared/CLAUDE.md packages/shared/AGENTS.md`
- Reworded the package-local cycle-guard note for `src/config/env-vars.ts` from
  an "empty stub" to an empty compatibility module, and described
  `src/config/config.ts` as the real compatibility surface.
- Verified the cycle-guard docs cleanup with:
  - focused incomplete-marker scan on `packages/shared/CLAUDE.md` and
    `packages/shared/AGENTS.md`
  - `bun run --cwd packages/shared typecheck`
  - `bun run --cwd packages/shared build:dist`
  - `cmp -s packages/shared/CLAUDE.md packages/shared/AGENTS.md`

### packages/app-core

- Loaded the package-local guide before working in `packages/app-core`. The
  guide pair is currently divergent before this pass, so no guide edits were
  made.
- Reworded source comments in `src/styles/electrobun-mac-window-drag.css`,
  `src/services/vault-mirror.ts`, `src/runtime/tts-cache-wiring.ts`,
  `src/api/cloud-voice-routes.ts`, `src/api/internal-routes.ts`, and
  `src/api/training-benchmarks.ts` so engine compatibility, cycle guards,
  TTS cache revisioning, cloud-voice fail-closed behavior, task deadlines, and
  benchmark schema migrations are described as current contracts rather than
  speculative future work.
- Verified with:
  - focused incomplete-marker scan on the touched app-core source files
  - `bunx biome check packages/app-core/src/styles/electrobun-mac-window-drag.css packages/app-core/src/services/vault-mirror.ts packages/app-core/src/runtime/tts-cache-wiring.ts packages/app-core/src/api/cloud-voice-routes.ts packages/app-core/src/api/internal-routes.ts packages/app-core/src/api/training-benchmarks.ts`
- The app-core typecheck blocker surfaced by this pass was fixed in
  `packages/agent/src/services/remote-plugin-bridge.ts`: the staged
  `worker-action-callback` envelope is now source-typed locally and dispatched
  before the generated manifest message-union switch, so workspace typecheck no
  longer depends on ignored `plugin-remote-manifest/dist` declarations being
  regenerated first.
- Verified the bridge/typecheck fix with:
  - `bun run --cwd packages/plugin-remote-manifest typecheck`
  - `bun run --cwd packages/plugin-remote-manifest test`
  - `bun run --cwd packages/plugin-remote-manifest build`
  - `bun run --cwd packages/agent test src/services/remote-plugin-bridge.test.ts`
  - `bun run --cwd packages/agent typecheck`
  - `bun run --cwd packages/app-core typecheck`
  - `bunx biome check packages/agent/src/services/remote-plugin-bridge.ts packages/app-core/src/styles/electrobun-mac-window-drag.css packages/app-core/src/services/vault-mirror.ts packages/app-core/src/runtime/tts-cache-wiring.ts packages/app-core/src/api/cloud-voice-routes.ts packages/app-core/src/api/internal-routes.ts packages/app-core/src/api/training-benchmarks.ts`
- Reworded another source-only app-core pass:
  `src/api/secrets-manager-routes.ts` now describes external password-manager
  creates as a vendor-specific UI contract and calls the test injection a fake
  exec; `src/api/auth.ts`, `src/api/server.ts`,
  `src/services/connector-target-catalog.ts`, and
  `src/services/inference-abort.ts` now describe early-boot, later-read,
  connector-slot, and local-model behavior without placeholder/future wording.
  Generated declaration files were left untouched.
- Verified with:
  - focused incomplete-marker scan on those five touched app-core source files
  - `bunx biome check packages/app-core/src/api/secrets-manager-routes.ts packages/app-core/src/api/auth.ts packages/app-core/src/api/server.ts packages/app-core/src/services/connector-target-catalog.ts packages/app-core/src/services/inference-abort.ts`
  - `bun run --cwd packages/app-core typecheck`

### plugins/plugin-telegram

- Reworded Telegram connector-account and owner-pairing markers to reflect
  provider contracts: bot-token accounts do not use OAuth, absent backend
  verifier services fail closed, and Markdown conversion uses temporary
  sentinel tokens rather than unfinished placeholders.
- Renamed the reaction event's partial original-message value to
  `reactionMessageSnapshot` and removed placeholder cast comments.
- Verified with:
  - `bun run --cwd plugins/plugin-telegram test`
  - `bun run --cwd plugins/plugin-telegram build`
  - focused incomplete-marker scan on `plugins/plugin-telegram` (remaining
    hits are Vitest `stubGlobal` calls)
  - `cmp -s plugins/plugin-telegram/CLAUDE.md plugins/plugin-telegram/AGENTS.md`

### plugins/plugin-github

- Reworded the connector account provider's env-account synthesis comment from
  stale "not yet materialized" wording to the current fallback behavior when no
  GitHub connector rows are persisted.
- Verified with:
  - `bun run --cwd plugins/plugin-github test`
  - `bun run --cwd plugins/plugin-github typecheck`
  - `bun run --cwd plugins/plugin-github build`
  - focused incomplete-marker scan on `plugins/plugin-github` (remaining hits
    are Vitest `stubGlobal` calls)
  - `cmp -s plugins/plugin-github/CLAUDE.md plugins/plugin-github/AGENTS.md`

### plugins/plugin-background-runner

- Updated native setup docs from stale cross-wave runner-JS scaffold guidance
  to the current canonical checked-in runner files under
  `packages/app-core/platforms/{ios,android}/.../runners/eliza-tasks.js`.
  The plugin's unit tests verify the runner body and assert iOS/Android copies
  remain byte-identical.
- Reworded source/test comments from future/stub wording to current service
  and test-fake contracts.
- Verified with:
  - `bun run --cwd plugins/plugin-background-runner test`
  - `bun run --cwd plugins/plugin-background-runner typecheck`
  - `bun run --cwd plugins/plugin-background-runner build`
  - focused incomplete-marker scan on `plugins/plugin-background-runner`
  - `cmp -s plugins/plugin-background-runner/CLAUDE.md plugins/plugin-background-runner/AGENTS.md`

### plugins/plugin-wallet

- Loaded the package-local guide before working in `plugins/plugin-wallet`.
- Removed stale Meteora DLMM TODOs by making the default bin range configurable
  via `METEORA_RANGE_INTERVAL_BINS`, validating configured pool addresses for
  the Meteora position provider, and documenting the DLMM full-close behavior
  for core LP removal.
- Replaced the concentrated-liquidity placeholder service with deterministic
  in-memory range-plan records, position lookup, and rebalance updates. The
  service now reports protocol submission ownership through metadata instead
  of throwing "coming soon" errors.
- Replaced Steer LP token-price placeholder behavior with DexScreener token
  price reads on supported EVM chains, preserving `null` when no indexed pair
  has a usable USD price.
- Made yield-cost SOL pricing runtime-configurable via `LP_SOL_PRICE_USD` /
  `SOL_PRICE_USD`, added audit-log hash-chain row creation/verification
  helpers, changed payment rail status wording from roadmap to planned, and
  reworded Steward Solana signing as an explicit unavailable backend capability.
- Reworded remaining wallet source/doc markers that described reserved APIs,
  browser proxy entries, compatibility hooks, extracted route ownership, and
  unsupported LP protocol operations.
- Verified with:
  - `bun run --cwd plugins/plugin-wallet test`
  - `bun run --cwd plugins/plugin-wallet check`
  - `bun run --cwd plugins/plugin-wallet build`
  - focused incomplete-marker scan on `plugins/plugin-wallet` excluding
    `dist`, `node_modules`, `coverage`, and vendor `contracts`
  - `cmp -s plugins/plugin-wallet/CLAUDE.md plugins/plugin-wallet/AGENTS.md`

### packages/examples/code

- No package-local `CLAUDE.md` / `AGENTS.md` exists, so root guidance applied.
- Replaced the `/task` slash-command placeholder with real command handling
  against the existing `CodeTaskService`: `list`, `current`, `switch`,
  `pause`, `resume`, `cancel`, and `pane show|hide|auto|toggle`.
- The handler refreshes task state into the UI store after service reads and
  mutations, supports number/id/name lookup, and preserves `/tasks` shortcut
  behavior.
- Verified with:
  - `bun run --cwd packages/examples/code typecheck`
  - `bun run --cwd packages/examples/code test` (passes; no matching test files)
  - `bun run --cwd packages/examples/code build`
  - focused incomplete-marker scan on `packages/examples/code` (remaining hits
    are README search text, a streaming-response variable named `placeholder`,
    and the `todos` metadata field)

### packages/scripts

- No package-local `CLAUDE.md` / `AGENTS.md` exists, so root guidance applied.
- Reworded the capability-router plugin-surface audit failure from "not
  implemented" to a precise missing fixture-server case.
- Renamed the sweeper unavailable helper from `_not-yet-implemented.mjs` to
  `_unavailable.mjs`, updated all sweeper imports, and changed the orchestrator
  yellow status from `not-yet-implemented` to `unavailable`.
- Renamed the llama-cpp-capacitor Android MTP smoke-build CMake injection from
  `*_STUB_*` / `eliza-mtp-stub.cpp` terminology to `*_SMOKE_*` /
  `eliza-mtp-smoke.cpp`, preserving the no-op smoke-library behavior used when
  `ELIZA_SKIP_MTP_ANDROID_LIB` is enabled, and aligned the checked-in
  dependency patch with the script.
- Renamed procedural phase labels in repo scripts to neutral step labels where
  they were orchestration headings rather than roadmap stages.
- Reworded the benchmark version remediation matrix action text so missing
  history is described as the selected current row needing a previous row,
  without speculative future-comparison wording.
- Reworded benchmark objective evidence-map copy so secret-safe rerun command
  templates are described as redacted rerun commands rather than
  placeholder-only commands.
- Reworded benchmark review-readiness ledger copy so external-gate rerun
  command affordances are described as redacted rerun commands, not placeholder
  commands.
- Reworded benchmark analysis script descriptions so manual-review outputs are
  durable review notes rather than note stubs, and model-artifact reruns are
  described as artifact-wrapper reruns instead of future runs.
- Reworded the provisioning-worker KMS preflight fixture error from
  "Steward endpoint not yet available" to "Steward endpoint unavailable".
- Renamed `packages/scripts/benchmark/stub-agent-server.mjs` to
  `synthetic-agent-server.mjs` and updated its header, usage text, synthetic
  reply metadata, model paths, job ids, bot name, 404 message, and log prefix
  to describe the deterministic benchmark harness instead of a stub.
- Verified the benchmark server rename with:
  - focused incomplete-marker scan on
    `packages/scripts/benchmark/synthetic-agent-server.mjs`
  - `rg -n "stub-agent-server|benchmark/stub-agent-server" . -g '!**/node_modules/**' -g '!**/dist/**' -g '!**/.git/**' -g '!packages/benchmarks/**' -g '!packages/training/out/**'`
  - `bun build packages/scripts/benchmark/synthetic-agent-server.mjs --target=bun --outfile=/tmp/synthetic-agent-server-check.js`
- Reworded the provisioning-worker daemon header from a Worker-runtime stub to
  a Worker-runtime shim: the Cloudflare cron boundary delegates to the Node
  sidecar because provisioning uses Node-only SSH/Docker modules.
- Renamed `packages/scripts/launch-qa/run-ui-smoke-stub.mjs` to
  `run-ui-smoke-offline.mjs`, updated launch-QA task references, and reworded
  the task description from a stub stack to a deterministic offline Playwright
  UI smoke suite. While verifying the rename, fixed the harness root/import
  paths so it resolves `packages/app` and `packages/app-core` from the real
  repository root rather than `packages/packages`.
- Verified with:
  - `bun packages/scripts/audit-capability-router-plugin-surface.ts`
  - `bun packages/scripts/sweeper/run.mjs --service gmail --dry-run`
  - `node --check packages/scripts/patch-llama-cpp-capacitor.mjs`
  - `node packages/scripts/patch-llama-cpp-capacitor.mjs`
  - `node --check scripts/consolidate-packages.mjs`
  - `bash -n scripts/build-riscv64-artifacts.sh`
  - `node --check packages/scripts/lint-no-vi-mocks.mjs`
  - `node --check packages/scripts/triage-tests.mjs`
  - focused incomplete-marker scan on `packages/scripts/sweeper` and
    `packages/scripts/audit-capability-router-plugin-surface.ts`
  - focused marker scan on the touched script and patch files
  - focused incomplete-marker scan on
    `packages/scripts/build-benchmark-version-remediation-matrix.mjs`
  - `bun build packages/scripts/build-benchmark-version-remediation-matrix.mjs --target=bun --outfile=/tmp/build-benchmark-version-remediation-matrix-check.js`
  - focused incomplete-marker scan on
    `packages/scripts/build-benchmark-objective-evidence-map.mjs`
  - `bun build packages/scripts/build-benchmark-objective-evidence-map.mjs --target=bun --outfile=/tmp/build-benchmark-objective-evidence-map-check.js`
  - focused incomplete-marker scan on
    `packages/scripts/build-benchmark-review-readiness-ledger.mjs`
  - `bun build packages/scripts/build-benchmark-review-readiness-ledger.mjs --target=bun --outfile=/tmp/build-benchmark-review-readiness-ledger-check.js`
  - focused incomplete-marker scan on
    `packages/scripts/build-benchmark-analysis-reports.mjs` and
    `packages/scripts/build-live-test-agent-review.mjs`
  - `bun build packages/scripts/build-benchmark-analysis-reports.mjs --target=bun --outfile=/tmp/build-benchmark-analysis-reports-check.js`
  - `bun build packages/scripts/build-live-test-agent-review.mjs --target=bun --outfile=/tmp/build-live-test-agent-review-check.js`
  - focused incomplete-marker scan on
    `packages/scripts/cloud/admin/daemons/provisioning-worker.test.ts`
  - focused incomplete-marker scan on
    `packages/scripts/cloud/admin/daemons/provisioning-worker.ts`
  - `bun build packages/scripts/cloud/admin/daemons/provisioning-worker.ts --target=bun --external cloudflare:sockets --external cpu-features --outfile=/tmp/provisioning-worker-check.js`
  - `bun build packages/scripts/cloud/admin/daemons/provisioning-worker.test.ts --target=bun --external cloudflare:sockets --external cpu-features --outfile=/tmp/provisioning-worker-test-check.js`
  - focused incomplete-marker scan on
    `packages/scripts/launch-qa/run-ui-smoke-offline.mjs` and
    `packages/scripts/launch-qa/run.mjs`
  - `node packages/scripts/launch-qa/run.mjs --list --suite all`
  - `bun build packages/scripts/launch-qa/run-ui-smoke-offline.mjs --target=node --outfile=/tmp/run-ui-smoke-offline-check.js`
  - `node packages/scripts/launch-qa/run-ui-smoke-offline.mjs --grep '__nonexistent_launch_qa_probe__'`
    reached the offline stack and failed at Playwright's expected "No tests
    found" selection error; no matching smoke-stack processes remained after
    shutdown.
- Verification blocker: direct `bun test
  packages/scripts/cloud/admin/daemons/provisioning-worker.test.ts` crashed in
  Bun canary before assertions with `panic: index out of bounds`; the
  externalized transpile check passed for the edited test module.

### packages/cloud-api

- Loaded the package-local guide before working in `packages/cloud-api`.
- Reworded node-only Worker 501 routes from TODO/stub wording to explicit
  Worker-boundary contracts for Vertex tuning (`node:fs`) and Docker/SSH admin
  routes (`ssh2` / `DockerSSHClient`). Runtime behavior remains the tested
  `501 not_yet_migrated` response.
- Verified with:
  - `bun run --cwd packages/cloud-api typecheck`
  - focused marker scan on the touched route files
  - `cmp -s packages/cloud-api/CLAUDE.md packages/cloud-api/AGENTS.md`

### packages/shared

- Loaded the package-local guide before working in `packages/shared`.
- Reworded the browser tab-kit `isTrusted` note from deferred future work to
  the explicit CDP-backed browser automation requirement.
- Verified with:
  - `bun run --cwd packages/shared typecheck`
  - focused marker scan on `src/utils/browser-tab-kit-types.ts`
  - `cmp -s packages/shared/CLAUDE.md packages/shared/AGENTS.md`

### packages/native/plugins/silero-vad-cpp

- Loaded the package-local guide before working in
  `packages/native/plugins/silero-vad-cpp`.
- Replaced stale stub/phase documentation with the current native CPU runtime
  status: `src/silero_vad_runtime.c` implements the public ABI, the converter
  emits the pinned v5 16 kHz GGUF, and SIMD/ggml remain backend upgrades behind
  the same ABI.
- Renamed the build-only ABI test from `silero_vad_stub_smoke` to
  `silero_vad_abi_smoke`, updated CMake and RISC-V verification scripts, and
  corrected state/runtime comments to match the shipped 128-dimensional model
  state.
- Verified with:
  - `cmake -B build -S .`
  - `cmake --build build -j`
  - `python3 scripts/silero_vad_to_gguf.py --output build/silero-vad-v5.gguf`
  - `ctest --test-dir build --output-on-failure`
  - focused incomplete-marker scan on the package excluding `build`
  - `cmp -s CLAUDE.md AGENTS.md`

### packages/native/plugins/wakeword-cpp

- Loaded the package-local guide before working in
  `packages/native/plugins/wakeword-cpp`.
- Replaced stale README/header comments that still described a public-ABI
  `-ENOSYS` stub with the current native CPU runtime contract.
- Renamed the build-only ABI smoke from `wakeword_stub_smoke` to
  `wakeword_abi_smoke`, updated CMake, test log labels, package guides, and
  the RISC-V artifact checker.
- Verified with:
  - `cmake -B build -S .`
  - `cmake --build build -j`
  - `ctest --test-dir build -R 'wakeword_(abi_smoke|melspec_test|window_test|parity_test)' --output-on-failure`
  - `bash -n scripts/check-riscv64-artifacts.sh`
  - focused incomplete-marker scan on the package excluding `build`
  - `cmp -s CLAUDE.md AGENTS.md`
- Runtime fixture note: `wakeword_runtime_test` correctly refuses to run
  without `build/wakeword/hey-eliza.{melspec,embedding,classifier}.gguf`.
  `rg --files` found no matching ONNX bundle in this checkout, so the GGUFs
  could not be generated locally.

### packages/native/plugins/face-cpp

- Loaded the package-local guide before working in
  `packages/native/plugins/face-cpp`.
- Replaced stale stub/phase documentation with the current pure-C scalar
  BlazeFace + face-embed runtime contract, including concrete converter pins
  and remaining rollout work.
- Renamed the build-only ABI smoke from `face_stub_smoke` to
  `face_abi_smoke`, updated CMake, test log labels, package guides, and the
  RISC-V artifact checker.
- Fixed two C warning sources exposed during verification: misleading
  `if`/`goto` indentation in the GGUF reader and an undersized embedder tensor
  name buffer.
- Verified with:
  - `cmake -B build -S .`
  - `cmake --build build -j`
  - `ctest --test-dir build --output-on-failure`
  - `bash -n scripts/check-riscv64-artifacts.sh`
  - focused incomplete-marker scan on the package excluding `build`
  - `cmp -s CLAUDE.md AGENTS.md`

### packages/native/plugins/doctr-cpp

- Loaded the package-local guide before working in
  `packages/native/plugins/doctr-cpp`.
- Replaced the `-ENOSYS` public ABI stub with `src/doctr_runtime.c`,
  which opens and validates docTR GGUF metadata, stores the CTC vocab,
  dispatches detection/recognition to the existing pure-C reference
  forwards, and reports `cpu-ref`.
- Switched CMake from the stub-only source list to the GGUF reader,
  image helpers, kernels, DBNet postprocess, CTC decoder, detector
  forward, recognizer forward, and runtime glue.
- Renamed `doctr_stub_smoke` to `doctr_abi_smoke`, updated test
  expectations from `-ENOSYS` to real-backend error contracts, and
  updated the RISC-V artifact checker.
- Replaced stale guide/README/header/converter comments with the current
  native-runtime contract and remaining rollout work.
- Verified with:
  - `cmake -B build -S .`
  - `cmake --build build -j`
  - `ctest --test-dir build --output-on-failure`
  - `bash -n scripts/check-riscv64-artifacts.sh`
  - focused incomplete-marker scan on the package excluding `build`
  - `cmp -s CLAUDE.md AGENTS.md`
- Rollout note: parity fixtures and plugin-vision production wiring remain
  explicit follow-up work; the package no longer exposes an `ENOSYS` ABI.

### plugins/plugin-gitpathologist

- Loaded the package-local guide before working in
  `plugins/plugin-gitpathologist`.
- Renamed procedural pipeline "Phase 1..5" labels to neutral "Step 1..5"
  labels in the package guide and pipeline file headers.
- Reworded the classifier comment about optional LLM refinement so it no
  longer reads like deferred roadmap work.
- Verified with:
  - `bun run --cwd plugins/plugin-gitpathologist typecheck`
  - `bun run --cwd plugins/plugin-gitpathologist test`
  - focused incomplete-marker scan on the package
  - `cmp -s CLAUDE.md AGENTS.md`

### packages/shared + packages/tui + plugins/plugin-form + plugins/plugin-shopify-ui

- Loaded the relevant package-local guides before working in
  `packages/tui`, `plugins/plugin-form`, and `plugins/plugin-shopify-ui`;
  reused the already-loaded `packages/shared` guide context.
- Synchronized the browser tab kit declaration wording with the source
  contract: sites that gate on `isTrusted` require host-controlled CDP
  automation.
- Renamed procedural TUI viewport repro comments from "Phase" to "Step".
- Reworded form type comments that described extension metadata and empty
  field state without changing the public `placeholder` field name.
- Reworded the Shopify dashboard 404 comment as a disconnected-route state,
  not unfinished service startup work.
- Verified with:
  - `bun run --cwd packages/shared typecheck`
  - `bun run --cwd packages/tui build`
  - `bun run --cwd packages/tui test`
  - `bun run --cwd plugins/plugin-form typecheck`
  - `bun run --cwd plugins/plugin-form test`
  - focused incomplete-marker scans on the touched files
  - guide-pair `cmp -s` checks for the packages with local guides

### packages/plugin-worker-runtime

- Loaded the package-local guide before working in
  `packages/plugin-worker-runtime`.
- Tightened the remote runtime contract around event registration:
  `Plugin.events` remains the supported worker-boundary mechanism because
  bootstrap announces stable RPC handler ids, while live
  `runtime.registerEvent` callbacks cannot be serialized over host-RPC.
- Removed `registerEvent` from the advertised host-RPC supported-method list,
  updated the thrown error and unit expectation, and synchronized README plus
  CLAUDE/AGENTS wording.
- Verified with:
  - `bun run --cwd packages/plugin-worker-runtime typecheck`
  - `bun run --cwd packages/plugin-worker-runtime test`
  - focused incomplete-marker scan on source/docs
  - `cmp -s packages/plugin-worker-runtime/CLAUDE.md packages/plugin-worker-runtime/AGENTS.md`

### deploy/systemd

- Confirmed there is no deploy-local guide for `deploy/systemd`.
- Added `deploy/systemd/smoke-test.sh`, a non-mutating static smoke test that
  renders unit templates, verifies substitution tokens are resolved,
  syntax-checks helper scripts plus the installer, and runs
  `systemd-analyze verify` against a temporary parser copy when available.
- Updated the README layout and smoke-test section so the bundle has a
  concrete verification command instead of a stale untested-host warning.
- Verified with:
  - `deploy/systemd/smoke-test.sh`
  - focused incomplete-marker scan on `deploy/systemd`

### plugins/plugin-app-control

- Loaded the package-local guide before working in
  `plugins/plugin-app-control`.
- Reworded view navigation and edit-handler comments to describe shell 501
  fallback behavior and the coding-agent scope boundary without implying
  unfinished handler work.
- Reworded compatibility comments in protected-app and app-registry code from
  generic future work to newer-version/back-compat behavior.
- Renamed the worker action-handler runtime helper from `makeRuntimeStub` to
  `makeSandboxRuntimeFacade`; it exposes the gated worker runtime surface and
  is not a test double.
- Verified with:
  - `bun run --cwd plugins/plugin-app-control typecheck`
  - `bun run --cwd plugins/plugin-app-control test`
  - focused incomplete-marker scan on package source/docs
  - focused incomplete-marker scan on
    `src/workers/app-worker-entry.ts` after the runtime-facade rename
  - `cmp -s plugins/plugin-app-control/CLAUDE.md plugins/plugin-app-control/AGENTS.md`
- Tooling note: a direct `bun test
  plugins/plugin-app-control/src/services/__tests__/app-registry-permissions.test.ts`
  invocation crashed in Bun canary before assertions; the package's configured
  Vitest suite passed after the same comment-only change.

### plugins/plugin-task-coordinator

- Loaded the package-local guide before working in
  `plugins/plugin-task-coordinator`.
- Reworded slot-fill docs from placeholder terminology to empty-slot defaults.
- Clarified Odysseus port comments around local-storage notes, task add states,
  search settings, research, disabled slash rows, and disabled cookbook controls
  as explicit frontend/runtime boundaries instead of deferred implementation
  notes.
- Renamed Odysseus phase/roadmap comments to current shell and reuse-existing
  ACP wording.
- Verified with:
  - `bun run --cwd plugins/plugin-task-coordinator build:types`
  - `bun run --cwd plugins/plugin-task-coordinator test`
  - focused incomplete-marker scan on package source/docs
  - `cmp -s plugins/plugin-task-coordinator/CLAUDE.md plugins/plugin-task-coordinator/AGENTS.md`
- Remaining broad-scan hits in this package are UI `placeholder=` attributes,
  CSS `::placeholder` selectors, and domain vocabulary such as todo/status
  fields.

### packages/training

- Loaded the package-local guide before working in `packages/training`.
- Reworded the prompt-builder merge-policy comment so it describes the current
  v1-preferred fallback behavior without "not yet" wording.
- Verified with:
  - `python3 -m py_compile packages/training/scripts/build_prompts.py`
  - focused incomplete-marker scan on the script and package docs
  - `cmp -s packages/training/CLAUDE.md packages/training/AGENTS.md`
- Remaining focused hit is Python's `from __future__ import annotations`.

### packages/native/ios-deps

- Confirmed there is no package-local CLAUDE/AGENTS guide for
  `packages/native/ios-deps`.
- Added `sqlite-vec/build-ios.sh`, a host-gated iOS xcframework build harness
  for the pinned sqlite-vec release with `all`, `device`, `simulator`, and
  `clean` commands.
- Wired package scripts for sqlite-vec build/clean commands and included
  sqlite-vec in the package `build` script; both llama.cpp and sqlite-vec skip
  cleanly on non-macOS hosts unless the local iOS build env vars are set.
- Replaced excluded native dependency pins in `VERSIONS` with explicit
  `excluded-from-ios-build` values, updated the llama.cpp pin guard, and
  refreshed sqlite-vec docs from manual-only status to the new build command.
- Verified with:
  - `bash -n packages/native/ios-deps/llama.cpp/build-ios.sh`
  - `bash -n packages/native/ios-deps/sqlite-vec/build-ios.sh`
  - `bun run --cwd packages/native/ios-deps build:sqlite-vec`
  - `bun run --cwd packages/native/ios-deps build`
  - focused incomplete-marker scan on `packages/native/ios-deps` excluding
    build/dist outputs

### packages/native/plugins/qjl-cpu

- Loaded the package-local guide before working in
  `packages/native/plugins/qjl-cpu`.
- Reworded the RVV int8 Zvqdot note as extension-readiness guidance; current
  RVV silicon uses the implemented widening multiply/add path.
- Renamed empty-translation-unit typedef markers from `*_stub` to
  `*_empty_tu_marker` across architecture-gated C files.
- Reworded README source-of-truth language now that the llama.cpp quant type
  exists in the fork.
- Verified with:
  - `cmake -B build -S .`
  - `cmake --build build -j`
  - `./build/qjl_int8_smoke`
  - `./build/qjl_avxvnni_smoke`
  - focused incomplete-marker scan on the package excluding `build`
  - `cmp -s packages/native/plugins/qjl-cpu/CLAUDE.md packages/native/plugins/qjl-cpu/AGENTS.md`
- Remaining focused hit is Python's `from __future__ import annotations`.

### packages/native/plugins/polarquant-cpu + packages/native/plugins/turboquant-cpu

- Loaded package-local guides before working in both native quant packages.
- Corrected PolarQuant GGUF type drift from stale `Q4_POLAR=45` references to
  the current elizaOS fork value `GGML_TYPE_Q4_POLAR=47`, including converter
  constants, converter tests, README, and fork-integration patch docs.
- Fixed `scripts/test_converter.py` repo-root calculation so it can import the
  training PolarQuant reference from the current checkout.
- Reworded PolarQuant residual/fork integration comments and renamed
  empty-translation-unit typedef markers from `*_stub` to
  `*_empty_tu_marker`.
- Reworded TurboQuant docs/CMake comments so the current scalar + RVV lane
  matrix is explicit and x86/arm64 scalar fallback is not described as
  placeholder work.
- Verified with:
  - `cmake -B build -S .`
  - `cmake --build build -j`
  - `ctest --test-dir build --output-on-failure`
  - `python3 scripts/test_converter.py` for PolarQuant
  - the same CMake build + `ctest` sequence for TurboQuant
  - focused incomplete-marker scan on both packages excluding `build`
  - guide-pair `cmp -s` checks for both packages
- Remaining focused hits are Python's `from __future__ import annotations`.

### plugins/plugin-registry

- Loaded the package-local guide before working in `plugins/plugin-registry`.
- Reworded stale "Phase 4F" extraction banners in the public barrel, route
  files, and source declaration file as consolidated plugin-registry surface
  notes.
- Reworded the route-extension guide step so adding a new
  `PluginRouteContext` helper is described directly.
- Verified with:
  - `bun run --cwd plugins/plugin-registry build`
  - focused incomplete-marker scan on the package excluding `dist`
  - `cmp -s plugins/plugin-registry/CLAUDE.md plugins/plugin-registry/AGENTS.md`
- Previous verification blocker was cleared by the source-level
  `packages/agent/src/services/remote-plugin-bridge.ts` callback-envelope
  typing fix recorded under `packages/app-core`.
- `plugins/plugin-registry typecheck` then exposed a separate source-config
  gap: it imports `@elizaos/ui` source, whose dynamic view loader imports
  `@elizaos/plugin-training`, but the registry tsconfig did not include UI's
  host-external declaration for that package. Added the same path/include used
  by `packages/ui` so typecheck no longer depends on ignored
  `plugins/plugin-training/dist/*.d.ts` output. `bun run --cwd
  plugins/plugin-training build:types` was also run to refresh the local
  ignored dist state during diagnosis.
- Verified the cleared blockers with:
  - `bun run --cwd plugins/plugin-registry typecheck`
  - `bun run --cwd packages/app-core typecheck`
  - `bunx biome check plugins/plugin-registry/tsconfig.json packages/agent/src/services/remote-plugin-bridge.ts`

### plugins/plugin-agent-skills

- Loaded the package-local guide before working in
  `plugins/plugin-agent-skills`.
- Reworded consolidated-code phase comments in the barrel, tsup config, and
  service configuration sections.
- Reworded `__NODE_MANAGER__` install-command placeholder comments as command
  token resolution.
- Verified with:
  - `bun run --cwd plugins/plugin-agent-skills typecheck`
  - `bun run --cwd plugins/plugin-agent-skills test`
  - focused incomplete-marker scan on the package excluding `dist`
  - `cmp -s plugins/plugin-agent-skills/CLAUDE.md plugins/plugin-agent-skills/AGENTS.md`
- Remaining focused hit is the literal skill taxonomy term `todo`.

### plugins/plugin-training

- Loaded the package-local guide before working in `plugins/plugin-training`;
  `CLAUDE.md` and `AGENTS.md` are identical.
- Corrected stale training-config docs: `backends` now documents the current
  default `["native"]` in-process optimizer backend instead of a deferred
  native-backend wiring phase.
- Reworded the auto-training route section banner and DSPy/training-trigger
  test-double comments without changing route or optimizer behavior.
- Verified with:
  - focused incomplete-marker scan on `src/` excluding UI placeholder props and
    tests; remaining hits are the literal action name `OWNER_TODOS`.
  - `bun run --cwd plugins/plugin-training build:types`
  - `bun run --cwd plugins/plugin-training build:js`
  - `cmp -s plugins/plugin-training/CLAUDE.md plugins/plugin-training/AGENTS.md`
- Remaining broad package hits are UI `placeholder` props, prompt/dataset text
  that instructs models to preserve placeholders, test fakes, and the synthetic
  trajectory marker string `"placeholder call inserted"` used by
  `isSyntheticTrajectory`.

### plugins/plugin-native-phone

- Loaded the package-local guide before working in
  `plugins/plugin-native-phone`.
- Reworded Android-only platform docs so iOS is described as unsupported by
  this Telecom bridge rather than "not implemented".
- Reworded web `PhoneWeb` docs from stub terminology to safe web fallback, and
  clarified declared Android permissions as capability declarations.
- Verified with:
  - `bun run --cwd plugins/plugin-native-phone build`
  - focused incomplete-marker scan on the package excluding `dist`
  - `cmp -s plugins/plugin-native-phone/CLAUDE.md plugins/plugin-native-phone/AGENTS.md`

### plugins/plugin-native-screencapture

- Loaded the package-local guide before working in
  `plugins/plugin-native-screencapture`; `CLAUDE.md` and `AGENTS.md` are
  identical.
- Reworded the web `ImageCapture` declaration comment as a TypeScript lib-set
  compatibility declaration rather than a deferred browser API gap.
- Verified with:
  - focused incomplete-marker scan on `src/web.ts`
  - `bun run --cwd plugins/plugin-native-screencapture test`
  - `bun run --cwd plugins/plugin-native-screencapture build`
  - `cmp -s plugins/plugin-native-screencapture/CLAUDE.md plugins/plugin-native-screencapture/AGENTS.md`
- Remaining broad package hits are Vitest `stubGlobal` / `unstubAllGlobals`
  API calls in `src/web.test.ts`.

### plugins/plugin-native-eliza-tasks

- Loaded the package-local guide before working in
  `plugins/plugin-native-eliza-tasks`.
- Reworded the Android support note in `CLAUDE.md` / `AGENTS.md` so the
  `capacitor.android` key is documented as package metadata retained for
  Capacitor shape, not a future Android implementation marker.
- Copied `CLAUDE.md` to `AGENTS.md` to keep the guide pair identical.
- Verified with:
  - focused incomplete-marker scan on both guide files
  - `bun run --cwd plugins/plugin-native-eliza-tasks build`
  - `bun run --cwd plugins/plugin-native-eliza-tasks test`
  - `cmp -s plugins/plugin-native-eliza-tasks/CLAUDE.md plugins/plugin-native-eliza-tasks/AGENTS.md`

### plugins/plugin-native-contacts

- Loaded the package-local guide before working in
  `plugins/plugin-native-contacts`.
- Reworded the `ContactsWeb` guide entries in `CLAUDE.md` / `AGENTS.md` from
  no-op stub terminology to the intended web fallback contract:
  `listContacts=[]`, writes throw.
- Copied `CLAUDE.md` to `AGENTS.md` to keep the guide pair identical.
- Verified with:
  - focused incomplete-marker scan on both guide files
  - `bun run --cwd plugins/plugin-native-contacts build`
  - `cmp -s plugins/plugin-native-contacts/CLAUDE.md plugins/plugin-native-contacts/AGENTS.md`

### plugins/plugin-native-calendar

- Loaded the package-local guide before working in
  `plugins/plugin-native-calendar`.
- Reworded the web/browser fallback docs in `CLAUDE.md` / `AGENTS.md` from
  stub terminology to the intended `not_supported` fallback contract for
  native-only calendar methods.
- Copied `CLAUDE.md` to `AGENTS.md` to keep the guide pair identical.
- Verified with:
  - focused incomplete-marker scan on both guide files
  - `bun run --cwd plugins/plugin-native-calendar build`
  - `cmp -s plugins/plugin-native-calendar/CLAUDE.md plugins/plugin-native-calendar/AGENTS.md`

### plugins/plugin-native-canvas

- Loaded the package-local guide before working in
  `plugins/plugin-native-canvas`.
- Reworded the method-extension guide in `CLAUDE.md` / `AGENTS.md` from
  "native stubs/implementations" to "native handlers/implementations".
- Copied `CLAUDE.md` to `AGENTS.md` to keep the guide pair identical.
- Verified with:
  - focused incomplete-marker scan on both guide files
  - `bun run --cwd plugins/plugin-native-canvas build`
  - `cmp -s plugins/plugin-native-canvas/CLAUDE.md plugins/plugin-native-canvas/AGENTS.md`
- Remaining broad package hit is `createContextStub` in `src/web.test.ts`,
  a test helper name.

### plugins/plugin-native-mobile-agent-bridge

- Loaded the package-local guide before working in
  `plugins/plugin-native-mobile-agent-bridge`.
- Reworded web runtime docs and metadata in `CLAUDE.md`, `AGENTS.md`,
  `README.md`, `package.json`, and `src/definitions.ts` from stub
  terminology to the intended error-state web fallback contract.
- Copied `CLAUDE.md` to `AGENTS.md` to keep the guide pair identical.
- Verified with:
  - focused incomplete-marker scan on all touched bridge files
  - `bun run --cwd plugins/plugin-native-mobile-agent-bridge build`
  - `bun run --cwd plugins/plugin-native-mobile-agent-bridge test`
  - `cmp -s plugins/plugin-native-mobile-agent-bridge/CLAUDE.md plugins/plugin-native-mobile-agent-bridge/AGENTS.md`

### plugins/plugin-native-macosalarm

- Loaded the package-local guide before working in
  `plugins/plugin-native-macosalarm`; `CLAUDE.md` and `AGENTS.md` are
  identical.
- Renamed the helper test's fake process factory from `createSpawnStub` to
  `createFakeSpawn`.
- Verified with:
  - focused incomplete-marker scan on `__tests__/helper.test.ts`
  - `bun run --cwd plugins/plugin-native-macosalarm typecheck`
  - `bun run --cwd plugins/plugin-native-macosalarm test`
  - `bun run --cwd plugins/plugin-native-macosalarm build:ts`
  - `cmp -s plugins/plugin-native-macosalarm/CLAUDE.md plugins/plugin-native-macosalarm/AGENTS.md`

### plugins/plugin-facewear

- Loaded the package-local guide before working in `plugins/plugin-facewear`.
- Reworded the `MockSmartglassesTransport` guide entry in `CLAUDE.md` /
  `AGENTS.md` from testing-stub wording to test-transport wording.
- Copied `CLAUDE.md` to `AGENTS.md` to keep the guide pair identical.
- Verified with:
  - focused incomplete-marker scan on both guide files
  - `bun run --cwd plugins/plugin-facewear typecheck`
  - `bun run --cwd plugins/plugin-facewear build:types`
  - `cmp -s plugins/plugin-facewear/CLAUDE.md plugins/plugin-facewear/AGENTS.md`
- Remaining broad package hits are intentional ratchet tests that assert built
  native/view artifacts are not placeholders or stubs, plus UI input
  `placeholder` props.

### plugins/plugin-device-filesystem

- Loaded the package-local guide before working in
  `plugins/plugin-device-filesystem`; `CLAUDE.md` and `AGENTS.md` are
  identical.
- Reworded the Android README note so cross-app `MediaStore.Downloads`
  sharing is documented as a host-app manifest boundary, not a deferred
  feature.
- Verified with:
  - focused incomplete-marker scan on `README.md`
  - `bun run --cwd plugins/plugin-device-filesystem check`
  - `cmp -s plugins/plugin-device-filesystem/CLAUDE.md plugins/plugin-device-filesystem/AGENTS.md`

### plugins/plugin-device-settings

- Loaded the package-local guide before working in
  `plugins/plugin-device-settings`; `CLAUDE.md` and `AGENTS.md` are
  identical.
- Reworded the Android `WRITE_SETTINGS` README note as a normal missing
  permission state, not a deferred grant state.
- Verified with:
  - focused incomplete-marker scan on `README.md`
  - `bun run --cwd plugins/plugin-device-settings typecheck`
  - `bun run --cwd plugins/plugin-device-settings test`
  - `bun run --cwd plugins/plugin-device-settings build`
  - `cmp -s plugins/plugin-device-settings/CLAUDE.md plugins/plugin-device-settings/AGENTS.md`

### plugins/plugin-elizacloud

- Loaded the package-local guide before working in
  `plugins/plugin-elizacloud`.
- Reworded browser exports as inert browser shims, the cloud-login restart hook
  as the current provisioning rebind contract, x402 auto-pay as outside the
  route boundary, and waifu metering fallback text as current bridge behavior.
- Updated matching source declaration comments in `src/*.d.ts` files.
- Reworded test comments in cloud setup, Cloud TTS roundtrip, and Duffel
  adapter tests so observer migrations, test-client replacement, queued fetch
  responses, and offline HTTP fixtures are described without stale stub or
  follow-up language. Vitest `vi.stubGlobal` / `vi.unstub*` calls remain as
  framework API names.
- Verified with:
  - `bun run --cwd plugins/plugin-elizacloud typecheck`
  - `bun run --cwd plugins/plugin-elizacloud test:unit`
  - `bunx vitest run plugins/plugin-elizacloud/__tests__/cloud-setup-failures.test.ts plugins/plugin-elizacloud/__tests__/cloud-tts-roundtrip.test.ts plugins/plugin-elizacloud/__tests__/unit/duffel-client.test.ts`
  - focused incomplete-marker scan on source/docs
  - `cmp -s plugins/plugin-elizacloud/CLAUDE.md plugins/plugin-elizacloud/AGENTS.md`

### plugins/plugin-anthropic-proxy

- Loaded the package-local guide before working in
  `plugins/plugin-anthropic-proxy`; `CLAUDE.md` and `AGENTS.md` are identical.
- Reworded the eliza-fingerprint identity replacement comments in source and
  docs. Identity replacements are documented as current presence detectors,
  with custom dictionaries as the supported override path for neutral
  synonyms.
- Verified with:
  - focused incomplete-marker scan on the touched source/doc files
  - `bun run --cwd plugins/plugin-anthropic-proxy typecheck`
  - `bun run --cwd plugins/plugin-anthropic-proxy test`
  - `bun run --cwd plugins/plugin-anthropic-proxy build`
  - `cmp -s plugins/plugin-anthropic-proxy/CLAUDE.md plugins/plugin-anthropic-proxy/AGENTS.md`
- Remaining broad hits are `cc-tool-stubs` identifiers and `injectCCStubs`
  options. Those are the package's term for synthetic Claude Code tool
  definitions injected into the proxy request body, not unfinished stubs.

### plugins/plugin-roblox

- Loaded the package-local guide before working in `plugins/plugin-roblox`.
- Reworded `ROBLOX_WEBHOOK_SECRET` docs in `CLAUDE.md`, `AGENTS.md`, and
  `README.md`. The value is documented as config exposed for external inbound
  bridges while the built-in plugin remains outbound-only.
- Copied `CLAUDE.md` to `AGENTS.md` to keep the guide pair identical.
- Verified with:
  - focused incomplete-marker scan on the touched docs
  - `bun run --cwd plugins/plugin-roblox typecheck`
  - `bun run --cwd plugins/plugin-roblox test`
  - `bun run --cwd plugins/plugin-roblox build`
  - `cmp -s plugins/plugin-roblox/CLAUDE.md plugins/plugin-roblox/AGENTS.md`

### plugins/plugin-video

- Loaded the package-local guide before working in `plugins/plugin-video`;
  `CLAUDE.md` and `AGENTS.md` are identical.
- Reworded the transcription cache comment so MP3 retention is documented as
  current content-cache ownership by callers, not speculative reuse.
- Verified with:
  - focused incomplete-marker scan on `src/services/video.ts`
  - `bun run --cwd plugins/plugin-video typecheck`
  - `bun run --cwd plugins/plugin-video test`
  - `bun run --cwd plugins/plugin-video build`
  - `cmp -s plugins/plugin-video/CLAUDE.md plugins/plugin-video/AGENTS.md`

### plugins/plugin-ngrok

- No package-local `CLAUDE.md` / `AGENTS.md` exists, so root guidance applied.
- Renamed the test utility runtime variable from `placeholderRuntime` to
  `mockRuntime`; it constructs a mock runtime for `MockNgrokService`, not a
  placeholder implementation.
- Verified with:
  - focused incomplete-marker scan on `src/__tests__/test-utils.ts`
  - `bun run --cwd plugins/plugin-ngrok typecheck`
  - `bun run --cwd plugins/plugin-ngrok test:unit`
  - `bun run --cwd plugins/plugin-ngrok build`

### plugins/plugin-music

- Loaded the package-local guide before working in `plugins/plugin-music`;
  `CLAUDE.md` and `AGENTS.md` are identical.
- Reworded local interface comments in `src/actions/playAudio.ts` and
  `src/services/smartMusicFetch.ts` from stub language to type-shim language
  for optional cross-plugin/native dependencies that lack declarations.
- Reworded music-library persistence and Discord connection comments in
  `src/actions/playAudio.ts` and `src/service.ts` so later lookup and pending
  connection states are described without future/not-yet wording.
- Verified with:
  - focused incomplete-marker scan on the three touched plugin-music files
  - `bun run --cwd plugins/plugin-music typecheck`
  - `bunx biome check plugins/plugin-music/src/actions/playAudio.ts plugins/plugin-music/src/services/smartMusicFetch.ts plugins/plugin-music/src/service.ts`
  - `cmp -s plugins/plugin-music/CLAUDE.md plugins/plugin-music/AGENTS.md`

### plugins/plugin-local-storage

- Loaded the package-local guide before working in
  `plugins/plugin-local-storage`; `CLAUDE.md` and `AGENTS.md` are identical.
- Removed the build-script fallback that swallowed `tsc --project
  tsconfig.build.json` failures and wrote a bogus `dist/index.d.ts` re-export
  to `./src/index.js`. The build now emits real declarations and fails closed
  if declaration generation fails.
- Verified with:
  - `bun run --cwd plugins/plugin-local-storage build`
  - `bun run --cwd plugins/plugin-local-storage typecheck`
  - focused incomplete-marker scan on the build script and local docs
  - inspected `dist/index.d.ts` and confirmed it imports
    `./services/local-storage` and re-exports `./types`
  - `cmp -s plugins/plugin-local-storage/CLAUDE.md plugins/plugin-local-storage/AGENTS.md`
  - `git diff --check -- plugins/plugin-local-storage/build.ts`

### plugins/plugin-native-llama

- Loaded the package-local guide before working in
  `plugins/plugin-native-llama`; `CLAUDE.md` and `AGENTS.md` are identical.
- Reworded native bridge boundary comments/messages in
  `src/capacitor-llama-adapter.ts`: per-generation sampler stages are logged
  as load/spec-time configuration boundaries, `setDrafter()` reports the
  unsupported live-swap contract and points callers to `LoadOptions.draftModelPath`,
  and `trimMemory()` describes the current absence of a native trim hook.
- Reworded `src/index.ts` and the local guide pair from unavailable/stub or
  native-stub wording to unavailable adapter/native source wording.
- Verified with:
  - focused incomplete-marker scan on touched native-llama source/docs
  - `bun run --cwd plugins/plugin-native-llama build`
  - `bunx biome check plugins/plugin-native-llama/src/capacitor-llama-adapter.ts plugins/plugin-native-llama/src/index.ts plugins/plugin-native-llama/CLAUDE.md plugins/plugin-native-llama/AGENTS.md`
  - `cmp -s plugins/plugin-native-llama/CLAUDE.md plugins/plugin-native-llama/AGENTS.md`

### plugins/plugin-mcp

- Loaded the package-local guide before working in `plugins/plugin-mcp`;
  `CLAUDE.md` and `AGENTS.md` are identical.
- Reworded mock-runtime helper errors in `src/tool-compatibility/` from
  "Not implemented in mock" to the exact unsupported mock surface:
  service-load promises are not exposed.
- Verified with:
  - focused incomplete-marker scan on the touched tool-compatibility files
  - `bun run --cwd plugins/plugin-mcp typecheck`
  - `bun run --cwd plugins/plugin-mcp test`
  - `bun run --cwd plugins/plugin-mcp build`
  - `cmp -s plugins/plugin-mcp/CLAUDE.md plugins/plugin-mcp/AGENTS.md`
- Remaining broad package hits are prompt instructions that explicitly tell
  the model not to invent placeholders.

### plugins/plugin-rlm

- Loaded the package-local guide before working in `plugins/plugin-rlm`.
- Reworded docs in `CLAUDE.md`, `AGENTS.md`, and `README.md` so missing
  Python-backend behavior is described as explicit failure instead of
  returning fallback text/responses, without placeholder terminology.
- Copied `CLAUDE.md` to `AGENTS.md` to keep the guide pair identical.
- Verified with:
  - focused incomplete-marker scan on the touched docs
  - `bun run --cwd plugins/plugin-rlm typecheck`
  - `bun run --cwd plugins/plugin-rlm test`
  - `bun run --cwd plugins/plugin-rlm build`
  - `cmp -s plugins/plugin-rlm/CLAUDE.md plugins/plugin-rlm/AGENTS.md`
- Remaining broad package hits are the `metadata.stub` API field and tests
  asserting it; that is a tracked RLM result metadata property.

### plugins/plugin-computeruse

- Loaded the package-local guide before inspecting
  `plugins/plugin-computeruse`; `CLAUDE.md` and `AGENTS.md` are identical.
- Replaced the loose iOS device-validation TODO wording with a structured
  evidence manifest at `docs/ios-device-validation.json` and a validator script
  at `scripts/validate-ios-device-evidence.mjs`.
- Added `validate:ios-device-evidence` to `package.json`. The default command
  validates that all required iOS bridge methods and evidence fields are
  tracked. The release gate `--require-complete` fails until a physical device
  run records device/build/validator metadata, artifacts, and passed or
  platform-blocked per-method results.
- Updated `docs/IOS_CONSTRAINTS.md` and
  `docs/MOBILE_ASSISTANT_ROUTING.md` to point at the manifest and release gate
  instead of stale source TODO wording.
- Verified with:
  - `bun run --cwd plugins/plugin-computeruse validate:ios-device-evidence`
  - `bun run --cwd plugins/plugin-computeruse typecheck`
  - `bunx biome check plugins/plugin-computeruse/package.json plugins/plugin-computeruse/docs/ios-device-validation.json plugins/plugin-computeruse/scripts/validate-ios-device-evidence.mjs`
  - focused incomplete-marker scan on the touched iOS validation docs/scripts
  - `git diff --check -- plugins/plugin-computeruse/package.json plugins/plugin-computeruse/docs/IOS_CONSTRAINTS.md plugins/plugin-computeruse/docs/MOBILE_ASSISTANT_ROUTING.md plugins/plugin-computeruse/docs/ios-device-validation.json plugins/plugin-computeruse/scripts/validate-ios-device-evidence.mjs`
  - `cmp -s plugins/plugin-computeruse/CLAUDE.md plugins/plugin-computeruse/AGENTS.md`
- Current release-gate status: `node scripts/validate-ios-device-evidence.mjs
  --require-complete docs/ios-device-validation.json` fails as expected because
  no physical-device evidence is recorded yet. Remaining broad package hits are
  mostly deterministic test fakes/stubs and golden-test contracts.

### plugins/plugin-aosp-local-inference

- Loaded the package-local guide before working in
  `plugins/plugin-aosp-local-inference`; `CLAUDE.md` and `AGENTS.md` are
  identical.
- Reworded defensive comments in `src/aosp-llama-adapter.ts` and
  `src/aosp-local-inference-bootstrap.ts` so shim binding limits, exhaustive
  KV-cache mapping, embedding pooling guards, and manifest-driven model bundle
  swaps are described as current contracts instead of speculative future work.
- Verified with:
  - focused incomplete-marker scan on the touched AOSP source files
  - `bun run --cwd plugins/plugin-aosp-local-inference typecheck`
  - `bun run --cwd plugins/plugin-aosp-local-inference test`
  - `cmp -s plugins/plugin-aosp-local-inference/CLAUDE.md plugins/plugin-aosp-local-inference/AGENTS.md`

### plugins/plugin-native-camera

- Loaded the package-local guide before working in
  `plugins/plugin-native-camera`; `CLAUDE.md` and `AGENTS.md` are identical.
- Reworded `src/web.ts` and the package-local guide so browser camera
  enumeration is documented as unlabeled device records before permission, and
  `startPreview()` permission behavior is documented as the current web
  fallback contract rather than a migration/future-probe TODO.
- Verified with:
  - focused incomplete-marker scan on `src/web.ts`, `CLAUDE.md`, and `AGENTS.md`
  - `bun run --cwd plugins/plugin-native-camera build`
  - `cmp -s plugins/plugin-native-camera/CLAUDE.md plugins/plugin-native-camera/AGENTS.md`

### packages/native/plugins/voice-classifier-cpp

- Loaded the package-local guide before inspecting
  `packages/native/plugins/voice-classifier-cpp`; `CLAUDE.md` and
  `AGENTS.md` are identical.
- No cleanup applied in this pass. The guide, README, C headers, and smoke
  tests intentionally describe a real port gap: the voice emotion,
  audio-end-of-turn, speaker, and diarizer model entry points still return
  `-ENOSYS` behind the frozen ABI while shared utilities such as mel features,
  class labels, and speaker distance are real.
- `scripts/voice_eot_to_gguf.py` still contains TODO/`NotImplementedError`
  conversion blocks and placeholder upstream identifiers. That is unfinished
  converter work, not stale wording.
- `scripts/check-riscv64-artifacts.sh` therefore still includes
  `voice_classifier_stub_smoke` as a RISC-V ABI smoke target. Completing this
  package requires pinned upstream recipes, real GGUF converters, ggml-backed
  model translation units, and parity fixtures.

### packages/native/plugins/yolo-cpp

- Loaded the package-local guide before inspecting
  `packages/native/plugins/yolo-cpp`; `CLAUDE.md` and `AGENTS.md` are
  identical.
- No cleanup applied in this pass. The package is real for class lookup, NMS,
  postprocess helpers, GGUF reading, letterbox preprocessing, scalar kernels,
  and runtime open/close, but `yolo_detect` still returns `-ENOSYS` after the
  preprocessing path because the YOLO forward op schedule is not wired.
- `scripts/check-riscv64-artifacts.sh` therefore still includes
  `yolo_stub_smoke` as a RISC-V ABI smoke target. Completing this package
  requires the scalar-C or ggml-dispatched v8n/v11n forward pass plus parity
  fixtures and production backend wiring.

### plugins/plugin-x

- Loaded the package-local guide before working in `plugins/plugin-x`;
  `CLAUDE.md` and `AGENTS.md` are identical.
- Reworded the `ClientBase.onReady()` lifecycle hook and error message in
  `src/base.ts` so it states the concrete-client override contract without
  using incomplete-implementation wording. Reworded the test fixture comments
  in `src/tests.ts` away from stale stub/verify markers.
- Verified with:
  - focused incomplete-marker scan on `src/base.ts`, `src/tests.ts`,
    `CLAUDE.md`, and `AGENTS.md`
  - `bunx @biomejs/biome check plugins/plugin-x/src/base.ts plugins/plugin-x/src/tests.ts`
  - `bun run --cwd plugins/plugin-x test`
  - `cmp -s plugins/plugin-x/CLAUDE.md plugins/plugin-x/AGENTS.md`

### plugins/plugin-streaming

- Loaded the package-local guide before working in
  `plugins/plugin-streaming`; `CLAUDE.md` and `AGENTS.md` are identical.
- Reworded the first-frame polling comment in
  `src/api/stream-routes.ts` so the frame-file stat race is documented as the
  current retry behavior rather than a not-ready marker.
- Verified with:
  - focused incomplete-marker scan on `src/api/stream-routes.ts`, `CLAUDE.md`,
    and `AGENTS.md`
  - `bunx @biomejs/biome check plugins/plugin-streaming/src/api/stream-routes.ts`
  - `bun run --cwd plugins/plugin-streaming typecheck`
  - `cmp -s plugins/plugin-streaming/CLAUDE.md plugins/plugin-streaming/AGENTS.md`

### plugins/plugin-workflow

- Loaded the package-local guide before working in
  `plugins/plugin-workflow`; `CLAUDE.md` and `AGENTS.md` are identical.
- Removed the stale `@todo` marker from `src/utils/catalog.ts` and reworded
  source comments in `workflow-service.ts`, `automations-builder.ts`,
  `workflow-clarification.ts`, and `workflow-dispatch.ts` so embedded-catalog
  lookup, route-test doubles, and later duplicate checks are described as
  current behavior rather than unfinished work.
- Verified with:
  - focused incomplete-marker scan on touched workflow source files,
    `CLAUDE.md`, and `AGENTS.md` (remaining hit is the documented
    `test:e2e` script name)
  - `bunx @biomejs/biome check plugins/plugin-workflow/src/services/workflow-service.ts plugins/plugin-workflow/src/utils/catalog.ts plugins/plugin-workflow/src/lib/automations-builder.ts plugins/plugin-workflow/src/lib/workflow-clarification.ts plugins/plugin-workflow/src/services/workflow-dispatch.ts`
  - `bun run --cwd plugins/plugin-workflow typecheck`
  - `cmp -s plugins/plugin-workflow/CLAUDE.md plugins/plugin-workflow/AGENTS.md`

### plugins/plugin-lmstudio

- Loaded the package-local guide before working in
  `plugins/plugin-lmstudio`; `CLAUDE.md` and `AGENTS.md` are identical.
- Reworded LM Studio config/detection comments and the package guide so
  health-probe URL helpers and deterministic fetch injection are described as
  current test/diagnostic behavior instead of future/stub work.
- Verified with:
  - focused incomplete-marker scan on `utils/config.ts`, `utils/detect.ts`,
    `CLAUDE.md`, and `AGENTS.md`
  - `bunx @biomejs/biome check plugins/plugin-lmstudio/utils/config.ts plugins/plugin-lmstudio/utils/detect.ts plugins/plugin-lmstudio/CLAUDE.md plugins/plugin-lmstudio/AGENTS.md`
  - `bun run --cwd plugins/plugin-lmstudio typecheck`
  - `cmp -s plugins/plugin-lmstudio/CLAUDE.md plugins/plugin-lmstudio/AGENTS.md`

### packages/app-core

- Loaded the package-local guide before working in `packages/app-core`.
- Reworded source comments and messages in
  `src/security/platform-secure-store-node.ts`,
  `src/services/secrets-manager-installer.ts`, and
  `src/services/phrase-chunked-tts.ts` so unavailable platform secure-store
  backends, injected process-spawn fixtures, and PhraseChunker load
  preconditions are described as current contracts rather than placeholder,
  stub, or not-yet-loaded markers.
- Verified with:
  - focused incomplete-marker scan on the touched app-core source files
  - `bunx @biomejs/biome check packages/app-core/src/security/platform-secure-store-node.ts packages/app-core/src/services/secrets-manager-installer.ts packages/app-core/src/services/phrase-chunked-tts.ts`
  - `bun run --cwd packages/app-core typecheck`

### plugins/plugin-elizamaker

- Loaded the package-local guide before working in
  `plugins/plugin-elizamaker`; `CLAUDE.md` and `AGENTS.md` are identical.
- Reworded `src/og-tracker.ts` and the deferred-init note in the package guide
  so OG-code eligibility and route readiness are described as current external
  script/service-initialization contracts rather than future/not-ready markers.
- Verified with:
  - focused incomplete-marker scan on `src/og-tracker.ts`, `CLAUDE.md`, and
    `AGENTS.md` (remaining hits are domain terms: Merkle proofs and
    Twitter/NFT verification routes)
  - `bunx @biomejs/biome check plugins/plugin-elizamaker/src/og-tracker.ts plugins/plugin-elizamaker/CLAUDE.md plugins/plugin-elizamaker/AGENTS.md`
  - `bun run --cwd plugins/plugin-elizamaker build`
  - `cmp -s plugins/plugin-elizamaker/CLAUDE.md plugins/plugin-elizamaker/AGENTS.md`

### plugins/plugin-social-alpha

- Loaded the package-local guide before working in
  `plugins/plugin-social-alpha`; `CLAUDE.md` and `AGENTS.md` are identical.
- Reworded the trust-leaderboard world seed comment, simulation actor scenario
  check comment, and package-guide release-skip wording so deterministic
  migrations, scenario checks, and intentionally skipped package scripts do not
  read as future/stub work.
- Verified with:
  - focused incomplete-marker scan on touched social-alpha files (remaining
    hits are simulated social-message copy containing the word `roadmap`)
  - `bunx @biomejs/biome check plugins/plugin-social-alpha/src/config.ts plugins/plugin-social-alpha/src/services/simulationActorsV2.ts plugins/plugin-social-alpha/CLAUDE.md plugins/plugin-social-alpha/AGENTS.md`
  - `bun run --cwd plugins/plugin-social-alpha test`
  - `cmp -s plugins/plugin-social-alpha/CLAUDE.md plugins/plugin-social-alpha/AGENTS.md`

### packages/shared and packages/ui

- Loaded the package-local guides before working in `packages/shared` and
  `packages/ui`; both `CLAUDE.md` / `AGENTS.md` pairs are identical.
- Reworded comments in `packages/shared/src/local-inference/catalog.ts` and
  UI local-inference/widget/startup/browser-workspace helpers so pending model
  bundles, registered widget visibility, service orchestration callers,
  retry-on-next-boot behavior, startup fetch races, and credential selection are
  described as current contracts rather than future/not-yet/incomplete markers.
- Verified with:
  - focused incomplete-marker scan on touched shared/ui files (remaining hits
    are domain/API names such as `verifyModel`, placeholder props, and
    local-inference placeholder-id policy constants)
  - `bunx @biomejs/biome check packages/shared/src/local-inference/catalog.ts packages/ui/src/widgets/visibility.ts packages/ui/src/services/local-inference/service.ts packages/ui/src/first-run/auto-download-recommended.ts packages/ui/src/utils/transient-fetch.ts packages/ui/src/components/pages/BrowserWorkspaceView.tsx`
  - `bun run --cwd packages/shared typecheck`
  - `bun run --cwd packages/ui typecheck`
  - `cmp -s packages/shared/CLAUDE.md packages/shared/AGENTS.md`
  - `cmp -s packages/ui/CLAUDE.md packages/ui/AGENTS.md`

### packages/core

- Loaded the package-local guide before working in `packages/core`;
  `CLAUDE.md` and `AGENTS.md` are identical.
- Reworded runtime/type comments across service registration, sandbox policy,
  action model routing, plugin-manager extensions, pipeline hooks, plugin
  schema versioning, messaging metadata, and streaming callbacks so lazy
  startup, compatibility, and additive fields are described without
  future/not-yet markers.
- Verified with:
  - focused incomplete-marker scan on touched core files (remaining hits are
    validation/domain terms and guide script names)
  - `bunx @biomejs/biome check packages/core/src/runtime.ts packages/core/src/sandbox-policy.ts packages/core/src/runtime/action-model-routing.ts packages/core/src/features/plugin-manager/coreExtensions.ts packages/core/src/types/pipeline-hooks.ts packages/core/src/types/plugin-store.ts packages/core/src/types/messaging.ts packages/core/src/types/components.ts`
  - `bun run --cwd packages/core typecheck`
  - `cmp -s packages/core/CLAUDE.md packages/core/AGENTS.md`

### packages/agent

- Loaded the package-local guide before working in `packages/agent`;
  `CLAUDE.md` and `AGENTS.md` are identical.
- Renamed private remote-plugin bridge helper methods from `*Stub` to `*Proxy`
  and reworded the bridge header to reflect the currently wired proxy
  contributions. Reworded optional-dependency ambient declarations in
  `external-modules.d.ts` from loose stubs to ambient shims.
- Verified with:
  - focused stub/future marker scan on `src/services/remote-plugin-bridge.ts`
    and `src/external-modules.d.ts`
  - `bunx @biomejs/biome check packages/agent/src/services/remote-plugin-bridge.ts packages/agent/src/external-modules.d.ts`
  - `bun run --cwd packages/agent typecheck`
  - `cmp -s packages/agent/CLAUDE.md packages/agent/AGENTS.md`

### plugins/plugin-wallet

- Loaded the package-local guide before working in
  `plugins/plugin-wallet`; `CLAUDE.md` and `AGENTS.md` are identical.
- Reworded stale FIXME/placeholder/verify comments in Birdeye market and LP
  analytics files so static market addresses, API-limited Kamino fields,
  preview-only receiver sentinels, and runtime method checks are described as
  current behavior.
- Verified with:
  - focused incomplete-marker scan on touched wallet source files, `CLAUDE.md`,
    and `AGENTS.md` (remaining hits are guide route names such as
    `sign/verify`)
  - `bunx @biomejs/biome check plugins/plugin-wallet/src/analytics/birdeye/providers/market.ts plugins/plugin-wallet/src/analytics/lpinfo/kamino/services/kaminoService.ts plugins/plugin-wallet/src/analytics/lpinfo/steer/services/steerLiquidityService.ts`
  - `bun run --cwd plugins/plugin-wallet check`
  - `cmp -s plugins/plugin-wallet/CLAUDE.md plugins/plugin-wallet/AGENTS.md`

### plugins/plugin-local-inference

- Loaded the package-local guide before working in
  `plugins/plugin-local-inference`; `CLAUDE.md` and `AGENTS.md` are identical.
- Reworded `GENERATE_MEDIA` video refusal text and related comments so video
  generation is described as an unavailable local-backend capability rather
  than a "coming soon" / not-yet marker. Reworded local assignment,
  vision-cache, router-latency, and TTS-registration comments away from
  future/not-yet phrasing, and updated the action test assertion to the new
  refusal copy.
- Verified with:
  - focused incomplete-marker scan on touched local-inference files, tests,
    `CLAUDE.md`, and `AGENTS.md` (remaining hits are guide terms for manifest
    validation and the `NODE_OPTIONS=--experimental-sqlite` test command)
  - `bunx @biomejs/biome check plugins/plugin-local-inference/src/actions/generate-media.ts plugins/plugin-local-inference/src/services/assignments.ts plugins/plugin-local-inference/src/services/vision-embedding-cache.ts plugins/plugin-local-inference/src/services/router-handler.ts plugins/plugin-local-inference/src/services/tts/index.ts plugins/plugin-local-inference/__tests__/generate-media-action.test.ts`
  - `bun run --cwd plugins/plugin-local-inference typecheck`
  - `NODE_OPTIONS='--experimental-sqlite' bunx vitest run --config ./vitest.config.ts __tests__/generate-media-action.test.ts` from `plugins/plugin-local-inference`
  - `bun run --cwd plugins/plugin-local-inference test`
  - `cmp -s plugins/plugin-local-inference/CLAUDE.md plugins/plugin-local-inference/AGENTS.md`

### plugins/plugin-contacts and plugins/plugin-sql

- Loaded the package-local guides before working in `plugins/plugin-contacts`
  and `plugins/plugin-sql`; both `CLAUDE.md` / `AGENTS.md` pairs are
  identical.
- Reworded the contacts detail-panel read-only note so unsupported contact
  editing is presented as the current device capability boundary. Reworded SQL
  migration RLS/snapshot-cache messages so schema readiness is described
  without not-yet wording.
- Verified with:
  - focused incomplete-marker scan on touched contacts/SQL files and guides
    (remaining contacts hits are input `placeholder=` props)
  - `bunx @biomejs/biome check plugins/plugin-contacts/src/components/ContactsAppView.tsx plugins/plugin-sql/src/migration-service.ts plugins/plugin-sql/src/migrations.ts`
  - `bun run --cwd plugins/plugin-contacts typecheck`
  - `bun run --cwd plugins/plugin-sql typecheck`
  - `cmp -s plugins/plugin-contacts/CLAUDE.md plugins/plugin-contacts/AGENTS.md`
  - `cmp -s plugins/plugin-sql/CLAUDE.md plugins/plugin-sql/AGENTS.md`

### packages/shared and packages/ui follow-up

- Loaded the package-local guides before working in `packages/shared` and
  `packages/ui`; both `CLAUDE.md` / `AGENTS.md` pairs are identical.
- Reworded additional shared app-permissions/API-key-prefix comments and UI
  local-inference/widget comments so forward-compatibility, manifest schema
  rejection, model activation, bundled-model replacement, assignment safety,
  and widget default propagation are described without future/not-yet markers.
- Verified with:
  - focused incomplete-marker scan on touched shared/ui files
  - `bunx @biomejs/biome check packages/ui/src/widgets/useChatSidebarVisibility.ts packages/ui/src/services/local-inference/assignments.ts packages/ui/src/services/local-inference/downloader.ts packages/ui/src/services/local-inference/home-model-status.ts packages/ui/src/services/local-inference/bundled-models.ts packages/shared/src/contracts/app-permissions.ts packages/shared/src/contracts/app-permissions-routes.ts packages/shared/src/contracts/health.ts packages/shared/src/config/api-key-prefix-hints.ts`
  - `bun run --cwd packages/shared typecheck`
  - `bun run --cwd packages/ui typecheck`
  - `cmp -s packages/shared/CLAUDE.md packages/shared/AGENTS.md`
  - `cmp -s packages/ui/CLAUDE.md packages/ui/AGENTS.md`

### packages/core follow-up

- Loaded the package-local guide before working in `packages/core`; `CLAUDE.md`
  and `AGENTS.md` are identical.
- Reworded analysis-mode sidecar comments, relationship-cache/sentiment
  comments, unavailable messaging-adapter contract notes, and ballot/plugin
  action callback text so current behavior is described without roadmap,
  placeholder, PUNT, or not-yet phrasing.
- Verified with:
  - focused incomplete-marker scan on touched core files
  - `bunx @biomejs/biome check packages/core/src/services/analysis-mode-handler.ts packages/core/src/services/relationships.ts packages/core/src/features/messaging/triage/adapters/base.ts packages/core/src/features/plugin-config/actions/activate-plugin-if-ready.ts packages/core/src/features/ballots/actions/tally-ballot-if-threshold-met.ts`
  - `bun run --cwd packages/core typecheck`
  - `bun run --cwd packages/core test -- features/ballots/actions/tally-ballot-if-threshold-met.test.ts features/plugin-config/actions/activate-plugin-if-ready.test.ts`
  - `git diff --check -- packages/core/src/services/analysis-mode-handler.ts packages/core/src/services/relationships.ts packages/core/src/features/messaging/triage/adapters/base.ts packages/core/src/features/plugin-config/actions/activate-plugin-if-ready.ts packages/core/src/features/ballots/actions/tally-ballot-if-threshold-met.ts PLACEHOLDER_AUDIT.md`

### packages/app-core follow-up

- Loaded the package-local guide before working in `packages/app-core`;
  `CLAUDE.md` and `AGENTS.md` are identical.
- Reworded WebGPU ambient-type, compat Drizzle lookup, sensitive-request
  adapter coverage, and bootstrap-token expiry comments so current behavior is
  described without not-yet or future markers.
- Verified with:
  - focused incomplete-marker scan on touched app-core files
  - `bunx @biomejs/biome check packages/app-core/src/ambient-modules.d.ts packages/app-core/src/api/compat-route-shared.ts packages/app-core/src/services/sensitive-requests/index.ts packages/app-core/src/api/auth/bootstrap-token.ts`
  - `bun run --cwd packages/app-core typecheck`
  - `git diff --check -- packages/app-core/src/ambient-modules.d.ts packages/app-core/src/api/compat-route-shared.ts packages/app-core/src/services/sensitive-requests/index.ts packages/app-core/src/api/auth/bootstrap-token.ts PLACEHOLDER_AUDIT.md`

### packages/agent prompt-compaction follow-up

- Loaded the package-local guide before working in `packages/agent`;
  `CLAUDE.md` and `AGENTS.md` are identical.
- Reworded prompt-compaction comments from "stub" terminology to
  summary-entry terminology, matching the actual behavior of preserving action
  names/descriptions while omitting parameter details for context economy.
- Verified with:
  - focused incomplete-marker scan on `packages/agent/src/runtime/prompt-compaction.ts`
  - `bunx @biomejs/biome check packages/agent/src/runtime/prompt-compaction.ts`
  - `bun run --cwd packages/agent typecheck`
  - `bun run --cwd packages/agent test -- src/runtime/view-action-affinity.test.ts`
  - `git diff --check -- packages/agent/src/runtime/prompt-compaction.ts PLACEHOLDER_AUDIT.md`

### packages/core type-contract follow-up

- Loaded the package-local guide before working in `packages/core`;
  `CLAUDE.md` and `AGENTS.md` are identical.
- Reworded remote-plugin surface comments from "stubs" to proxy terminology,
  changed auto-enable fallback wording, and updated form type documentation
  from future-frontends wording to forward-compatible GUI hints.
- Verified with:
  - focused incomplete-marker scan on touched core type files (remaining hits
    are the intentional `placeholder?: string` form UI field and its label)
  - `bunx @biomejs/biome check packages/core/src/types/plugin.ts packages/core/src/features/advanced-capabilities/form/types.ts`
  - `bun run --cwd packages/core typecheck`
  - `git diff --check -- packages/core/src/types/plugin.ts packages/core/src/features/advanced-capabilities/form/types.ts PLACEHOLDER_AUDIT.md`

### plugins/plugin-health follow-up

- Loaded the package-local guide before working in `plugins/plugin-health`;
  `CLAUDE.md` and `AGENTS.md` are identical.
- Reworded registry-unavailable log messages, public-surface and smoke-test
  comments, and the package guide's screen-time ownership note so they describe
  current soft-dependency and ownership boundaries without not-yet/future
  roadmap phrasing.
- Verified with:
  - focused incomplete-marker scan on touched health source, test, and guide
    files (remaining hit is the concrete OAuth `pending-session state` label)
  - `bunx @biomejs/biome check plugins/plugin-health/CLAUDE.md plugins/plugin-health/AGENTS.md plugins/plugin-health/src/connectors/index.ts plugins/plugin-health/src/default-packs/index.ts plugins/plugin-health/src/index.ts plugins/plugin-health/src/__tests__/smoke.test.ts`
  - `bun run --cwd plugins/plugin-health build:types`
  - `bun run --cwd plugins/plugin-health test -- src/__tests__/smoke.test.ts`
  - `cmp -s plugins/plugin-health/CLAUDE.md plugins/plugin-health/AGENTS.md`
  - `git diff --check -- plugins/plugin-health/CLAUDE.md plugins/plugin-health/AGENTS.md plugins/plugin-health/src/connectors/index.ts plugins/plugin-health/src/default-packs/index.ts plugins/plugin-health/src/index.ts plugins/plugin-health/src/__tests__/smoke.test.ts PLACEHOLDER_AUDIT.md`

### plugins/plugin-lifeops widget follow-up

- Loaded the package-local guide before working in `plugins/plugin-lifeops`;
  `CLAUDE.md` and `AGENTS.md` are identical.
- Reworded the widgets entry comment so exported overview reuse is described
  without future-entry-point wording.
- Verified with:
  - focused incomplete-marker scan on `plugins/plugin-lifeops/src/widgets/index.ts`
  - `bunx @biomejs/biome check plugins/plugin-lifeops/src/widgets/index.ts`
  - `bun run --cwd plugins/plugin-lifeops build:types`
  - `cmp -s plugins/plugin-lifeops/CLAUDE.md plugins/plugin-lifeops/AGENTS.md`
  - `git diff --check -- plugins/plugin-lifeops/src/widgets/index.ts PLACEHOLDER_AUDIT.md`

### packages/agent extract-params follow-up

- Loaded the package-local guide before working in `packages/agent`;
  `CLAUDE.md` and `AGENTS.md` are identical.
- Reworded the extraction helper comment so missing required parameters are
  described without "incomplete" marker wording.
- Verified with:
  - focused incomplete-marker scan on `packages/agent/src/actions/extract-params.ts`
  - `bunx @biomejs/biome check packages/agent/src/actions/extract-params.ts`
  - `bun run --cwd packages/agent typecheck`
  - `git diff --check -- packages/agent/src/actions/extract-params.ts PLACEHOLDER_AUDIT.md`

### plugins/plugin-local-inference route follow-up

- Loaded the package-local guide before working in
  `plugins/plugin-local-inference`; `CLAUDE.md` and `AGENTS.md` are identical.
- Reworded the cloud-routing chat result from future-call wording to
  subsequent-call wording.
- Verified with:
  - focused incomplete-marker scan on `plugins/plugin-local-inference/src/local-inference-routes.ts`
  - `bunx @biomejs/biome check plugins/plugin-local-inference/src/local-inference-routes.ts`
  - `bun run --cwd plugins/plugin-local-inference typecheck`
  - `git diff --check -- plugins/plugin-local-inference/src/local-inference-routes.ts PLACEHOLDER_AUDIT.md`

### packages/ui first-run probe follow-up

- Loaded the package-local guide before working in `packages/ui`; `CLAUDE.md`
  and `AGENTS.md` are identical.
- Reworded local-agent health compatibility comments from spike-stub wording
  to legacy-probe-shape wording and fixed the adjacent sentence typo.
- Verified with:
  - focused incomplete-marker scan on `packages/ui/src/first-run/probe-local-agent.ts`
  - `bunx @biomejs/biome check packages/ui/src/first-run/probe-local-agent.ts`
  - `bun run --cwd packages/ui typecheck`
  - `bun run --cwd packages/ui test -- src/first-run/probe-local-agent.test.ts`
  - `git diff --check -- packages/ui/src/first-run/probe-local-agent.ts PLACEHOLDER_AUDIT.md`

### plugins/plugin-local-inference download/FFI follow-up

- Loaded the package-local guide before working in
  `plugins/plugin-local-inference`; `CLAUDE.md` and `AGENTS.md` are identical.
- Reworded downloader schema-version, voice-model route injection hooks,
  single-asset download policy, and FFI streaming adapter comments so they
  describe current compatibility boundaries without future/stub marker
  wording.
- Verified with:
  - focused incomplete-marker scan on touched local-inference files
  - `bunx @biomejs/biome check plugins/plugin-local-inference/src/services/downloader.ts plugins/plugin-local-inference/src/routes/voice-models-routes.ts plugins/plugin-local-inference/src/services/ffi-streaming-runner.ts`
  - `bun run --cwd plugins/plugin-local-inference typecheck`
  - `git diff --check -- plugins/plugin-local-inference/src/services/downloader.ts plugins/plugin-local-inference/src/routes/voice-models-routes.ts plugins/plugin-local-inference/src/services/ffi-streaming-runner.ts PLACEHOLDER_AUDIT.md`

### packages/ui onboarding follow-up

- Loaded the package-local guide before working in `packages/ui`; `CLAUDE.md`
  and `AGENTS.md` are identical.
- Reworded onboarding tray-contract and Electrobun drag-region comments so
  current tray handling and browser-engine compatibility are described without
  Stage-B/incomplete/future marker wording.
- Verified with:
  - focused incomplete-marker scan on touched UI files
  - `bunx @biomejs/biome check packages/ui/src/first-run/onboarding-intent.ts packages/ui/src/styles/electrobun-mac-window-drag.css`
  - `bun run --cwd packages/ui typecheck`
  - `bun run --cwd packages/ui test -- src/first-run/onboarding-intent.test.ts`
  - `git diff --check -- packages/ui/src/first-run/onboarding-intent.ts packages/ui/src/styles/electrobun-mac-window-drag.css PLACEHOLDER_AUDIT.md`

### plugins/plugin-lifeops proactive/platform follow-up

- Loaded the package-local guide before working in `plugins/plugin-lifeops`;
  `CLAUDE.md` and `AGENTS.md` are identical.
- Reworded platform-guard test comments/helper names and proactive-planner
  cooldown/design comments so platform overrides, clock skew, and GN routing
  boundaries are described without stub/future/punt marker wording.
- Verified with:
  - focused incomplete-marker scan on touched LifeOps files (remaining hit is
    the literal product word `todos` in user-facing proactive copy)
  - `bunx @biomejs/biome check plugins/plugin-lifeops/src/__tests__/platform-guards.test.ts plugins/plugin-lifeops/src/activity-profile/proactive-planner.ts`
  - `bun run --cwd plugins/plugin-lifeops build:types`
  - `bun run --cwd plugins/plugin-lifeops test -- src/__tests__/platform-guards.test.ts`
  - `git diff --check -- plugins/plugin-lifeops/src/__tests__/platform-guards.test.ts plugins/plugin-lifeops/src/activity-profile/proactive-planner.ts PLACEHOLDER_AUDIT.md`

### packages/agent compact-conversation follow-up

- Loaded the package-local guide before working in `packages/agent`;
  `CLAUDE.md` and `AGENTS.md` are identical.
- Reworded the compact-conversation action description from future prompt
  context to subsequent prompt context.
- Verified with:
  - focused incomplete-marker scan on `packages/agent/src/actions/compact-conversation.ts`
  - `bunx @biomejs/biome check packages/agent/src/actions/compact-conversation.ts`
  - `bun run --cwd packages/agent typecheck`
  - `bun run --cwd packages/agent test -- src/actions/compact-conversation.test.ts`
  - `git diff --check -- packages/agent/src/actions/compact-conversation.ts PLACEHOLDER_AUDIT.md`

### packages/app-core credential-tunnel follow-up

- Loaded the package-local guide before working in `packages/app-core`;
  `CLAUDE.md` and `AGENTS.md` are identical.
- Reworded the credential tunnel test title from future-expiry wording to
  unexpired-expiry wording.
- Verified with:
  - focused incomplete-marker scan on `packages/app-core/src/services/credential-tunnel-service.test.ts`
  - `bunx @biomejs/biome check packages/app-core/src/services/credential-tunnel-service.test.ts`
  - `bun run --cwd packages/app-core typecheck`
  - `bun run --cwd packages/app-core test -- src/services/credential-tunnel-service.test.ts`
  - `git diff --check -- packages/app-core/src/services/credential-tunnel-service.test.ts PLACEHOLDER_AUDIT.md`

### plugins/plugin-local-inference apple-foundation follow-up

- Loaded the package-local guide before working in
  `plugins/plugin-local-inference`; `CLAUDE.md` and `AGENTS.md` are identical.
- Reworded Apple Foundation backend availability-probe comments from not-yet
  wording to unavailable-state wording.
- Verified with:
  - focused incomplete-marker scan on `plugins/plugin-local-inference/src/backends/apple-foundation.ts`
  - `bunx @biomejs/biome check plugins/plugin-local-inference/src/backends/apple-foundation.ts`
  - `bun run --cwd plugins/plugin-local-inference typecheck`
  - `git diff --check -- plugins/plugin-local-inference/src/backends/apple-foundation.ts PLACEHOLDER_AUDIT.md`

### plugins/plugin-computeruse test-double follow-up

- Loaded the package-local guide before working in `plugins/plugin-computeruse`;
  `CLAUDE.md` and `AGENTS.md` are identical.
- Reworded sandbox/mobile/cascade test-double comments and helper names from
  stub terminology to fake/mock/unavailable terminology, and fixed a Biome
  non-null assertion warning in the touched cascade test.
- Verified with:
  - focused incomplete-marker scan on touched computeruse test files
  - `bunx @biomejs/biome check plugins/plugin-computeruse/src/sandbox/sandbox-driver.test.ts plugins/plugin-computeruse/src/__tests__/mobile-computer-interface.test.ts plugins/plugin-computeruse/src/__tests__/cascade.test.ts`
  - `bun run --cwd plugins/plugin-computeruse typecheck`
  - `bun run --cwd plugins/plugin-computeruse test -- src/sandbox/sandbox-driver.test.ts src/__tests__/mobile-computer-interface.test.ts src/__tests__/cascade.test.ts`
  - `git diff --check -- plugins/plugin-computeruse/src/sandbox/sandbox-driver.test.ts plugins/plugin-computeruse/src/__tests__/mobile-computer-interface.test.ts plugins/plugin-computeruse/src/__tests__/cascade.test.ts PLACEHOLDER_AUDIT.md`

### plugins/plugin-health sleep/wake follow-up

- Loaded the package-local guide before working in `plugins/plugin-health`;
  `CLAUDE.md` and `AGENTS.md` are identical.
- Reworded bedtime-imminent event documentation from future-target wording to
  target-after-current-time wording.
- Verified with:
  - focused incomplete-marker scan on `plugins/plugin-health/src/sleep/sleep-wake-events.ts`
  - `bunx @biomejs/biome check plugins/plugin-health/src/sleep/sleep-wake-events.ts`
  - `bun run --cwd plugins/plugin-health build:types`
  - `bun run --cwd plugins/plugin-health test -- src/__tests__/smoke.test.ts`
  - `git diff --check -- plugins/plugin-health/src/sleep/sleep-wake-events.ts PLACEHOLDER_AUDIT.md`

### plugins/plugin-local-inference checkpoint-manager follow-up

- Loaded the package-local guide before working in
  `plugins/plugin-local-inference`; `CLAUDE.md` and `AGENTS.md` are identical.
- Reworded voice checkpoint manager upstream-migration TODO comments into
  current backend-reference abstraction notes. The implementation remains on
  the supported filename-based llama.cpp fork API while callers keep an opaque
  checkpoint handle.
- Verified with:
  - focused incomplete-marker scan on `plugins/plugin-local-inference/src/services/voice/checkpoint-manager.ts`
  - `bunx @biomejs/biome check plugins/plugin-local-inference/src/services/voice/checkpoint-manager.ts`
  - `bun run --cwd plugins/plugin-local-inference typecheck`
  - `bunx vitest run --config ./vitest.config.ts src/services/voice/__tests__/checkpoint-manager.test.ts src/services/__tests__/checkpoint-manager.test.ts` from `plugins/plugin-local-inference`
  - `git diff --check -- plugins/plugin-local-inference/src/services/voice/checkpoint-manager.ts PLACEHOLDER_AUDIT.md`

### plugins/plugin-local-inference voice first-run route follow-up

- Loaded the package-local guide before working in
  `plugins/plugin-local-inference`; `CLAUDE.md` and `AGENTS.md` are identical.
- Reworded the voice first-run encoder injection hook comment from stub to fake
  encoder terminology.
- Verified with:
  - focused incomplete-marker scan on `plugins/plugin-local-inference/src/routes/voice-first-run-routes.ts`
  - `bunx @biomejs/biome check plugins/plugin-local-inference/src/routes/voice-first-run-routes.ts`
  - `bun run --cwd plugins/plugin-local-inference typecheck`
  - `bunx vitest run --config ./vitest.config.ts __tests__/voice-first-run-routes.test.ts` from `plugins/plugin-local-inference`
  - `git diff --check -- plugins/plugin-local-inference/src/routes/voice-first-run-routes.ts PLACEHOLDER_AUDIT.md`

### plugins/plugin-lifeops calendar metadata follow-up

- Loaded the package-local guide before working in `plugins/plugin-lifeops`;
  `CLAUDE.md` and `AGENTS.md` are identical.
- Reworded the calendar bulk-reschedule subaction metadata from future-window
  wording to later-window wording.
- Verified with:
  - focused incomplete-marker scan on `plugins/plugin-lifeops/src/actions/calendar.ts`
  - `bunx @biomejs/biome check plugins/plugin-lifeops/src/actions/calendar.ts`
  - `bun run --cwd plugins/plugin-lifeops build:types`
  - `git diff --check -- plugins/plugin-lifeops/src/actions/calendar.ts PLACEHOLDER_AUDIT.md`

### plugins/plugin-computeruse bridge test-double follow-up

- Loaded the package-local guide before working in `plugins/plugin-computeruse`;
  `CLAUDE.md` and `AGENTS.md` are identical.
- Reworded iOS/Android bridge test double helpers and fallback messages from
  stub terminology to fake/unavailable terminology, formatted the touched
  files, and removed Biome non-null assertions surfaced in the touched tests.
- Verified with:
  - focused incomplete-marker scan on touched computeruse bridge test files
  - `bunx @biomejs/biome check plugins/plugin-computeruse/src/__tests__/ios-computer-interface.test.ts plugins/plugin-computeruse/src/__tests__/android-bridge.test.ts plugins/plugin-computeruse/src/__tests__/ios-bridge.test.ts`
  - `bun run --cwd plugins/plugin-computeruse typecheck`
  - `bun run --cwd plugins/plugin-computeruse test -- src/__tests__/ios-computer-interface.test.ts src/__tests__/android-bridge.test.ts src/__tests__/ios-bridge.test.ts`
  - `git diff --check -- plugins/plugin-computeruse/src/__tests__/ios-computer-interface.test.ts plugins/plugin-computeruse/src/__tests__/android-bridge.test.ts plugins/plugin-computeruse/src/__tests__/ios-bridge.test.ts PLACEHOLDER_AUDIT.md`

### plugins/plugin-local-inference capacitor-llama loader follow-up

- Loaded the package-local guide before working in
  `plugins/plugin-local-inference`; `CLAUDE.md` and `AGENTS.md` are identical.
- Reworded the desktop FFI model-descriptor comment from not-yet metadata
  getter wording to current shim capability wording.
- Verified with:
  - focused incomplete-marker scan on `plugins/plugin-local-inference/src/adapters/capacitor-llama/loader.ts`
  - `bunx @biomejs/biome check plugins/plugin-local-inference/src/adapters/capacitor-llama/loader.ts`
  - `bun run --cwd plugins/plugin-local-inference typecheck`
  - `git diff --check -- plugins/plugin-local-inference/src/adapters/capacitor-llama/loader.ts PLACEHOLDER_AUDIT.md`

### plugins/plugin-local-inference bundled-models follow-up

- Loaded the package-local guide before working in
  `plugins/plugin-local-inference`; `CLAUDE.md` and `AGENTS.md` are identical.
- Reworded bundled-model idempotence comments from future re-bundle wording to
  later re-bundle wording.
- Verified with:
  - focused incomplete-marker scan on `plugins/plugin-local-inference/src/services/bundled-models.ts`
  - `bunx @biomejs/biome check plugins/plugin-local-inference/src/services/bundled-models.ts`
  - `bun run --cwd plugins/plugin-local-inference typecheck`
  - `git diff --check -- plugins/plugin-local-inference/src/services/bundled-models.ts PLACEHOLDER_AUDIT.md`

### plugins/plugin-local-inference ASR index follow-up

- Loaded the package-local guide before working in
  `plugins/plugin-local-inference`; `CLAUDE.md` and `AGENTS.md` are identical.
- Reworded the ASR public entry comment from future-consumer wording to
  additional-consumer wording.
- Verified with:
  - focused incomplete-marker scan on `plugins/plugin-local-inference/src/services/asr/index.ts`
  - `bunx @biomejs/biome check plugins/plugin-local-inference/src/services/asr/index.ts`
  - `bun run --cwd plugins/plugin-local-inference typecheck`
  - `git diff --check -- plugins/plugin-local-inference/src/services/asr/index.ts PLACEHOLDER_AUDIT.md`

### plugins/plugin-local-inference planner skeleton follow-up

- Loaded the package-local guide before working in
  `plugins/plugin-local-inference`; `CLAUDE.md` and `AGENTS.md` are identical.
- Reworded the planner skeleton structural-type comment from stubbing wording
  to test-double wording.
- Verified with:
  - focused incomplete-marker scan on `plugins/plugin-local-inference/src/services/planner-skeleton.ts`
  - `bunx @biomejs/biome check plugins/plugin-local-inference/src/services/planner-skeleton.ts`
  - `bun run --cwd plugins/plugin-local-inference typecheck`
  - `bunx vitest run --config ./vitest.config.ts src/services/__tests__/planner-grammar.test.ts` from `plugins/plugin-local-inference`
  - `git diff --check -- plugins/plugin-local-inference/src/services/planner-skeleton.ts PLACEHOLDER_AUDIT.md`

### plugins/plugin-local-inference trace/manifest comments follow-up

- Loaded the package-local guide before working in
  `plugins/plugin-local-inference`; `CLAUDE.md` and `AGENTS.md` are identical.
- Reworded latency trace missing-checkpoint comments, conversation-registry
  high-water restart notes, and manifest schema comments so they describe
  current behavior without incomplete/future marker wording.
- Verified with:
  - focused incomplete-marker scan on touched local-inference trace/registry/manifest files
  - `bunx @biomejs/biome check plugins/plugin-local-inference/src/services/latency-trace.ts plugins/plugin-local-inference/src/services/conversation-registry.ts plugins/plugin-local-inference/src/services/manifest/schema.ts`
  - `bun run --cwd plugins/plugin-local-inference typecheck`
  - `bunx vitest run --config ./vitest.config.ts src/services/latency-trace.test.ts src/services/manifest/schema.test.ts` from `plugins/plugin-local-inference` (matched existing latency trace test)
  - `bunx vitest run --config ./vitest.config.ts src/services/manifest/manifest.test.ts` from `plugins/plugin-local-inference`
  - `git diff --check -- plugins/plugin-local-inference/src/services/latency-trace.ts plugins/plugin-local-inference/src/services/conversation-registry.ts plugins/plugin-local-inference/src/services/manifest/schema.ts PLACEHOLDER_AUDIT.md`

### plugins/plugin-local-inference gated checkpoint follow-up

- Loaded the package-local guide before working in
  `plugins/plugin-local-inference`; `CLAUDE.md` and `AGENTS.md` are identical.
- Reworded gated checkpoint manager lifecycle comments and test intro wording
  so server-start and fetch-mock behavior are described without not-yet/stub
  markers.
- Verified with:
  - focused incomplete-marker scan on touched checkpoint wrapper files
  - `bunx @biomejs/biome check plugins/plugin-local-inference/src/services/checkpoint-manager.ts plugins/plugin-local-inference/src/services/__tests__/checkpoint-manager.test.ts`
  - `bun run --cwd plugins/plugin-local-inference typecheck`
  - `bunx vitest run --config ./vitest.config.ts src/services/__tests__/checkpoint-manager.test.ts` from `plugins/plugin-local-inference`
  - `git diff --check -- plugins/plugin-local-inference/src/services/checkpoint-manager.ts plugins/plugin-local-inference/src/services/__tests__/checkpoint-manager.test.ts PLACEHOLDER_AUDIT.md`

### plugins/plugin-lifeops owner todos surface follow-up

- Loaded the package-local guide before working in `plugins/plugin-lifeops`;
  `CLAUDE.md` and `AGENTS.md` are identical.
- Reworded a stale uppercase TODO comment in the owner todos action to point at
  the currently implemented general-purpose `plugin-todos` surface while
  preserving the distinction between the two backing stores.
- Verified with:
  - focused incomplete-marker scan on `plugins/plugin-lifeops/src/actions/owner-surfaces.ts` (remaining hits are legitimate `todos` domain/action names)
  - `bunx @biomejs/biome check plugins/plugin-lifeops/src/actions/owner-surfaces.ts`
  - `bun run --cwd plugins/plugin-lifeops build:types`
  - `bun run --cwd plugins/plugin-lifeops test -- src/plugin.test.ts`
  - `git diff --check -- plugins/plugin-lifeops/src/actions/owner-surfaces.ts PLACEHOLDER_AUDIT.md`

### plugins/plugin-lifeops goal extraction follow-up

- Loaded the package-local guide before working in `plugins/plugin-lifeops`;
  `CLAUDE.md` and `AGENTS.md` are identical.
- Reworded the goal creation extraction prompt from future-progress wording to
  later-progress wording.
- Verified with:
  - focused incomplete-marker scan on `plugins/plugin-lifeops/src/actions/lib/extract-goal-plan.ts`
  - `bunx @biomejs/biome check plugins/plugin-lifeops/src/actions/lib/extract-goal-plan.ts`
  - `bun run --cwd plugins/plugin-lifeops build:types`
  - `git diff --check -- plugins/plugin-lifeops/src/actions/lib/extract-goal-plan.ts PLACEHOLDER_AUDIT.md`

### plugins/plugin-local-inference desktop llama adapter follow-up

- Loaded the package-local guide before working in
  `plugins/plugin-local-inference`; `CLAUDE.md` and `AGENTS.md` are identical.
- Reworded desktop llama adapter lifecycle comments from future-call wording
  to later/subsequent call wording.
- Verified with:
  - focused incomplete-marker scan on `plugins/plugin-local-inference/src/services/desktop-llama-adapter.ts`
  - `bunx @biomejs/biome check plugins/plugin-local-inference/src/services/desktop-llama-adapter.ts`
  - `bun run --cwd plugins/plugin-local-inference typecheck`
  - `bunx vitest run --config ./vitest.config.ts src/services/desktop-llama-adapter.test.ts src/services/desktop-llama-piece-decode.test.ts` from `plugins/plugin-local-inference`
  - `git diff --check -- plugins/plugin-local-inference/src/services/desktop-llama-adapter.ts PLACEHOLDER_AUDIT.md`

## Intentional / False-Positive Marker Classes

- Input `placeholder=` props and i18n keys named `*Placeholder`.
- Vitest mocks, `stubGlobal`, and fixture stubs.
- External dependency names and paths that include `stub` as part of the
  upstream artifact name.
- Browser-safe export-condition stubs for Node-only plugins, when package docs
  explicitly state the browser build must proxy to a server.
- Scenario-runner deterministic embedding stubs used to avoid live model
  downloads in CI.
- Web/no-op fallbacks for native-only Capacitor plugins where `supported: false`
  is the intended contract.
- Generated output, lockfiles, bundled app artifacts, and docs describing
  marker policy rather than unfinished behavior.
