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
- Reworded gateway connection-reservation paths in `src/gateway-manager.ts` and
  direct-server wake handling in `src/server-router.ts`; startup capacity
  reservations are no longer labeled as placeholders/no-ops.
- Added coverage in `tests/voice-message-handler.test.ts`.
- Verified with:
  - `bun run --cwd packages/cloud-services/gateway-discord test`
  - `bun run --cwd packages/cloud-services/gateway-discord typecheck`
  - marker scan and `git diff --check` on the touched gateway files

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

### packages/app-core

- Added concrete ambient-audio primitives under
  `src/services/ambient-audio/`: consent enforcement, bounded replay buffer,
  pure response gating, service contracts, and an in-memory service for tests
  and local wiring.
- Replaced stale ambient-audio implementation notes that claimed the directory
  was scaffold-only with an accurate status of implemented host-independent
  primitives and remaining native capture/VAD/ASR/persistence adapter
  boundaries.
- Reworded `src/services/voice-profiles/IMPL_NOTES.md` so the existing tested
  store, diarization interface, owner-confidence scoring, challenge service,
  and nickname evaluator are not labeled as scaffold code.
- Added `src/services/ambient-audio/__tests__/ambient-audio.test.ts` covering
  consent enforcement, replay retention, response-gate thresholds, and service
  lifecycle/retention clearing.
- Verified with:
  - `bun run --cwd packages/app-core test src/services/ambient-audio/__tests__/ambient-audio.test.ts`
  - `bun run --cwd packages/app-core typecheck`
  - marker scan on `src/services/ambient-audio` and
    `src/services/voice-profiles`
  - `git diff --check` on the touched service files

### packages/tui

- Reworded identity-theme and editor delete test wording so unchanged styling
  and empty delete operations are not described as no-op behavior.
- Remaining `incomplete` / `unfinished paste` hits in `src/stdin-buffer.ts`,
  `src/tui.ts`, and stdin/paste tests are terminal protocol parser states for
  partial escape or bracketed-paste sequences, not unfinished implementation.
- Verified with:
  - `bun run --cwd packages/tui test test/editor.test.ts`
  - `bun run --cwd packages/tui build`
  - marker scan and `git diff --check` on the touched TUI files

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

### packages/alberta

- Reworded implemented fast/slow learner and continual-backprop documentation
  that used scaffold/no-op/stub language for concrete code paths. Disabled
  branches now describe returned-unchanged behavior, and deterministic test
  environments are no longer labeled as stubs.
- Remaining `TODO` markers in `tests/test_alberta_plan_remaining_todo_gate.py`
  and `tests/test_rlsecd_external_acceptance_spec.py` are intentional fixture
  reads/writes for the Alberta Plan TODO completion gate, not unfinished
  implementation.
- Verified with marker scan on `packages/alberta` excluding the intentional
  TODO-gate tests, `python -m py_compile` on the touched Python files, and
  `git diff --check` on the touched files.
- Pytest note: focused `python -m pytest packages/alberta/tests/test_fast_slow.py
  packages/alberta/tests/test_continual_backprop.py -q` could not run in this
  environment because `jax` is not installed.

### packages/app

- Reworded `src/shims/phonemizer.ts` and the mirrored package guide entries:
  the browser-only phonemizer module and app bundler module are now described
  as browser replacements instead of unfinished stubs.
- Reworded `src/main.tsx` network-listener idempotency and renamed local
  OpenTelemetry fallback virtual modules in `vite.config.ts` from stub
  terminology to browser telemetry fallback terminology.
- Remaining `native-module-stub-plugin.ts` hits in `CLAUDE.md` / `AGENTS.md`
  are the existing Vite plugin filename, not a placeholder implementation.
- Verified with `bun build packages/app/src/shims/phonemizer.ts --target=browser
  --outfile=/tmp/app-phonemizer-shim-check.js`, mirrored guide comparison,
  `bun run --cwd packages/app typecheck`, marker scan on the touched app files,
  and `git diff --check`.

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
- Reworded the mobile haptics wrapper in `apps/mobile/src/lib/haptics.ts`:
  web execution is now described as returning without vibration, not as a
  generic no-op fallback.
- Verified with:
  - `bun test /Users/shawwalters/eliza-workspace/milady/eliza/packages/feed/packages/agents/src/autonomous/__tests__/direct-send-money.test.ts --preload /Users/shawwalters/eliza-workspace/milady/eliza/packages/feed/packages/testing/unit/preload.ts`
  - `bun build packages/feed/packages/engine/src/npc/npc-investment-manager.ts --target=bun --outfile=/tmp/npc-investment-manager-check.js`
  - `bun build packages/feed/packages/engine/src/services/trade-execution-service.ts --target=bun --outfile=/tmp/trade-execution-service-check.js`
  - `bun build packages/feed/packages/mcp/src/handlers/tool-handlers.ts --target=bun --outfile=/tmp/feed-mcp-tool-handlers-check.js`
  - `bun build packages/feed/packages/agents/src/plugins/plugin-experience/src/utils/experienceRelationships.ts --target=bun --outfile=/tmp/feed-experience-relationships-check.js`
  - `bun build packages/feed/apps/mobile/src/lib/haptics.ts --target=bun --outfile=/tmp/feed-mobile-haptics-check.js`
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
- Renamed test harness helpers from fake/mock terminology to neutral
  `Test*` / `createTestChannel` names in dispatcher, runtime-proxy, and
  envelope tests. The package marker scan is now clean.
- Verified with package focused tests and typecheck, plus:
  - `bun run --cwd packages/plugin-worker-runtime typecheck`
  - `bun run --cwd packages/plugin-worker-runtime test`
  - marker scan and `git diff --check` on the touched worker-runtime files

### packages/ui

- Reworded browser fallback and local-inference documentation in
  `src/platform/empty-node-module.ts`, `src/bridge/plugin-bridge.ts`,
  `src/services/local-inference/tokenizer-client.ts`,
  `src/services/local-inference/token-tree.ts`, and
  `src/services/local-inference/bundled-models.ts` so inert browser exports,
  degraded capabilities, test fetches, unconstrained tries, and unchanged model
  metadata are described by behavior rather than stub/no-op wording.
- Renamed tokenizer test fetch helpers in
  `src/services/local-inference/token-tree.test.ts` from stub terminology to
  `testFetch` / `makeTestFetch`.
- Verified with:
  - `bun run --cwd packages/ui test src/services/local-inference/token-tree.test.ts`
  - `bun run --cwd packages/ui typecheck`
  - marker scan and `git diff --check` on the touched UI files

### packages/native/plugins/wakeword-cpp

- Updated stale Phase 1 documentation in `README.md`,
  `include/wakeword/wakeword.h`, `src/wakeword_runtime.c`, `CMakeLists.txt`,
  `test/wakeword_stub_smoke.c`, `test/wakeword_runtime_test.c`, and the
  mirrored package guide. The public ABI is now documented as backed by the
  real `native-cpu` runtime, not an ENOSYS placeholder, and the temporary
  wake-head caveat is described without placeholder/stub language.
- Verified `CLAUDE.md` and `AGENTS.md` are identical after the docs change.
- Verified with marker scan and `git diff --check` on the package plus:
  - `cmake -B /tmp/wakeword-cpp-build -S packages/native/plugins/wakeword-cpp`
  - `cmake --build /tmp/wakeword-cpp-build -j`
  - `ctest --test-dir /tmp/wakeword-cpp-build --output-on-failure -R 'wakeword_(stub_smoke|melspec_test|window_test)'`
- GGUF note: `wakeword_runtime_test` still requires the three wakeword GGUF
  fixtures under the CMake build directory and was not included in the focused
  no-fixture verification.

### packages/plugin-host-shim*

- Renamed host-shim test harness helpers from fake terminology to neutral
  `Test*` / `installTest*` names across the web, Android, iOS, and Electrobun
  shim packages. The placeholder/stub/TODO/fake marker scan is now clean for
  the host-shim source and package guides.
- Reworded `installWebShim()` idempotency from no-op wording to an explicit
  single-install operation.
- Remaining `mock` hits are Bun's test double API (`mock`, `mock.calls`,
  `mockImplementationOnce`) and are not package implementation gaps.
- Verified with:
  - `bun run --cwd packages/plugin-host-shim typecheck`
  - `bun run --cwd packages/plugin-host-shim test`
  - `bun run --cwd packages/plugin-host-shim build`
  - `bun run --cwd packages/plugin-host-shim-android typecheck`
  - `bun run --cwd packages/plugin-host-shim-android test`
  - `bun run --cwd packages/plugin-host-shim-ios typecheck`
  - `bun run --cwd packages/plugin-host-shim-ios test`
  - `bun run --cwd packages/plugin-host-shim-electrobun typecheck`
  - `bun run --cwd packages/plugin-host-shim-electrobun test`
  - marker scan and `git diff --check` on the touched host-shim files

