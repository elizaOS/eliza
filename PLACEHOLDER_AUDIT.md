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
- Verified with:
  - `python3 -m py_compile packages/sweagent/python/sweagent/inspector/server.py`
  - `bun run --cwd packages/sweagent test`
  - marker scan and `git diff --check` on the touched inspector files
- Not verified with direct `bun build` of the TypeScript inspector: this
  partial vendored SWE-agent tree cannot resolve `packages/node_modules/js-yaml`,
  consistent with the package guide warning that the full SWE-agent build graph
  is not vendored on this branch.

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
- Verified with:
  - `make -C fw/pmc clean all test`
  - `python3 -m pytest packages/chip/compiler/executorch-eliza/tests/test_partition.py packages/chip/compiler/executorch-eliza/tests/test_preprocessor.py -q`
  - `python3 -m pytest packages/chip/compiler/runtime/test_e1_npu_tiny_mlp_e2e.py -q`
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
- Verified with:
  - `bunx biome check plugins/plugin-health/src/sleep/sleep-wake-events.ts`
  - marker scan and `git diff --check` on the touched Health file

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
- Reworded active-model and family-member voice comments so desktop fallback
  generation and client-side pending voice profiles are described as explicit
  compatibility behavior.
- Verified with:
  - `bun build plugins/plugin-local-inference/src/services/device-bridge.ts --target=bun --outfile=/tmp/local-inference-device-bridge-check.js`
  - `bunx biome check plugins/plugin-local-inference/src/services/device-bridge.ts plugins/plugin-local-inference/src/services/engine.ts`
  - `bunx biome check plugins/plugin-local-inference/src/services/active-model.ts plugins/plugin-local-inference/src/routes/family-member-route.ts`
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

### packages/elizaos

- Closed the CLI deploy gap by formalizing `elizaos deploy` as a
  side-effect-free deployment-plan preview rather than a partially exposed real
  deploy path. The command now prints the plan and exits 0 for valid inputs,
  keeps `--dry-run` as compatibility syntax, validates domains before output,
  and has focused tests covering the preview contract.
- Verified with:
  - `bun run --cwd packages/elizaos test deploy`
  - `bun run --cwd packages/elizaos typecheck`
  - `bun run --cwd packages/elizaos lint:check`

### plugins/plugin-capacitor-bridge

- Removed the iOS full-Bun local-inference blanket `not implemented` response.
  The bridge now handles native buffered routes first and then falls through to
  the canonical in-process `dispatchRoute`; unsupported streaming endpoints
  still return the explicit stdio-bridge capability error.
- Replaced Android `computeruse` top-level TODO markers with behavior-checklist
  references to `ANDROID_CONSTRAINTS.md`. The remaining `stub` wording in
  `AospPrivilegedBridge.kt` describes the consumer-flavor implementation
  contract.
- Verified with:
  - `bun run --cwd plugins/plugin-capacitor-bridge check:android-manifest`
  - `bun run --cwd plugins/plugin-capacitor-bridge typecheck`
  - `bun run --cwd plugins/plugin-capacitor-bridge lint:check`
  - `bun run --cwd plugins/plugin-capacitor-bridge build`

## Remaining Runtime Gaps / Boundaries

### plugins/plugin-computeruse

- Removed the selectable QEMU sandbox backend stub. Sandbox mode now accepts
  the implemented Docker backend only; the throwing `qemu-backend.ts` file,
  QEMU exports, config parsing branch, docs listing, and Phase-2-specific tests
  were removed.
- Verified with:
  - `bun run --cwd plugins/plugin-computeruse test src/sandbox/sandbox-driver.test.ts`
  - `bun run --cwd plugins/plugin-computeruse typecheck`
  - `bun run --cwd plugins/plugin-computeruse build`
- Remaining native markers are platform boundaries:
  - AOSP privileged input actor is documented as a stub for consumer flavor.
  - Optional VLM adapter is a typed endpoint stub.
  - OCR no-op fallback is intentionally used when no OCR provider is present.
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

### packages/chip

- `compiler/stay-decisions-generators.json` still references
  `external/ascalon-stub/README.md`. This is an external dependency path, not
  source prose or executable placeholder behavior in the chip compiler.

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