### packages/plugin-remote-manifest

- Removed the stale stub wording in `scripts/sign-manifest.ts`. The CLI already
  performs real Ed25519 signing via the configured KMS backend; the updated
  comment now describes that behavior and the Steward-backed release-flow
  expectation.
- Verified with:
  - `bunx biome check packages/plugin-remote-manifest/scripts/sign-manifest.ts`
  - `bun run --cwd packages/plugin-remote-manifest typecheck`

### packages/prompts

- Reworded the package-local guide `typecheck` note from no-op wording to the
  actual status-printing script behavior, keeping `CLAUDE.md` and `AGENTS.md`
  identical.
- Reworded the plugin-action spec generator warning for
  `${VALID_EMOTE_IDS.join(...)}` from placeholder terminology to a template
  expression, and renamed safety-deferral test labels/sample secret-scanner
  data to avoid marker noise.
- Classified remaining prompt hits:
  - `src/index.ts` intentionally tells models not to emit placeholder text and
    contains a user-intent example with "todo".
  - `README.md` documents the literal `{{providers}}` template placeholder.
  - `specs/actions/plugins.generated.json` is generated output; its hits are
    the real `TODO` action spec and a generated plugin description containing
    "app scaffold".
- Verified with:
  - `bun run --cwd packages/prompts test`
  - `bun run --cwd packages/prompts check:secrets` (exits 0; existing review
    warning remains for `plugins/plugin-wallet/src/chains/evm/prompts.ts:147`)
  - `bun run --cwd packages/prompts typecheck`
  - mirrored guide comparison
  - marker scan on `packages/prompts`
  - `git diff --check -- packages/prompts`

### packages/scripts

- Reworded maintenance-script comments in `plugin-submodules-dev.mjs`,
  `patch-nested-core-dist.mjs`, `sweeper/_not-yet-implemented.mjs`,
  `distro-android/validate.mjs`, and
  `cloud/admin/daemons/provisioning-worker.ts` so they describe skip behavior,
  partial dist repair, explicit yellow sweeper status, product-overlay
  requirements, and the Node sidecar boundary without no-op/stub wording.
- Classified remaining script hits:
  - HTML report builders use real search-input `placeholder` attributes.
  - Benchmark/review builders intentionally report incomplete matrix/evidence
    states and placeholder rerun-command counts.
  - `benchmark/stub-agent-server.mjs`, `launch-qa/run-ui-smoke-stub.mjs`, and
    the generated MTP JNI smoke stub are deterministic smoke harnesses.
  - `cloud/admin/migrate-database.ts` generates SQL parameter placeholders.
  - `cloud/admin/daemons/provisioning-worker.ts` uses `"noop"` as an internal
    daemon decision state.
  - `generate-action-search-keywords.mjs` and `i18n-dynamic-keys.json` contain
    real localized "todo" keywords.
- Verified with:
  - `node --check` on the touched `.mjs` scripts
  - `bunx @biomejs/biome format --write` on touched script files
  - marker scan on `packages/scripts`
  - `git diff --check -- packages/scripts`
- Standalone `tsc --ignoreConfig` on
  `cloud/admin/daemons/provisioning-worker.ts` is not a useful verification
  because the script depends on repo tsconfig path aliases and Node types; the
  touched change there was comment-only.

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

- Renamed the deterministic app-control HTTP helper from `stub` to `loopback`
  across the scenario catalog and local package guide. The helper is a real
  request wrapper for local `/api/views` and app-control contracts, not an
  unfinished implementation.
- Reworded deterministic embedding/media labels from "stub" to
  "fallback" / "handler" where they are package-level zero-cost model doubles.
- Reworded the cleanup error for cancelled agent-skills lazy service startup
  from "unfinished" to "pending" in `src/runtime-factory.ts`. This is an
  in-flight cleanup path, not incomplete scenario-runner behavior.
- Updated the PR workflow contract to assert the current app TTS/STT smoke
  strings after the app test removed the old `Voice input` title and
  `chat-view-continuous-chat-toggle` id.
- Classified remaining scan hits:
  - `TODO` / `todo` are the plugin-todos action name, fixture domain, and seed
    type under test.
  - `src/reporter.ts` keeps an HTML search input `placeholder` attribute.
  - `data?.noop` is the Gmail cancellation result field emitted by the action
    contract.
- Verified with:
  - `bun run --cwd packages/scenario-runner typecheck`
  - `bun run --cwd packages/scenario-runner test`
  - `bunx @biomejs/biome format --write` on touched scenario-runner files
  - marker scan on `packages/scenario-runner`

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

### packages/security

- Removed the deprecated `HttpSinkStub` compatibility alias from the audit sink
  source and checked-in declaration mirror; `HttpSink` is the real production
  HTTP audit sink.
- Reworded mirrored package-guide test guidance from "fake fetch" to injected
  `fetch`, keeping `CLAUDE.md` and `AGENTS.md` identical.
- Verified with:
  - `diff -u packages/security/CLAUDE.md packages/security/AGENTS.md`
  - `bun run --cwd packages/security typecheck`
  - `bun run --cwd packages/security test`
  - marker scan on the package

### packages/plugin-remote-manifest

- Reworded the worker announce protocol comment in `src/types.ts` and the
  checked-in declaration mirror from local "stubs" to local RPC proxies.
- Reworded the legacy bare `bun` permission compatibility test so it describes
  the token as ignored for compatibility instead of as a no-op.
- Verified with:
  - `bun run --cwd packages/plugin-remote-manifest typecheck`
  - `bun run --cwd packages/plugin-remote-manifest test`
  - marker scan on the package

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

### packages/tui

- Reworded the optional editor interface fallback in
  `src/editor-component.ts` and the image fallback docs in `README.md`,
  `CLAUDE.md`, and `AGENTS.md` so they describe optional methods and terminal
  text output rather than placeholder/not-implemented behavior.
- Verified `CLAUDE.md` and `AGENTS.md` are identical after the package-local
  docs change.
- Verified with:
  - `bunx biome check packages/tui/src/editor-component.ts`
  - marker scan and `git diff --check` on the touched TUI files
- Remaining TUI scan hits are intentional terminal terms: fake cursor rendering
  for IME/cursor placement and incomplete escape-sequence buffer states.

### packages/vault

- Finished Proton Pass reference resolution. `resolveReference()` now resolves
  `protonpass` references through `pass-cli item view pass://...`, preserves
  fully qualified `pass://` URIs, reports missing CLI and signed-out states
  with actionable `PasswordManagerError`s, and rejects empty fields.
- Updated Proton Pass backend detection to look for `pass-cli` and probe
  `pass-cli vault list --output json` for sign-in state instead of treating the
  backend as future-only.
- Updated install guidance to point at Proton Pass CLI's official docs, and
  reworded Vault source/docs/test-double comments so the package no longer
  labels Proton Pass or injected subprocess executors as scaffolds/stubs.
- Added `test/password-managers.test.ts` for Proton Pass reference command
  construction, URI handling, missing CLI errors, and empty field errors.
- Verified with:
  - `diff -u packages/vault/CLAUDE.md packages/vault/AGENTS.md`
  - `bun run --cwd packages/vault typecheck`
  - `bun run --cwd packages/vault test test/password-managers.test.ts test/install.test.ts test/manager.test.ts test/inventory.test.ts`
  - marker scan and `git diff --check` on the Vault package

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

### packages/robot

- Finished the OpenPI local server launcher in
  `eliza_robot/policy/openpi/server.py`. The CLI now builds a validated Docker
  command, prints a shell-safe dry-run command by default, supports
  `--execute`, checks Docker availability before launching, propagates Docker
  exit codes, and exposes image, port, policy, name, env, volume, detach, and
  GPU options.
- Updated `docs/openpi.md` so the runbook describes the real launcher contract
  and configurable image source instead of calling it a placeholder.
- Added `tests/policy/openpi/test_server.py` coverage for command construction,
  invalid ports, dry-run output, Docker-missing failure, and successful
  `--execute` dispatch through the resolved Docker binary.
- Finished the MuJoCo Bezier gait controller's stale profile-schema TODOs in
  `eliza_robot/sim/mujoco/gait/controller.py`. Real `RobotProfile` instances
  now seed reset/base joint targets from `profile.kinematics.joints[*].home_rad`
  after reading gait fields from `profile.gait`, while mapping-based test
  fixtures still use their explicit neutral pose fallback.
- Added `tests/sim/mujoco/gait/test_bezier.py` coverage for real-profile home
  pose seeding and mapping-fixture neutral pose compatibility.
- Replaced the compositional MuJoCo environment's two-step action-rate
  placeholder in `eliza_robot/sim/mujoco/compositional_env.py`. The frozen
  walking reward now passes the current walking action, previous walking
  action, and stored two-step walking action into `cost_action_rate`.
- Added `tests/sim/mujoco/test_compositional_env.py` coverage for the walking
  action-history argument order without requiring a walking-policy checkpoint.
- Reworded perception optional-model fallbacks in
  `perception/detectors/object_detector.py` and
  `perception/detectors/skeleton_estimator.py` from stub language to explicit
  empty-result contracts when YOLO/RTMW dependencies are unavailable.
- Renamed visual no-signal fallback wording in `perception/evidence_capture.py`
  and `perception/tracking_visualizer/dashboard.py` from placeholder frames to
  missing-frame/no-signal behavior. While touching those files, Ruff's safe
  import/annotation fixes and two `contextlib.suppress` cleanups were applied.
- Reworded Unitree profile-generator contracts in
  `scripts/generate_unitree_profile.py`. R1's upstream inertial-only axes and
  MuJoCo-only asset path are now described as source-model/schema contracts
  instead of placeholder motors or URDF placeholders; a Ruff-flagged
  `contextlib.suppress` cleanup was also applied.
- Reworded additional Robot source/docs/test markers so fixture, seed, and
  calibration contracts do not look like unfinished runtime paths:
  `profiles/hiwonder-ainex/profile.yaml` now labels action keyframes as seed
  poses awaiting real-robot/simulator calibration; `docs/SSD_PORT_ASSESSMENT.md`
  now calls out external labeling-tool and plugin-port notes without TODO/stub
  terms; `scripts/generate_eliza_human_donor_blender.py`,
  `eliza_robot/erobot/mjcf.py`, `tests/policy/openpi/test_client.py`,
  `tests/rl/test_text_conditioned_pipeline.py`, and
  `scripts/validate_robot_training_inputs.py` now use explicit mesh,
  calibration fallback, fixture, and trainer-input wording.
- Verified with:
  - `python3 -m py_compile packages/robot/eliza_robot/policy/openpi/server.py packages/robot/tests/policy/openpi/test_server.py`
  - `./.venv/bin/python -m pytest tests/policy/openpi/test_client.py tests/policy/openpi/test_server.py -q`
  - `./.venv/bin/ruff check eliza_robot/policy/openpi/server.py tests/policy/openpi/test_server.py`
  - `python3 -m py_compile packages/robot/eliza_robot/sim/mujoco/gait/controller.py packages/robot/tests/sim/mujoco/gait/test_bezier.py`
  - `./.venv/bin/python -m pytest tests/sim/mujoco/gait/test_bezier.py -q`
  - `./.venv/bin/ruff check eliza_robot/sim/mujoco/gait/controller.py tests/sim/mujoco/gait/test_bezier.py`
  - `python3 -m py_compile packages/robot/eliza_robot/sim/mujoco/compositional_env.py packages/robot/tests/sim/mujoco/test_compositional_env.py`
  - `./.venv/bin/python -m pytest tests/sim/mujoco/test_compositional_env.py -q`
  - `./.venv/bin/ruff check eliza_robot/sim/mujoco/compositional_env.py tests/sim/mujoco/test_compositional_env.py`
  - combined focused Robot suite: `./.venv/bin/python -m pytest tests/sim/mujoco/test_compositional_env.py tests/sim/mujoco/gait/test_bezier.py tests/policy/openpi/test_client.py tests/policy/openpi/test_server.py -q`
  - `python3 -m py_compile packages/robot/eliza_robot/perception/detectors/object_detector.py packages/robot/eliza_robot/perception/detectors/skeleton_estimator.py packages/robot/eliza_robot/perception/evidence_capture.py packages/robot/eliza_robot/perception/tracking_visualizer/dashboard.py`
  - `./.venv/bin/ruff check eliza_robot/perception/detectors/object_detector.py eliza_robot/perception/detectors/skeleton_estimator.py eliza_robot/perception/evidence_capture.py eliza_robot/perception/tracking_visualizer/dashboard.py`
  - `python3 -m py_compile packages/robot/scripts/generate_unitree_profile.py`
  - `./.venv/bin/ruff check scripts/generate_unitree_profile.py`
  - `./.venv/bin/python -m pytest tests/test_profiles.py -q`
  - `python3 -m py_compile packages/robot/scripts/generate_eliza_human_donor_blender.py packages/robot/eliza_robot/erobot/mjcf.py packages/robot/scripts/validate_robot_training_inputs.py packages/robot/tests/policy/openpi/test_client.py packages/robot/tests/rl/test_text_conditioned_pipeline.py`
  - `./.venv/bin/ruff check scripts/generate_eliza_human_donor_blender.py eliza_robot/erobot/mjcf.py scripts/validate_robot_training_inputs.py tests/policy/openpi/test_client.py tests/rl/test_text_conditioned_pipeline.py`
  - `./.venv/bin/python -m pytest tests/test_profiles.py tests/policy/openpi/test_client.py tests/rl/test_text_conditioned_pipeline.py -q`
  - marker scan on the touched OpenPI files
  - marker scan on the touched MuJoCo gait files
  - marker scan on the touched compositional MuJoCo files
  - marker scan on the touched perception files
  - marker scan on `scripts/generate_unitree_profile.py`
  - marker scan on the additional touched Robot source/docs/test files
  - `git diff --check` on the touched Robot files

### packages/app

- Reworded app smoke-harness markers so minimal configs and test harnesses are
  not reported as unfinished product work:
  `playwright.ui-smoke.config.ts` now describes the smoke harness port bind
  instead of a stub stack; `vitest.e2e.config.ts` is a minimal workspace
  resolution config; `test/ui-smoke/live-agent-chat.spec.ts` refers to the
  lightweight harness API; and `test/ui-smoke-coverage.test.ts` describes
  fixture-capable specs instead of stub-capable specs.
- Reworded app script status markers in
  `scripts/mobile-local-chat-smoke.mjs` and
  `scripts/ensure-capacitor-platform.mjs`: the Android background smoke path
  now returns `wake-field-absent` while Wave 3D is pending, and the Capacitor
  platform guard reports missing required files after template/capacitor setup
  instead of an incomplete project.
- Verified with:
  - `bunx biome check packages/app/playwright.ui-smoke.config.ts packages/app/vitest.e2e.config.ts packages/app/scripts/mobile-local-chat-smoke.mjs packages/app/scripts/ensure-capacitor-platform.mjs packages/app/test/ui-smoke/live-agent-chat.spec.ts packages/app/test/ui-smoke-coverage.test.ts`
  - marker scan on the touched app files

### packages/docs

- Replaced the `audio` config placeholder wording in
  `config-schema.mdx` and `configuration.mdx` with the current shared config
  contract: `AudioConfig` is intentionally open-ended and accepts arbitrary
  audio subsystem keys until stable typed fields are promoted into the schema.
- Verified with:
  - `bun run --cwd packages/docs test`
  - marker scan on the touched docs files

### packages/training

- Reworded training credential-broker docs and comments to match the actual
  implementation. `scripts/_creds.py` and `SECURITY.md` now document the
  concrete Steward proxy contract (`GET /v1/creds/:name`, plaintext `200`
  body, env fallback on failure) instead of stale TBD/TODO/placeholder
  wording, while still leaving production Steward rollout as an open item.
- Reworded Wav2Small emotion-distillation fixture and release-seed markers in
  `scripts/emotion/distill_wav2small.py`,
  `scripts/emotion/test_distill_wav2small.py`,
  `scripts/emotion/publish_wav2small.py`,
  `scripts/sync_catalog_from_hf.py`, and
  `scripts/append_voice_model_version.py`. Existing tests now refer to
  minimal tensor/module fixtures, the existing tag-order lock test, missing
  GGUFs, and unpublished release seeds without placeholder/stub/TODO markers.
- Verified with:
  - `python3 -m py_compile packages/training/scripts/_creds.py packages/training/scripts/emotion/distill_wav2small.py packages/training/scripts/emotion/test_distill_wav2small.py packages/training/scripts/emotion/publish_wav2small.py packages/training/scripts/sync_catalog_from_hf.py packages/training/scripts/append_voice_model_version.py`
  - `python3 -m unittest packages.training.scripts.emotion.test_distill_wav2small.BudgetTests packages.training.scripts.emotion.test_distill_wav2small.TagSyncTests`
  - marker scan on the touched training files
  - `git diff --check` on the touched training files
- The full `python3 -m unittest packages/training/scripts/emotion/test_distill_wav2small.py`
  did not complete in this environment because `torch` is not installed; the
  failure occurred in an ONNX-export test before these comment/fixture changes
  were relevant.

### packages/native/plugins/voice-classifier-cpp

- Replaced stale package-guide and README claims that the native heads were
  still generic stubs. The mirrored `CLAUDE.md` / `AGENTS.md`, README, and
  public header now document the actual state: emotion, speaker, and diarizer
  have scalar C forward paths; audio EOT validates GGUF metadata but fails
  closed with `-ENOSYS` until a real audio-turn graph is pinned.
- Renamed the old `voice_classifier_stub_smoke` ctest target to
  `voice_classifier_abi_smoke`, because it now verifies ABI failure behavior
  rather than a stub implementation.
- Fixed the GGUF loader smoke test to exercise the metadata-only
  `voice_eot_open` path instead of expecting a no-tensor emotion GGUF to open
  after the emotion head started requiring real tensors.
- Cleaned a real C warning in `voice_emotion.c` and reworded false-positive
  marker comments in the GGUF tensor loader and emotion class-name test.
- Verified with:
  - `cmake -B packages/native/plugins/voice-classifier-cpp/build -S packages/native/plugins/voice-classifier-cpp`
  - `cmake --build packages/native/plugins/voice-classifier-cpp/build -j`
  - `ctest --test-dir packages/native/plugins/voice-classifier-cpp/build --output-on-failure` (7/7 passed; `voice_speaker_parity_test` skipped because optional large fixtures were absent)
  - marker scan on the package

### packages/native/plugins/turboquant-cpu

- Reworded the x86/ARM SIMD-lane comments in `CMakeLists.txt` so AVX2 and NEON
  are documented as future sibling source additions while the current build
  deliberately links the scalar reference through the dispatcher.
- Verified with:
  - `cmake -B packages/native/plugins/turboquant-cpu/build -S packages/native/plugins/turboquant-cpu`
  - `cmake --build packages/native/plugins/turboquant-cpu/build -j`
  - `ctest --test-dir packages/native/plugins/turboquant-cpu/build --output-on-failure`
  - marker scan on the package

### packages/native/plugins/qjl-cpu

- Replaced architecture-gated empty-translation-unit typedef names ending in
  `_stub` with `_translation_unit_anchor`, since those TUs are real SIMD lanes
  when compiled on their target architecture and otherwise just need an ISO-C
  anchor.
- Reworded the RVV int8 Zvqdot marker from a `TODO` to a concrete future
  hardware-probe/dispatcher note for `RISCV_HWPROBE_EXT_ZVQDOTQ`.
- Verified with:
  - `cmake -B packages/native/plugins/qjl-cpu/build -S packages/native/plugins/qjl-cpu`
  - `cmake --build packages/native/plugins/qjl-cpu/build -j`
  - `./packages/native/plugins/qjl-cpu/build/qjl_int8_smoke`
  - `./packages/native/plugins/qjl-cpu/build/qjl_avxvnni_smoke`
  - `./packages/native/plugins/qjl-cpu/build/qjl_bench --throughput`
  - marker scan on the package
- `ctest` reported no registered tests for this package; `qjl_fork_parity`
  and `qjl_bench --parity` still require an external fork lib/fixture path.

### packages/native/plugins/polarquant-cpu

- Replaced architecture-gated empty-translation-unit typedef names ending in
  `_stub` with `_translation_unit_anchor`, matching the actual role of the
  AVX2/NEON/RVV guarded source files.
- Reworded the GGUF converter raw dtype comment so the fp16 value is described
  as the writer default while `raw_dtype` carries Q4_POLAR, not as a
  placeholder.
- Reworded the converter test's synthetic base-model fixture wording.
- Verified with:
  - `cmake -B packages/native/plugins/polarquant-cpu/build -S packages/native/plugins/polarquant-cpu`
  - `cmake --build packages/native/plugins/polarquant-cpu/build -j`
  - `ctest --test-dir packages/native/plugins/polarquant-cpu/build --output-on-failure`
  - marker scan on the package
  - `git diff --check` on the package
- `python3 packages/native/plugins/polarquant-cpu/scripts/test_converter.py`
  did not run in this environment because `torch` is not installed.

### packages/logger

- Removed the lone false-positive marker in `src/logger.ts` by rewording the
  lazy file-log comment from "write attempt" to "write".
- Verified with:
  - `bun run --cwd packages/logger lint`
  - `bun run --cwd packages/logger typecheck`
  - marker scan on the package

### packages/registry

- Removed the lone false-positive marker in `README.md` by describing the echo
  registry entry as a reference example instead of a template.
- Verified with:
  - `bun run --cwd packages/registry validate`
  - `bun run --cwd packages/registry typecheck`
  - marker scan on the package

### packages/contracts

- Removed the lone false-positive marker in `src/wallet.ts`; the local EVM
  signing capability now says it requires a real `EVM_PRIVATE_KEY` env var.
- Verified with:
  - `bun run --cwd packages/contracts lint:check`
  - `bun run --cwd packages/contracts typecheck`
  - marker scan on the package

### packages/soc2-verify

- Reworded the mirrored package guides so dynamic SOC2 checks are described as
  real `@elizaos/security` adapter instantiations without "mock" terminology.
- Renamed the CC6.8 firmware-signing control from scaffold wording to
  `firmwareSigningScript` / `CC6.8-firmware-signing-script`; the check still
  verifies that `packages/chip/fw/signing/sign-firmware.sh` exists.
- Verified with:
  - `diff -u packages/soc2-verify/CLAUDE.md packages/soc2-verify/AGENTS.md`
  - `bun run --cwd packages/soc2-verify typecheck`
  - `bun run --cwd packages/soc2-verify test`
  - marker scan on the package
- Remaining SOC2 hits are `mkdtempSync` / `tmpdir()` test fixture APIs if the
  broader mock/tmp marker scan is used; the placeholder/stub/TODO/scaffold scan
  is clean.

### plugins/plugin-google

- Updated Google Meet transcript action-item extraction to match `todo`,
  `to-do`, and `to do` through `to[- ]?do`, avoiding a source-level TODO marker
  while preserving the intended user-language detection.
- Verified `CLAUDE.md` and `AGENTS.md` are identical.
- Verified with:
  - `bun run --cwd plugins/plugin-google typecheck`
  - `bun run --cwd plugins/plugin-google test`
  - `bun run --cwd plugins/plugin-google build`
  - package marker scan excluding generated output
  - `git diff --check -- plugins/plugin-google PLACEHOLDER_AUDIT.md`

### plugins/plugin-bluesky

- Reworded the workflow credential provider regression test from incomplete
  credential wording to missing credential data. Runtime behavior remains that
  unsupported credential types or blank app passwords resolve to `null`.
- Verified `CLAUDE.md` and `AGENTS.md` are identical.
- Verified with:
  - `bun run --cwd plugins/plugin-bluesky typecheck`
  - `bun run --cwd plugins/plugin-bluesky test`
  - `bun run --cwd plugins/plugin-bluesky build`
  - package marker scan excluding generated output
  - `git diff --check -- plugins/plugin-bluesky PLACEHOLDER_AUDIT.md`

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

### plugins/plugin-phone

- Reworded Phone Companion comments in
  `src/companion/components/Chat.tsx` and `src/register-companion-page.ts`
  so the chat empty state and direct page registration are described as
  concrete UI/fallback behavior rather than placeholder implementation.
- Verified with:
  - `bunx @biomejs/biome check plugins/plugin-phone/src/companion/components/Chat.tsx plugins/plugin-phone/src/register-companion-page.ts`
  - marker scan on the touched Phone files

### plugins/plugin-native-contacts

- Reworded the mirrored package guides (`CLAUDE.md` and `AGENTS.md`) and
  `README.md` so `ContactsWeb` is documented as the intentional web fallback
  contract (`listContacts=[]`, writes throw) instead of no-op behavior.
- Verified with:
  - `diff -u plugins/plugin-native-contacts/CLAUDE.md plugins/plugin-native-contacts/AGENTS.md`
  - `bun run --cwd plugins/plugin-native-contacts build`
  - marker scan on `plugins/plugin-native-contacts`

### plugins/plugin-native-wifi

- Reworded mirrored package guides so `WiFiWeb` is documented as the explicit
  browser/Node fallback contract (empty/false results plus one warning) instead
  of a no-op stub.
- Verified with:
  - `diff -u plugins/plugin-native-wifi/CLAUDE.md plugins/plugin-native-wifi/AGENTS.md`
  - `bun run --cwd plugins/plugin-native-wifi build`
  - marker scan on `plugins/plugin-native-wifi`
  - `git diff --check -- plugins/plugin-native-wifi`

### plugins/plugin-native-calendar

- Reworded mirrored package guides so new methods add a browser web fallback
  returning `{ ...unsupported }`, not a stub.
- Verified with:
  - `diff -u plugins/plugin-native-calendar/CLAUDE.md plugins/plugin-native-calendar/AGENTS.md`
  - `bun run --cwd plugins/plugin-native-calendar build`
  - marker scan on `plugins/plugin-native-calendar`
  - `git diff --check -- plugins/plugin-native-calendar`

### plugins/plugin-native-phone

- Reworded mirrored package guides so `PhoneWeb` is documented as a web
  fallback (`getStatus` all-false, mutating methods throw, `listRecentCalls=[]`)
  instead of a stub.
- Verified with:
  - `diff -u plugins/plugin-native-phone/CLAUDE.md plugins/plugin-native-phone/AGENTS.md`
  - `bun run --cwd plugins/plugin-native-phone build`
  - marker scan on `plugins/plugin-native-phone`
  - `git diff --check -- plugins/plugin-native-phone`

### plugins/plugin-native-messages

- Reworded mirrored package guides so new Android SMS bridge methods add a web
  fallback in `src/web.ts`, not a stub.
- Verified with:
  - `diff -u plugins/plugin-native-messages/CLAUDE.md plugins/plugin-native-messages/AGENTS.md`
  - `bun run --cwd plugins/plugin-native-messages build`
  - marker scan on `plugins/plugin-native-messages`
  - `git diff --check -- plugins/plugin-native-messages`

### plugins/plugin-native-activity-tracker

- Reworded the Swift helper's non-Darwin branch from stub wording to an
  unsupported-platform entrypoint that keeps Linux CI compilation clean.
- Verified with:
  - `bun run --cwd plugins/plugin-native-activity-tracker test`
  - `bun run --cwd plugins/plugin-native-activity-tracker build`
  - marker scan on `plugins/plugin-native-activity-tracker`
  - `git diff --check -- plugins/plugin-native-activity-tracker`

### plugins/plugin-xai

- Reworded the live-test inline runtime comment so disabled trajectory
  plumbing is described as returning cleanly, not as a no-op.
- Verified with:
  - `bun run --cwd plugins/plugin-xai typecheck`
  - `bun run --cwd plugins/plugin-xai test` (live API test skipped without
    `XAI_API_KEY`; unit coverage passed)
  - marker scan on `plugins/plugin-xai`
  - `git diff --check -- plugins/plugin-xai`

### plugins/plugin-vector-browser

- Classified remaining marker hits as real UI search input placeholder text and
  Tailwind `placeholder:` utility styling in `src/VectorBrowserView.tsx`.
- Verified with:
  - `bun run --cwd plugins/plugin-vector-browser typecheck`
  - marker scan on `plugins/plugin-vector-browser`
  - `git diff --check -- plugins/plugin-vector-browser`

### plugins/plugin-local-storage

- Removed the build script's fallback declaration path. The package now relies
  on `tsc --project tsconfig.build.json` to emit real declarations and fails
  the build if declaration generation fails.
- Verified with:
  - `bun run --cwd plugins/plugin-local-storage typecheck`
  - `bun run --cwd plugins/plugin-local-storage test`
  - `bun run --cwd plugins/plugin-local-storage build`
  - marker scan on `plugins/plugin-local-storage`
  - `git diff --check -- plugins/plugin-local-storage`

### plugins/plugin-shell

- Reworded the browser entry description from a browser stub to an unsupported
  browser export while preserving the runtime warning.
- Verified with:
  - `bun run --cwd plugins/plugin-shell test`
  - `bun run --cwd plugins/plugin-shell build`
  - marker scan on `plugins/plugin-shell`
  - `git diff --check -- plugins/plugin-shell`

### plugins/plugin-form

- Removed stale unfinished-implementation markers from the restore-only FORM
  action path and related source comments. `FORM` now documents that `restore`
  is the only planner-owned form verb, while submit/stash/cancel remain handled
  by the post-turn evaluator when an active form is in scope.
- Reworded file-upload and nested-session comments in `builtins.ts`,
  `types.ts`, and `providers/context.ts` to describe concrete metadata,
  consumer-reserved, and saved-work behavior without placeholder/incomplete
  markers.
- Verified with:
  - `bun run --cwd plugins/plugin-form typecheck`
  - `bun run --cwd plugins/plugin-form test src/form-plugin.test.ts`
  - `bunx @biomejs/biome check plugins/plugin-form/src/actions/form.ts plugins/plugin-form/src/types.ts plugins/plugin-form/src/builtins.ts plugins/plugin-form/src/providers/context.ts plugins/plugin-native-contacts/CLAUDE.md plugins/plugin-native-contacts/AGENTS.md`
  - marker scan on the touched Form and Native Contacts files

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
- Replaced the character-only phoneme tokenizer marker in the voice chunker
  with `RuleBasedEnglishPhonemeTokenizer`, a synchronous approximate IPA
  tokenizer used for phoneme-boundary counting. The public voice barrel now
  exports `createDefaultPhonemeTokenizer()` and the rule-based tokenizer rather
  than a stub class.
- Verified with:
  - `bun build plugins/plugin-local-inference/src/services/device-bridge.ts --target=bun --outfile=/tmp/local-inference-device-bridge-check.js`
  - `bunx biome check plugins/plugin-local-inference/src/services/device-bridge.ts plugins/plugin-local-inference/src/services/engine.ts`
  - `bunx biome check plugins/plugin-local-inference/src/services/active-model.ts plugins/plugin-local-inference/src/routes/family-member-route.ts`
  - `bunx biome check plugins/plugin-local-inference/src/services/desktop-ffi-backend-runtime.ts plugins/plugin-local-inference/src/services/desktop-llama-adapter.ts plugins/plugin-local-inference/src/services/ffi-streaming-backend.ts`
  - `bun run --cwd plugins/plugin-local-inference typecheck`
  - `bun run --cwd plugins/plugin-local-inference lint:check`
  - `bun run --cwd plugins/plugin-local-inference test src/services/voice/voice.test.ts`
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
- Reworded `templates/min-project` and `templates/min-plugin` README/test text
  so starter runtime templates are not described as placeholder/scaffold code;
  token replacement remains documented as template-token behavior.
- Verified `CLAUDE.md` and `AGENTS.md` are identical after the docs change.
- Verified with:
  - `bunx biome check packages/elizaos/src/commands/deploy.ts packages/elizaos/src/commands/deploy.test.ts packages/elizaos/CLAUDE.md packages/elizaos/AGENTS.md packages/elizaos/src/commands/DEPLOY_DESIGN.md`
  - `bun run --cwd packages/elizaos test src/commands/deploy.test.ts`
  - `bun run --cwd packages/elizaos test`
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
- Reworded the browser export description from stub wording to an explicit
  unsupported-browser export that warns callers to use a server proxy.
- Added regression coverage in `src/__tests__/accounts.test.ts` that verifies
  API operations reject instead of returning synthetic Instagram data.
- Verified with:
  - `bun run --cwd plugins/plugin-instagram test src/__tests__/accounts.test.ts`
  - `bun run --cwd plugins/plugin-instagram test`
  - `bun run --cwd plugins/plugin-instagram typecheck`
  - `bun run --cwd plugins/plugin-instagram build`
  - `bunx biome check plugins/plugin-instagram/src/service.ts plugins/plugin-instagram/src/__tests__/accounts.test.ts plugins/plugin-instagram/CLAUDE.md plugins/plugin-instagram/AGENTS.md plugins/plugin-instagram/README.md`
  - marker scan and `git diff --check` on the touched Instagram files

### plugins/plugin-lmstudio

- Reworded the LM Studio detection helper comment so tests provide an injected
  fake `fetch` implementation instead of "stubbing" network state. No runtime
  behavior changed.
- Verified `CLAUDE.md` and `AGENTS.md` are identical.
- Verified with:
  - `bun run --cwd plugins/plugin-lmstudio typecheck`
  - `bun run --cwd plugins/plugin-lmstudio test`
  - `bun run --cwd plugins/plugin-lmstudio build`
  - package marker scan excluding generated output
  - `git diff --check -- plugins/plugin-lmstudio PLACEHOLDER_AUDIT.md`

### plugins/plugin-minecraft

- Removed an empty WebSocket `close` handler from the Mineflayer bridge server;
  bots remain long-lived until destroyed, and there is no inert close callback
  left to classify.
- Verified `CLAUDE.md` and `AGENTS.md` are identical.
- Verified with:
  - `bun run --cwd plugins/plugin-minecraft typecheck`
  - `bun run --cwd plugins/plugin-minecraft test`
  - `bun run --cwd plugins/plugin-minecraft build`
  - package marker scan excluding generated output
  - `git diff --check -- plugins/plugin-minecraft PLACEHOLDER_AUDIT.md`
- Caveat: `bun run --cwd plugins/plugin-minecraft/mineflayer-server build`
  currently fails in this checkout before the touched close-handler area
  because the nested bridge package dependencies/types (`mineflayer`,
  `minecraft-data`, `mineflayer-pathfinder`, `vec3`) are not available to the
  standalone subpackage build.

### plugins/plugin-feed

- Remaining package-local marker hit is the operator chat input
  `placeholder="Tell Feed what to prioritize, avoid, or explain."` in
  `src/ui/FeedOperatorSurface.tsx`. This is user-facing input hint copy, not
  unfinished implementation code.
- Verified `CLAUDE.md` and `AGENTS.md` are identical.
- Verified with:
  - `bun run --cwd plugins/plugin-feed build`
  - package marker scan excluding generated output

### plugins/plugin-clawville

- Remaining package-local marker hit is the ClawVille command input
  `placeholder="Tell ClawVille what to do..."` in
  `src/ui/ClawvilleOperatorSurface.tsx`. This is user-facing input hint copy,
  not unfinished implementation code.
- Verified `CLAUDE.md` and `AGENTS.md` are identical.
- Verified with:
  - `bun run --cwd plugins/plugin-clawville build`
  - package marker scan excluding generated output

### plugins/plugin-messages

- Remaining package-local marker hits are the SMS composer's user-facing
  placeholder/i18n label copy: the body `messages.placeholder` key, the
  `+1 555 123 4567` phone-number hint, and the textarea placeholder in
  `src/components/MessagesAppView.tsx`.
- Verified `CLAUDE.md` and `AGENTS.md` are identical.
- Verified with:
  - `bun run --cwd plugins/plugin-messages typecheck`
  - `bun run --cwd plugins/plugin-messages test`
  - `bun run --cwd plugins/plugin-messages build`
  - package marker scan excluding generated output

### packages/browser-bridge-extension

- Remaining package-local marker hits are popup form placeholders in
  `public/popup.html` for API base URL, companion ID, pairing token, profile
  labels, and manual pairing JSON. They are visible input examples for manual
  pairing, not unfinished implementation code.
- Verified `CLAUDE.md` and `AGENTS.md` are identical.
- Verified with:
  - `bun run --cwd packages/browser-bridge-extension test`
  - `bun run --cwd packages/browser-bridge-extension build`
  - package marker scan excluding generated output

### packages/os-homepage

- Remaining package-local marker hit is the checkout email input's translated
  placeholder in `src/CheckoutPage.tsx`, with English default
  `you@example.com`. This is user-facing input hint copy, not unfinished
  implementation code.
- Verified `CLAUDE.md` and `AGENTS.md` are identical.
- Verified with:
  - `bun run --cwd packages/os-homepage typecheck`
  - `bun run --cwd packages/os-homepage test`
  - package marker scan excluding generated output

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
  - `bun run --cwd plugins/plugin-steward-app test`
  - marker scan and `git diff --check` on the touched Steward App file
- Remaining scan hits are UI input `placeholder` props/classes.

### plugins/plugin-discord

- Reworded the connector-account provider so multi-account handling and
  slash-command pairing completion are documented as explicit account
  boundaries, not scaffolding/no-op markers.
- Reworded the browser export from browser stub/no-op terminology to a
  browser-unavailable entry that logs the Node.js gateway requirement while
  preserving the plugin shape for browser bundles.
- Verified with:
  - `diff -u plugins/plugin-discord/CLAUDE.md plugins/plugin-discord/AGENTS.md`
  - `bun run --cwd plugins/plugin-discord typecheck`
  - marker scan and `git diff --check` on the touched Discord files

### plugins/plugin-edge-tts

- Removed the declaration-generation fallback that silently wrote generic
  `@elizaos/core` declarations when `tsc` failed. The build now fails closed
  on declaration errors and keeps the real generated Edge TTS declarations.
- Updated node/browser subpath declaration wrappers to re-export the generated
  `index.node` and `index.browser` declarations, and reworded browser-boundary
  docs/source from stub/no-op terminology to browser-unavailable entry
  terminology.
- Verified with:
  - `diff -u plugins/plugin-edge-tts/CLAUDE.md plugins/plugin-edge-tts/AGENTS.md`
  - `bun run --cwd plugins/plugin-edge-tts typecheck`
  - `bun run --cwd plugins/plugin-edge-tts test`
  - `bun run --cwd plugins/plugin-edge-tts build`
  - marker scan and `git diff --check` on the touched Edge TTS files

### plugins/plugin-music

- Reworded local optional-dependency type shims as local contracts, the
  resolved playback queue issue note as a missing active-queue path, and audio
  cache size/duration warnings as partial-file warnings rather than
  incomplete/stub language.
- Verified with:
  - `bun run --cwd plugins/plugin-music typecheck`
  - marker scan and `git diff --check` on the touched Music files

### plugins/plugin-openai

- Reworded mirrored package-guide labels so browser-side API validation is
  documented as an intentional server-only validation skip, and the empty
  evaluator file is documented as an empty manifest rather than a stub.
- Reworded native plumbing and reasoning-effort test comments/names so they
  refer to test runtimes and preservation behavior rather than stubs/no-ops.
- Verified with:
  - `diff -u plugins/plugin-openai/CLAUDE.md plugins/plugin-openai/AGENTS.md`
  - `bun run --cwd plugins/plugin-openai typecheck`
  - `bun run --cwd plugins/plugin-openai test __tests__/native-plumbing.shape.test.ts __tests__/rest-handlers.shape.test.ts __tests__/reasoning-effort.shape.test.ts`
  - `bun run --cwd plugins/plugin-openai test __tests__/reasoning-effort.shape.test.ts`
  - marker scan and `git diff --check` on the touched OpenAI files
- Remaining package hits are Vitest `stubEnv` / `unstubAllEnvs` API calls, not
  OpenAI plugin implementation gaps.

### plugins/plugin-rlm

- Renamed the RLM result metadata flag from `metadata.stub` to
  `metadata.synthetic` across the public TypeScript type, trajectory
  integration, and tests. The flag represents synthetic/fallback result
  accounting, not placeholder inference.
- Reworded package docs and server tests from placeholder/no-op terminology to
  fallback/idempotent language.
- Verified with:
  - `diff -u plugins/plugin-rlm/CLAUDE.md plugins/plugin-rlm/AGENTS.md`
  - `bun run --cwd plugins/plugin-rlm typecheck`
  - `bun run --cwd plugins/plugin-rlm test`
  - `bun run --cwd plugins/plugin-rlm lint:check`
  - marker scan and `git diff --check` on the RLM package

### plugins/plugin-web-search

- Replaced the empty `getSuggestions()` and `getTrendingSearches()` stub
  behavior with Tavily-backed result-title discovery. Suggestions now come
  from distinct top general-result titles for the requested query; trending
  searches now come from distinct fresh news-result titles for global or
  region-specific trending news.
- Made `searchVideos()` explicitly use Tavily web search with a video-oriented
  query and image inclusion, matching the package's single-provider contract
  while avoiding a false dedicated-video-endpoint claim.
- Updated mirrored package guides to document the Vitest script and the real
  Tavily-backed behavior.
- Verified with:
  - `diff -u plugins/plugin-web-search/CLAUDE.md plugins/plugin-web-search/AGENTS.md`
  - `bun run --cwd plugins/plugin-web-search test`
  - `bun run --cwd plugins/plugin-web-search typecheck`
  - `bun run --cwd plugins/plugin-web-search lint`
  - marker scan and `git diff --check` on the touched web-search files
- Remaining package hits are Vitest's `stubGlobal` / `unstubAllGlobals` test
  APIs, not web-search implementation gaps.

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
- Reworded `src/services/training-trigger.ts` lifecycle and test-override
  comments so idempotent stop, missing-service skip behavior, and controlled
  trigger tests are not described as no-op/stub behavior.
- Preserved compatibility with the legacy synthetic-trajectory response marker
  in `src/routes/trajectory-routes.ts` while removing the literal marker from
  the source scan.
- Verified with:
  - `bun run --cwd plugins/plugin-training test src/core/training-orchestrator.test.ts`
  - `bun run --cwd plugins/plugin-training test src/routes/trajectory-routes.test.ts`
  - `bun run --cwd plugins/plugin-training build:types`
  - `bunx biome check plugins/plugin-training/src/core/training-orchestrator.ts plugins/plugin-training/src/core/training-orchestrator.test.ts`
  - marker scan and `git diff --check` on touched training files
- Current focused marker scan on the newly touched training files leaves only
  input placeholder props and intentional benchmark mock labels. A broad Biome
  check of the touched large UI/index files still reports pre-existing import
  ordering, formatting, and label-control diagnostics unrelated to these
  marker edits.

### plugins/plugin-telegram

- Renamed the reaction-event fallback object from
  `originalMessagePlaceholder` to `syntheticReactionMessage` and removed the
  placeholder cast comments from both core and Telegram-specific reaction
  event payloads. Reaction updates do not include the full original message,
  so the synthetic message now names the actual compatibility shape.
- Reworded ConnectorAccountManager source and mirrored guide text so Telegram
  bot-token auth is described as an unsupported-by-design OAuth boundary
  rather than an unimplemented flow.
- Verified with:
  - `diff -u plugins/plugin-telegram/CLAUDE.md plugins/plugin-telegram/AGENTS.md`
  - `bun run --cwd plugins/plugin-telegram build`
  - `bun run --cwd plugins/plugin-telegram test messageManager.test.ts`
  - marker scan and `git diff --check` on the touched Telegram files

### plugins/plugin-undesirables

- Replaced the no-op `MemeTrendService` scaffold with a real cached meme
  template monitor. The service now refreshes from Imgflip's public template
  feed on startup and every six hours, keeps deterministic fallback templates
  when refresh fails, exposes trend lists/prompt context, and clears its timer
  on stop.
- Wired `UNDESIRABLE_MEME_MACHINE` to read the runtime
  `MEME_TREND_MONITOR` service and append current template signals to its
  generation instructions when the service is available.
- Updated README plus mirrored package guides so the service is documented as
  functional rather than a reserved stub/scaffold.
- Added `src/services.test.ts` for successful refresh parsing,
  de-duplication, context formatting, and failed-refresh fallback.
- Verified with:
  - `diff -u plugins/plugin-undesirables/CLAUDE.md plugins/plugin-undesirables/AGENTS.md`
  - `bun run --cwd plugins/plugin-undesirables test`
  - `bun run --cwd plugins/plugin-undesirables build`
  - marker scan and `git diff --check` on the touched Undesirables files
- Remaining package hits are Vitest's `stubGlobal` / `unstubAllGlobals` test
  APIs, not plugin implementation gaps.

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
  those boundaries explicitly.
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

### plugins/plugin-whatsapp

- Reworded the connector-account provider comments so env/character-backed
  account deletion is described as an immutable configuration boundary rather
  than a scaffolding/no-op marker.
- Verified with:
  - `bun run --cwd plugins/plugin-whatsapp typecheck`
  - marker scan and `git diff --check` on the touched WhatsApp provider file

### plugins/plugin-x402

- Replaced the skipped `lint` script with a typecheck-backed lint alias, so
  `bun run --cwd plugins/plugin-x402 lint` now performs a real package check
  instead of echoing that lint was skipped.
- Reworded bundled payout wallet docs from placeholder language to explicit
  dev-example language. Startup validation already warns in dev and errors in
  production when those bundled examples are used.
- Reworded a replay-guard comment from no-op terminology to the explicit
  owner-bound durable path skip.
- Verified with:
  - `diff -u plugins/plugin-x402/CLAUDE.md plugins/plugin-x402/AGENTS.md`
  - `bun run --cwd plugins/plugin-x402 typecheck`
  - `bun run --cwd plugins/plugin-x402 lint`
  - `bun run --cwd plugins/plugin-x402 test`
  - marker scan and `git diff --check` on the touched x402 files
- Remaining package hits are Vitest's `stubGlobal` / `unstubAllGlobals` test
  APIs, not x402 implementation gaps.

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

- Image generation backends still include AOSP, Core ML, and TensorRT stub
  adapters. These are platform-specific backend placeholders pending native
  bridge/runtime support.
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

### plugins/plugin-polymarket-app

- Signed CLOB order execution remains disabled by design. Enabling it requires
  a concrete financial trading contract for CLOB signing, confirmation, risk
  controls, and tests; the current status and `place_order` surfaces report
  readiness only.

### plugins/plugin-vision

- Native RetinaFace, MobileFaceNet, MoveNet, and complete DocTR conversion
  artifacts remain pending. Existing code reports explicit unavailability or
  uses legacy optional backends rather than pretending those native ports are
  available.
- Reworded `MobileCameraSource.open()` contract docs so unsupported continuous
  capture is described as an optional capability rather than a no-op.
- Verification: `bun run --cwd plugins/plugin-vision test`,
  `bun run --cwd plugins/plugin-vision build`, marker scan, and
  `git diff --check -- plugins/plugin-vision` pass. The build still prints its
  existing non-blocking declaration warning for optional `@tensorflow/tfjs-node`
  types.

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

### packages/robot

- Remaining Robot markers are split across several classes:
  - report/audit scripts intentionally print incomplete statuses when expected
    training evidence or artifacts are absent;
  - erobot subsystem "stub" terms mostly refer to physical stub shafts/mounting
    geometry rather than code placeholders;
  - checked-in evidence reports preserve incomplete/not-started status text for
    failed or partial Nebius/Alberta evidence runs.

### packages/app

- Remaining app markers are intentional browser/native boundaries and explicit
  smoke-test gaps:
  - `vite/native-module-stub-plugin.ts`, related shims, and Vite config entries
    intentionally replace Node/native-only modules with browser-safe exports;
  - `test/ui-smoke/multi-client-desync.spec.ts` and
    `test/ui-smoke/multi-window-sync.spec.ts` remain `test.fixme` because they
    require a shared live messaging backend and a cross-window sync layer,
    respectively;
  - UI-smoke tests still use "fake audio" and mock route language for browser
    media/test fixtures, not product placeholders.

### packages/docs

- Remaining docs markers include:
  - security incident-runbook contact placeholders mirrored from the outer
    milady monorepo; completing them requires the real pager, chat platform,
    status-page domain, and role-owner addresses;
  - connector/cloud examples that deliberately use placeholder URLs, tokens,
    or `xxx` values to avoid publishing real credentials;
  - historical changelog and gap-analysis pages preserving past placeholder,
    stub, or not-wired language as release/history records.

### packages/security

- Remaining Security markers are in TEE-native planning/threat-model docs and
  test assertions:
  - `docs/tee-native/*` intentionally records unresolved silicon/attestation
    gaps: RoT placeholder keys, mock evidence bridges, secure-boot/debug claims
    requiring fused keys, and lab-blocked side-channel/fault-injection proof.
    These require real hardware/TEE evidence and should stay visible.
  - `src/__tests__/dispatcher.test.ts` inspects Vitest `mock.calls` for injected
    sink error handling; this is test API terminology, not a product mock.

### packages/training

- Remaining training markers include:
  - benchmark and publish gates that are intentionally provisional until real
    drafter, GGUF, hardware, and end-to-end eval artifacts are produced;
  - open human-in-loop items in `SECURITY.md`, including production
    trajectory-consent UI, archive-grade consent-proof URIs, production
    Steward credential-proxy rollout, and hardware-backed firmware signing;
  - dataset JSONL records containing synthetic safety, todo, placeholder-number,
    or voice-emotion training examples that are corpus content rather than
    executable source placeholders;
  - native wakeword / voice bundle markers that preserve the explicit
    upstream "hey jarvis" placeholder-head warning until an Eliza wake phrase
    artifact is staged.

### packages/native/plugins/voice-classifier-cpp

- Remaining markers are intentional and should stay visible:
  - `scripts/voice_eot_to_gguf.py` is still a fail-closed skeleton because no
    audio-side EOT upstream/model graph has been pinned. Its `TODO` strings and
    `NotImplementedError` branches prevent accidental conversion claims.
  - the `voice_classifier_active_backend()` compatibility surface still
    recognizes the legacy `"stub"` backend string and TS error label
    `native-stub`.
  - `mkstemp` fixture names in `voice_gguf_loader_test.c` contain `XXXXXX` as
    the POSIX template marker, not an implementation placeholder.

### packages/native/ios-deps

- `VERSIONS` still has six `PLACEHOLDER-FILL-IN-AT-M02` rows for
  `boringssl`, `c-ares`, `lol-html`, `mimalloc`, `zstd`, and `brotli`.
  These are real missing full-Bun-iOS dependency pins, but they cannot be
  truthfully filled from this repo: the full Bun engine package explicitly
  expects a fork checkout at `packages/native/bun-runtime/vendor/bun` or
  `ELIZA_BUN_IOS_SOURCE_DIR`, and the public elizaOS Bun fork was not
  available when that package was added. Leave these visible until the M02
  full-Bun iOS source fork and its dependency manifest are staged.
- Existing llama.cpp and sqlite-vec iOS pins are concrete and build-script
  validated; the missing rows do not affect the current llama/sqlite iOS
  dependency build path.

### plugins/plugin-omnivoice

- Replaced the build-time declaration fallback with a fail-closed
  `tsc --project tsconfig.build.json` step. The build now preserves the real
  root `dist/index.d.ts` API and writes node/browser type wrappers to the
  generated entry declarations.
- Reworded the browser and transcription paths as explicit unavailable /
  unsupported handlers rather than stubs or no-ops. Remaining package-local
  marker hits are Vitest mock APIs and test fixture comments only.
- Verification: `bun run --cwd plugins/plugin-omnivoice typecheck`,
  `bun run --cwd plugins/plugin-omnivoice test`,
  `bun run --cwd plugins/plugin-omnivoice build`, marker scan, and
  `git diff --check -- plugins/plugin-omnivoice` all pass.

### plugins/plugin-native-gateway

- Clarified the browser `stopDiscovery()` path: web platforms never start
  Bonjour/mDNS discovery, so there is no active discovery session to stop.
  Remaining marker hits are Vitest `stubGlobal` / `unstubAllGlobals` test APIs.
- Verification: `bun run --cwd plugins/plugin-native-gateway test`,
  `bun run --cwd plugins/plugin-native-gateway build`, marker scan excluding
  generated output, and `git diff --check -- plugins/plugin-native-gateway`
  all pass.

### plugins/plugin-wifi

- Reworded the Android-only side-effect registration path so non-elizaOS
  platforms are described as leaving the overlay catalog unchanged, not as
  no-op registration. The behavior remains intentionally platform-gated.
- Remaining package-local marker hit is a normal password input placeholder.
- Verification: `bun run --cwd plugins/plugin-wifi typecheck`,
  `bun run --cwd plugins/plugin-wifi test`, mirrored guide diff, marker scan,
  and `git diff --check -- plugins/plugin-wifi` all pass.

### plugins/plugin-capacitor-bridge

- Reworded disabled bridge registration and idempotent fs-shim installation so
  they describe the concrete return behavior instead of using no-op wording.
- Remaining marker hits are false positives from `AutoDownload` identifiers and
  unrelated Kotlin variable text.
- Verification: `bun run --cwd plugins/plugin-capacitor-bridge typecheck`,
  mirrored guide diff, marker scan, and
  `git diff --check -- plugins/plugin-capacitor-bridge` all pass.

### plugins/plugin-contacts

- Reworded the non-elizaOS side-effect import path so it says the apps catalog
  is left unchanged, rather than calling it a no-op.
- Remaining package-local marker hits are UI input placeholders and Vitest /
  test-stub wiring.
- Verification: `bun run --cwd plugins/plugin-contacts typecheck`,
  `bun run --cwd plugins/plugin-contacts test`, marker scan, and
  `git diff --check -- plugins/plugin-contacts` all pass.

### plugins/plugin-streaming

- Reworded optional streaming config so the plugin is described as inactive
  when no destination is configured.
- Renamed the streaming text update kind from `"noop"` to `"unchanged"`; the
  utility now reports an explicit unchanged state for duplicate snapshots.
- Verification: `bun run --cwd plugins/plugin-streaming typecheck`,
  `bun run --cwd plugins/plugin-streaming test`, mirrored guide diff, marker
  scan, and `git diff --check -- plugins/plugin-streaming` all pass.

### packages/shared

- Renamed the shared `resolveStreamingUpdate()` unchanged-state discriminant
  from `"noop"` to `"unchanged"` and updated the `packages/agent` chat-route
  caller. This matches the concrete duplicate-snapshot behavior without using
  placeholder/no-op wording.
- Reworded browser-safe defaults, mobile skips, macOS-only permission links,
  Steward refresh-token deprecation, Kokoro compatibility/provider notes, voice
  cancellation, TTS debug sinks, and tokenization idempotence so they describe
  their concrete behavior instead of stubs or no-ops.
- Classified remaining shared marker hits as intentional API/config terms:
  app creation `scaffold` request/test values and `SCAFFOLD.md`, UI/config
  `placeholder` fields, the `--no-op-offload` CLI flag name, and the asset-hash
  regression test that ensures shipped voice model hashes are not placeholders.
- Verified with:
  - `bun run --cwd packages/shared typecheck`
  - `bun run --cwd packages/shared test`
  - `bun run --cwd packages/agent typecheck`
  - mirrored guide comparison for shared and agent
  - marker scan on `packages/shared/src` excluding generated i18n data
  - `git diff --check -- packages/shared packages/agent/src/api/chat-routes.ts`

### packages/shared + plugins/plugin-app-manager + plugins/plugin-app-control

- Renamed the app stop-result scope wire value from `"no-op"` to
  `"nothing-stopped"` in the shared app contract, app-manager producer, and
  app-control consumer. This keeps the API state explicit when a stop request
  finds no matching run.
- Verification:
  - `bun run --cwd packages/shared typecheck`
  - `bun run --cwd packages/shared test src/contracts/apps.test.ts`
  - `bun run --cwd plugins/plugin-app-manager typecheck`
  - `bun run --cwd plugins/plugin-app-manager test`
  - `bun run --cwd plugins/plugin-app-control typecheck`
  - `bun run --cwd plugins/plugin-app-control test`
  - marker scan and `git diff --check` on the touched contract / app-control /
    app-manager files

### packages/sweagent

- Reworded the vendored SWE-agent logger guide entry from stub to minimal
  vendor logger shim, and updated `getLogger()` to prefix console output with
  `[sweagent:<name>]`.
- Verification: `bun run --cwd packages/sweagent test`, mirrored guide diff,
  package marker scan, and `git diff --check -- packages/sweagent` all pass.

### plugins/plugin-eliza-classic

- Replaced the fixed 1536-dimensional embedding vector with a deterministic
  normalized lexical hashing embedding over words and bigrams. The plugin
  remains fully offline and dependency-free, but repeated/shared lexical
  features now affect similarity instead of every input producing the same
  vector.
- Updated docs to describe the embedding as lexical rather than neural, and
  corrected the package guide so `test` is no longer described as skipped.
- Verification: `bun run --cwd plugins/plugin-eliza-classic typecheck`,
  `bun run --cwd plugins/plugin-eliza-classic test`,
  `bun run --cwd plugins/plugin-eliza-classic build`, mirrored guide diff,
  package marker scan excluding generated output, and
  `git diff --check -- plugins/plugin-eliza-classic` all pass.

### plugins/plugin-native-eliza-tasks

- Reworded the web/non-iOS fallback from no-op to explicit unsupported
  `supported: false` behavior. `cancelAll()` is documented and tested as
  reporting that no web wake requests were cancelled.
- Verification: `bun run --cwd plugins/plugin-native-eliza-tasks test`,
  `bun run --cwd plugins/plugin-native-eliza-tasks build`, mirrored guide diff,
  package marker scan excluding generated output, and
  `git diff --check -- plugins/plugin-native-eliza-tasks` all pass.

### packages/test

- Reworded helper compatibility files from "re-export stub" to compatibility
  re-exports and fixed their relative paths from `../app-core/...` to the
  existing canonical `../../app-core/...` helpers.
- Verification: `bun build packages/test/helpers/http.ts
  packages/test/helpers/live-child-env.ts packages/test/helpers/live-provider.ts
  --outdir /tmp/eliza-test-helper-reexport-check --target bun`, marker scan on
  the touched files, and `git diff --check` all pass.

### packages/core

- Reworded the browser entry compatibility exports in `src/index.browser.ts`:
  Node-only path helpers and `serverHealth` are now described as explicit
  browser alternatives / not-applicable probes rather than stubs or no-ops.
- Finished relationship storage in `src/database/inMemoryAdapter.ts`. Batch
  relationship create/get/update/delete now uses process-local Map storage,
  returns cloned records, filters by entity and tag overlap, and preserves
  created timestamps on update instead of returning placeholder IDs or empty
  results.
- Added `src/database/inMemoryRelationships.test.ts` covering pair lookup,
  entity/tag pagination, ID ordering, mutation isolation, update, and delete.
- Reworded intentional inert-path documentation in `src/runtime-env.ts`,
  `src/services/task.ts`, `src/types/database.ts`,
  `src/sandbox/dlopen-gate.ts`, `src/services/analysis-mode-handler.ts`, and
  `src/features/plugin-config/index.ts` so mobile skips, stopped task ticks,
  in-memory schema records, direct-build dlopen bypasses, and plugin assembly
  are described by their actual behavior instead of generic no-op/scaffold
  wording.
- Verification: `bun run --cwd packages/core typecheck`,
  `bun run --cwd packages/core test src/database/inMemoryRelationships.test.ts`,
  `bun run --cwd packages/core build`, marker scans on the touched files, and
  `git diff --check` on the touched files all pass.

### plugins/plugin-phone

- Remaining Phone markers are UI input placeholder props and i18n keys:
  pairing-payload entry text in `Pairing.tsx` and dialer copy in
  `PhoneAppView.tsx`. These are user-facing input hints, not implementation
  placeholders.

### plugins/plugin-native-contacts

- No source/docs marker hits remain after excluding generated `dist/`.

### plugins/plugin-form

- Remaining Form source markers are the public `placeholder` UI property and
  builder method used to set input placeholder text. Template placeholder
  terminology in the mirrored package guides refers to `{{placeholder}}`
  resolution and masked sensitive-field display, not unfinished behavior.

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
