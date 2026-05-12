# Repo Hardening TODO Ledger

Date: 2026-05-12

This ledger consolidates the hardening research and blocker reports in this
folder. It is ordered so implementation agents can work in parallel without
touching the same files at the same time.

## Source reports

- `blocker-root-test.md`
- `blocker-plugin-discord-native.md`
- `types-core-family.md`
- `types-plugins-family.md`
- `types-examples-benchmarks-cloud-inference.md`
- `suppressions-any-fallbacks-core.md`
- `suppressions-any-fallbacks-plugins.md`
- `non-ts-suppressions-artifacts.md`
- `plugin-local-ai-suppressions-fix.md`
- `cloud-suppressions-fix.md`
- `vault-suppressions-fix.md`
- `app-core-electrobun-suppressions-fix.md`
- `cloud-drizzle-boundary-fix.md`
- `agent-metadata-type-fix.md`
- `plugin-local-ai-utils-suppressions-fix.md`
- `plugin-wallet-types-suppressions-fix.md`
- `app-lifeops-small-mixins-suppressions-fix.md`
- `workflow-appcore-suppressions-fix.md`
- `blocker-knip.md` when the Knip blocker pass lands

## Completed blocker fixes

### Root test runner and app-core unit selection

Source: `blocker-root-test.md`

- `scripts/run-all-tests.mjs`
  - Default ordinary package `test` scripts to `ELIZA_LIVE_TEST=0`.
  - Preserve explicit `ELIZA_LIVE_TEST`, `TEST_LANE=post-merge`, and `*:live`
    script opt-in behavior.
  - Skip `packages/app-core/platforms/electrobun#test` unless
    `ELIZA_INCLUDE_ELECTROBUN_TESTS=1`.
- `packages/app-core/vitest.config.ts`
  - Exclude `platforms/electrobun/**` from default app-core unit collection.
  - Exclude `test/helpers/__tests__/live-agent-test.smoke.test.ts`.
  - Migrate ignored Vitest 3 `poolOptions.forks.singleFork` to Vitest 4
    `maxWorkers: 1` plus `isolate: false`.

Validation:

- `node --check scripts/run-all-tests.mjs`
- `node --check scripts/knip-workspaces.mjs`
- Focused app-core Vitest check passed: 2 files, 16 tests.
- Root app-core focused lane needs a full rerun once long-running validation
  slots are free.

### plugin-discord native voice import blocker

Source: `blocker-plugin-discord-native.md`

- `plugins/plugin-discord/voice.ts`
  - Replaced eager `@discordjs/voice` value import with a cached dynamic
    `loadDiscordVoiceModule()`.
  - Wrapped optional native binding failures in `DiscordVoiceUnavailableError`.
  - Changed `getVoiceConnection()` to use manager-owned tracked connections.
- `plugins/plugin-discord/tests.ts`
  - Uses the same lazy voice loader for live voice helpers.

Validation:

- `bun run --cwd plugins/plugin-discord typecheck`
- `bun run --cwd plugins/plugin-discord build`
- `bun run --cwd plugins/plugin-discord test` passed: 7 files, 34 tests.

### Immediate `@ts-nocheck` removals

Sources: `suppressions-any-fallbacks-core.md`,
`suppressions-any-fallbacks-plugins.md`

- `cloud/services/_smoke-mcp/worker.ts`
  - Removed file-level `@ts-nocheck`.
  - Made `cloud/services/_smoke-mcp/tsconfig.json` standalone with Workers-only
    types and no conflicting DOM library.
  - Validation passed:
    `bun ./cloud/node_modules/typescript/lib/tsc.js --noEmit --project cloud/services/_smoke-mcp/tsconfig.json --pretty false`.
- `cloud/packages/tests/unit/steward-sync.test.ts`
  - Removed file-level `@ts-nocheck`; existing typed mock casts were enough.
  - Validation passed:
    `SKIP_DB_DEPENDENT=1 SKIP_SERVER_CHECK=true bun test --preload ./packages/tests/load-env.ts packages/tests/unit/steward-sync.test.ts`.
- `plugins/plugin-local-ai/environment.ts`
  - Removed stale file-level `@ts-nocheck`.
  - Validation passed:
    `bun run --cwd plugins/plugin-local-ai typecheck`.
- `plugins/plugin-local-ai/structured-output.ts`
  - Removed file-level `@ts-nocheck`.
  - Added narrow node-llama-cpp boundary types for `GbnfJsonSchema` bridging.
  - Validation passed:
    `bun run --cwd plugins/plugin-local-ai typecheck` and
    `bun run --cwd plugins/plugin-local-ai test -- __tests__/structured-output.test.ts`.
- `plugins/plugin-local-ai/utils/platform.ts`
  - Removed stale file-level `@ts-nocheck`.
- `plugins/plugin-local-ai/utils/tokenizerManager.ts`
  - Removed stale file-level `@ts-nocheck`.
  - Validation passed:
    `bun run --cwd plugins/plugin-local-ai typecheck`.
- `plugins/plugin-wallet/src/analytics/dexscreener/types.ts`
  - Removed file-level `@ts-nocheck`.
- `plugins/plugin-wallet/src/analytics/birdeye/types/**/*.ts`
  - Removed file-level `@ts-nocheck` from shared/API DTOs.
- `plugins/plugin-wallet/src/analytics/token-info/providers.ts`
  - Removed file-level `@ts-nocheck` and added a narrow `ActionResult.data`
    callback adapter.
  - Validation passed:
    `bun run --cwd plugins/plugin-wallet check` and focused analytics tests.
- `plugins/app-lifeops/src/lifeops/service-mixin-definitions.ts`
  - Removed file-level `@ts-nocheck`.
- `plugins/app-lifeops/src/lifeops/service-mixin-status.ts`
  - Removed file-level `@ts-nocheck` and fixed the stale `xCloud`
    reference.
- `plugins/app-lifeops/src/lifeops/service-mixin-runtime-delegation.test.ts`
  - Removed file-level `@ts-nocheck`.
  - Validation passed:
    app-lifeops build types, focused runtime-delegation test, and
    default-pack lint.

### Targeted suppression removals

Sources:

- `cloud-suppressions-fix.md`
- `vault-suppressions-fix.md`
- `app-core-electrobun-suppressions-fix.md`

- `cloud/packages/lib/stripe.ts`
  - Removed the `@ts-expect-error` around the pinned Stripe API version.
  - The pin is now checked against Stripe's generated API-version union before
    crossing the constructor config boundary.
- `cloud/packages/tests/unit/payment-requests-service.test.ts`
  - Removed invalid-provider and missing-specific-payer `@ts-expect-error`
    comments by routing deliberate malformed inputs through typed invalid-input
    helpers.
- `cloud/packages/tests/integration/db/message-router-service.test.ts`
  - Removed unknown-provider `@ts-expect-error` with a typed invalid send
    helper.
- `cloud/packages/tests/unit/oauth/secrets-adapter-utils.test.ts`
  - Removed generated-ID override `@ts-expect-error` with a typed invalid
    override helper.
- `packages/vault/test/{vault,pglite-vault,master-key}.test.ts`
  - Removed five runtime-validation `@ts-expect-error` comments.
  - Added `unknown`-typed test harnesses in
    `packages/vault/test/vitest-assertion-shim.ts` for malformed caller cases.
- `packages/app-core/platforms/electrobun/src/index.ts`
  - Removed Bun streaming `duplex` suppression with a local
    `RequestInit & { duplex: "half" }` type.
  - Removed Electrobun `icon` suppressions by routing BrowserWindow creation
    through `createElectrobunBrowserWindow`.
- `packages/app-core/platforms/electrobun/src/native/canvas.ts`
  - Removed Electrobun `partition` suppressions via the same local adapter.
- `packages/app-core/platforms/electrobun/src/electrobun-window-options.ts`
  - Added the local constructor adapter for runtime-supported `icon` and
    `partition` options missing from published Electrobun types.
- `packages/agent/src/runtime/conversation-compactor-runtime.ts`
  - Fixed the Electrobun typecheck blocker by preserving room metadata as core
    `Metadata` and keeping retained compaction history as `MetadataValue[]`
    instead of widening it through `Record<string, unknown>`.
- `cloud/apps/frontend/tsconfig.json`
  - Fixed the cloud Drizzle identity boundary by resolving `drizzle-orm` through
    `cloud/node_modules` rather than `plugins/plugin-sql/node_modules`, which
    symlinked into the root install.
- `packages/core/src/features/documents/url-ingest.ts`
  - Removed the Node/Web stream `@ts-expect-error` by typing the
    `Readable.toWeb()` boundary explicitly.
- `scripts/write-build-info.ts`
  - Removed the `.mjs` helper import suppression.
- `scripts/lib/repo-root.d.mts`
  - Added the NodeNext-compatible declaration file for
    `scripts/lib/repo-root.mjs`.
- `plugins/plugin-workflow/src/utils/clarification.ts`
  - Widened the guard boundary to `ReadonlyArray<unknown>` and narrowed legacy
    structured clarification payloads explicitly.
- `plugins/plugin-workflow/src/lib/workflow-clarification.ts`
  - Widened `applyResolutions()` to accept unknown runtime payloads and removed
    test-only malformed-input suppressions.
- `packages/app-core/test/benchmarks/action-selection*.ts`
  - Replaced unresolved dynamic import suppressions with explicit runtime URL
    imports/string specifiers.
- `packages/app-core/test/live-agent/telegram-connector.live.e2e.test.ts`
  - Replaced optional runtime cleanup suppression with a narrow boundary type.
- `packages/ui/src/onboarding/__tests__/flow.test.ts`
  - Replaced runtime guard `@ts-expect-error` probes with typed malformed-input
    helpers.
- `plugins/app-hyperliquid/__tests__/perpetual-market.test.ts`
  - Replaced fetch/handler suppressions with explicit runtime boundary typing.

Validation:

- `bun ./node_modules/typescript/lib/tsc.js --noEmit --project tsconfig.test.json`
  in `cloud`: passed after cloud test fixture fixes.
- Targeted cloud tests pass when run one file at a time. A combined Bun test
  process fails because mocked modules leak between Stripe route and adapter
  files, matching the repo's existing isolated-test pattern.
- `bun run --cwd packages/vault typecheck`: passed.
- `bun run --cwd packages/vault test`: passed, 9 files / 173 tests.
- `rg -n "@ts-expect-error" packages/app-core/platforms/electrobun/src`: no
  results.
- `bun run --cwd packages/agent typecheck`: passed.
- `bun run --cwd packages/agent test src/runtime/conversation-compactor-runtime.test.ts`:
  passed, 34 tests.
- `packages/app-core/platforms/electrobun/node_modules/.bin/tsc --noEmit -p packages/app-core/platforms/electrobun/tsconfig.json`:
  passed.
- `bun run --cwd cloud/apps/frontend typecheck`: passed after the Drizzle
  alias fix.
- `bun run --cwd plugins/plugin-workflow typecheck`: passed.
- `bun run --cwd plugins/plugin-workflow test:unit`: passed, 21 files / 271
  tests.
- `bun run --cwd plugins/plugin-workflow lint:check`: passed.
- `node --import tsx scripts/write-build-info.ts`: passed.
- `bun run --cwd packages/ui typecheck`: passed.
- `bun run --cwd packages/ui test src/onboarding/__tests__/flow.test.ts`:
  passed, 96 tests.
- `bun run --cwd packages/core typecheck`: passed.
- `bun run --cwd plugins/app-hyperliquid test -- __tests__/perpetual-market.test.ts`
  remains blocked before test collection by the existing `@node-rs/argon2`
  native binding load failure.

## Wave 1: Finish Validation Blockers

### 1. Knip execution and real findings

Owner files:

- `scripts/knip-workspaces.mjs`
- per-package `package.json` files reported by Knip
- `docs/audits/repo-hardening-2026-05-12/blocker-knip.md`

Current state:

- The native `@oxc-resolver` crash is avoided by making the Knip workspace
  wrapper prefer a Bun executable from `PATH` when launching the local Knip
  binary.
- A full root `bun run knip` is running and has reached real package findings.

TODO:

- Capture full Knip output.
- Split findings into:
  - unused dependencies that are truly removable,
  - unlisted dependencies that must be added,
  - false positives caused by dynamic imports, generators, or package exports,
  - package-boundary issues that need code movement before dependency changes.
- Apply manifest changes package-by-package, then rerun targeted Knip filters
  before rerunning the full sweep.

Validation:

- `bun run knip -- --filter <package>`
- `bun run knip`
- `bun run typecheck`
- package build/test for each manifest changed.

### 2. Cloud typecheck after suppression removals

Owner files:

- `cloud/packages/tests/unit/steward-sync.test.ts`
- `cloud/services/_smoke-mcp/tsconfig.json`
- any cloud package surfaced by the active `bun run --cwd cloud typecheck`.

TODO:

- Let the full cloud typecheck finish.
- If it fails, fix the first real typed blocker; do not reintroduce whole-file
  suppressions.
- Add smoke-harness typecheck to the cloud verification story or explicitly
  keep it as a standalone command because it is a separate Cloudflare Worker
  harness.

Validation:

- `bun run --cwd cloud typecheck`
- targeted cloud unit test already passed.

## Wave 2: File-Level Suppression Removal

### 1. app-lifeops service mixins

Source reports:

- `suppressions-any-fallbacks-plugins.md`
- `types-plugins-family.md`

Owner files:

- `plugins/app-lifeops/src/lifeops/service-mixin-*.ts`
- `plugins/app-lifeops/src/lifeops/service-mixin-runtime-delegation.test.ts`
- `plugins/app-lifeops/src/lifeops/service-mixin-core.ts`

Constraints:

- Keep one `ScheduledTask` primitive.
- Keep one scheduled task runner.
- Do not drive behavior from `promptInstructions` text.
- Do not import `plugin-health` internals into LifeOps.

TODO:

- Define one typed mixin base/helper in `service-mixin-core.ts`.
- Remove `@ts-nocheck` from one domain mixin at a time.
- Start with small, low-blast-radius mixins:
  - `service-mixin-definitions.ts`
  - `service-mixin-status.ts`
  - `service-mixin-google.ts`
  - `service-mixin-runtime-delegation.test.ts`
- Then move to behavior-heavy mixins:
  - scheduling/reminders
  - health/sleep/screentime
  - inbox/gmail/calendar/drive
  - payments/subscriptions
  - browser/workflows/x/discord/telegram/signal/whatsapp/imessage
- Replace broad `Record<string, unknown>` casts with named parsers for task
  input, connector payloads, and service responses.

Validation:

- `bun run --cwd plugins/app-lifeops lint:default-packs`
- `bun run --cwd plugins/app-lifeops build:types`
- `bun run --cwd plugins/app-lifeops test`
- focused scheduled-task runner tests.

### 2. plugin-wallet strict typing

Source reports:

- `suppressions-any-fallbacks-plugins.md`
- `types-plugins-family.md`

Owner files:

- `plugins/plugin-wallet/src/analytics/**`
- `plugins/plugin-wallet/src/lp/**`
- `plugins/plugin-wallet/src/chains/{evm,solana}/dex/**`

TODO:

- Remove `@ts-nocheck` by subsystem, not all at once:
  1. pure type files under `analytics/**/types.ts`;
  2. Birdeye/DexScreener API response DTOs and parsers;
  3. token-info provider registry;
  4. LP service interfaces and mocks;
  5. EVM DEX services;
  6. Solana DEX services.
- Replace financial `|| 0` and `|| ""` with parsed numeric/string results that
  distinguish unknown, zero, and invalid values.
- Replace `Promise.allSettled` silent drops in market-data fetches with
  partial-result status and provider error details.
- Type the Meteora DLMM import adapter instead of combining whole-file
  `@ts-nocheck` with local `@ts-expect-error`.

Validation:

- `bun run --cwd plugins/plugin-wallet check`
- `bun run --cwd plugins/plugin-wallet test`
- package build
- live/API tests only when explicitly gated with credentials.

### 3. plugin-local-ai strict typing

Source report: `suppressions-any-fallbacks-plugins.md`

Owner files:

- `plugins/plugin-local-ai/environment.ts`
- `plugins/plugin-local-ai/structured-output.ts`
- `plugins/plugin-local-ai/index.ts`
- `plugins/plugin-local-ai/utils/*.ts`

TODO:

- Remove `@ts-nocheck` from `environment.ts` and `structured-output.ts` first.
- Add local facade types for `@huggingface/transformers`,
  `node-llama-cpp`, TTS, transcribe, and vision modules.
- Replace definite assignment assertions in `index.ts` with a ready-state
  object or typed `assertEnvironmentReady()`.
- Normalize path/env config with explicit empty-vs-missing handling.
- Fail generation clearly when a selected model is not initialized instead of
  disabling repeat penalty silently.

Validation:

- `bun run --cwd plugins/plugin-local-ai typecheck`
- `bun run --cwd plugins/plugin-local-ai test`
- dependency-available smoke tests for tokenizer, embeddings, vision,
  transcription, and TTS.

## Wave 3: Type Contract Consolidation

### 1. core/shared duplicated public contracts

Source report: `types-core-family.md`

Owner files:

- `packages/core/src/contracts/wallet.ts`
- `packages/shared/src/contracts/wallet.ts`
- `packages/core/src/contracts/onboarding.ts`
- `packages/shared/src/contracts/onboarding.ts`
- `packages/core/src/contracts/service-routing.ts`
- `packages/shared/src/contracts/service-routing.ts`
- `packages/core/src/contracts/cloud-topology.ts`
- `packages/shared/src/contracts/cloud-topology.ts`
- `packages/core/src/runtime-env.ts`
- `packages/shared/src/runtime-env.ts`

TODO:

- Choose one owner per contract family and replace mirrors with type/value
  re-exports where module side effects allow.
- Resolve `TradePermissionMode` drift first; `agent`/`ui` include `disabled`
  while `core`/`shared` do not.
- Add compatibility aliases before removing public names.

Validation:

- `bun run --cwd packages/core typecheck`
- `bun run --cwd packages/shared typecheck`
- `bun run --cwd packages/ui typecheck`
- wallet/trade safety tests.

### 2. agent-route DTOs and UI client mirrors

Source report: `types-core-family.md`

Owner files:

- `packages/agent/src/api/**`
- `packages/agent/src/triggers/types.ts`
- `packages/ui/src/api/client-types-*.ts`
- `packages/ui/src/api/agent-client-type-shim.ts`

TODO:

- Extract pure type-only DTO modules for:
  - triggers,
  - conversations,
  - memory search/browse,
  - workbench tasks,
  - plugin parameters,
  - model provider records,
  - permission card/action block payloads.
- Make the UI import those pure DTOs instead of copying shapes.
- Keep route implementation modules out of Vite/browser imports.

Validation:

- `bun run --cwd packages/agent typecheck`
- `bun run --cwd packages/ui typecheck`
- route tests and UI API client tests.

### 3. LifeOps/Health public contracts

Source report: `types-plugins-family.md`

Owner files:

- `plugins/app-lifeops/src/lifeops/scheduled-task/types.ts`
- `plugins/app-lifeops/src/lifeops/wave1-types.ts`
- `plugins/app-lifeops/src/default-packs/contract-stubs.ts`
- `plugins/plugin-health/src/default-packs/contract-stubs.ts`
- `plugins/plugin-health/src/connectors/contract-stubs.ts`
- `plugins/plugin-health/src/contracts/lifeops.ts`
- `packages/shared/src/contracts/lifeops.ts`

TODO:

- Keep runtime `ScheduledTask` owner in app-lifeops.
- Extract neutral public pack/connector/registry contracts so Health imports
  public types, not LifeOps internals.
- Decide whether `executionProfile` is public. Update all copies or keep it
  runtime-internal with an explicit projection type.
- Remove Wave-1 stub imports after replacement.
- Reconcile shared/health `lifeops.ts` drift around Apple Calendar and open bus
  families.

Validation:

- LifeOps default-pack lint
- LifeOps/Health package typechecks
- connector registry tests.

### 4. local-inference contracts

Source report: `types-core-family.md`

Owner files:

- `packages/shared/src/local-inference/index.ts`
- `packages/app-core/src/services/local-inference/**`
- `packages/ui/src/services/local-inference/**`

TODO:

- Finish migration to `@elizaos/shared/local-inference` as the canonical
  server/UI wire contract.
- Resolve `DeviceOutbound` drift: app-core supports `cacheKey`; UI omits it.
- Keep host RAM admission logic server-side; UI should import only wire types,
  not duplicate behavior.

Validation:

- app-core local inference tests
- UI typecheck
- app-core typecheck.

### 5. cloud/API/SDK DTOs

Source reports:

- `types-examples-benchmarks-cloud-inference.md`
- `suppressions-any-fallbacks-core.md`

Owner files:

- `cloud/apps/api/**`
- `cloud/packages/sdk/src/public-routes.ts`
- `cloud/packages/sdk/scripts/generate-public-routes.mjs`
- `cloud/packages/ui/**`
- `cloud/packages/lib/**`

TODO:

- Update public-route generator to avoid top-level `any` suppression.
- Use generated or shared DTOs for SDK request/response surfaces.
- Consolidate repeated route `RouteParams`, `JsonValue`, `JsonObject`, and
  common chat/health DTOs where they are actual public contracts.
- Keep Storybook/test-local aliases local.

Validation:

- `bun run --cwd cloud typecheck`
- SDK typecheck/tests
- route generator/check command if present.

## Wave 4: Fallback and Defensive Programming Hardening

### 1. Security/trust and permission flows

Source report: `suppressions-any-fallbacks-core.md`

Owner files:

- `packages/core/src/features/trust/**`
- `packages/core/src/features/plugin-manager/security.ts`
- `packages/core/src/features/advanced-capabilities/actions/message.ts`

TODO:

- Replace `trust || 0`, `allowed || false`, and scoring divide fallbacks with
  finite-number and schema validation.
- Return typed denial/error results for lookup failures.
- Parse action parameters before use.

Validation:

- trust/security tests
- action routing/message action tests.

### 2. agent import/export and route request parsing

Source report: `suppressions-any-fallbacks-core.md`

Owner files:

- `packages/agent/src/services/agent-export.ts`
- `packages/agent/src/api/agent-status-routes.ts`
- `packages/agent/src/services/client-chat-sender.ts`
- `packages/agent/src/services/registry-client-app-meta.ts`

TODO:

- Reject missing IDs instead of `remap(id ?? "") as UUID`.
- Parse required route body fields as non-empty strings.
- Distinguish absent chat text from intentional empty text.
- Preserve registry metadata parse diagnostics.

Validation:

- agent export/import tests
- route tests
- registry client tests.

### 3. app-core sensitive requests and target sources

Source report: `suppressions-any-fallbacks-core.md`

Owner files:

- `packages/app-core/src/services/discord-target-source.ts`
- `packages/app-core/src/api/database-rows-compat-routes.ts`
- `packages/app-core/src/services/sensitive-requests/*.ts`
- `packages/app-core/src/services/steward-credentials.ts`

TODO:

- Validate Discord API JSON instead of casting to arrays.
- Return typed top-level errors for Discord credential/network failures.
- Validate query params and count-row shape in database rows route.
- Parse payment/sensitive request contexts at adapter boundaries.
- Normalize Steward credential sources with explicit empty vs missing values.

Validation:

- app-core route/service tests
- sensitive-request tests.

### 4. UI state and bridge error surfaces

Source report: `suppressions-any-fallbacks-core.md`

Owner files:

- `packages/ui/src/state/persistence.ts`
- `packages/ui/src/state/useChatSend.ts`
- `packages/ui/src/bridge/native-plugins.ts`
- `packages/ui/src/widgets/registry.ts`
- `packages/ui/src/platform/desktop-permissions-client.ts`

TODO:

- Introduce `readPersisted<T>()` result union for storage.
- Centralize chat send/stream/tool-call error classification.
- Replace generic `{}` native-plugin fallback with a missing-plugin proxy or
  required-plugin accessor.
- Remove widget registry non-null assertion and throw descriptive registry
  errors.
- Return source-tagged permission state.

Validation:

- UI typecheck
- UI unit tests
- Playwright smoke where relevant.

## Wave 5: Generated, Artifact, and Repo Hygiene

Source report:

- `non-ts-suppressions-artifacts.md`
- prior cleanup reports under `docs/audits/repo-cleanup-2026-05-11/`

Known candidates already identified:

- generated inference binaries under `packages/inference/verify/`
- generated inference benchmark/result JSONs
- Cloudflare smoke-harness `dist/` output, already ignored inside the harness
- root/generated markdown optimization reports that are not canonical docs
- benchmark output JSONs under `packages/benchmarks/benchmark_results/latest`
- Safari example generated project files, if they are not source templates

TODO:

- Use `git ls-files` before deleting any candidate.
- Delete tracked build outputs/binaries that are reproducible.
- Add or refine `.gitignore` rules for regenerated outputs.
- Keep source templates and hand-authored fixtures; delete generated copies.
- Exclude vendored/upstream submodules such as `packages/inference/llama.cpp`
  from repo-local cleanup unless a file is explicitly elizaOS-owned.

Validation:

- `git status --short`
- `git diff --check`
- package builds for any source-template folder touched.

## Parallel implementation ownership

Suggested worker split:

- Worker A: Knip manifest fixes only.
- Worker B: cloud SDK/public-routes generator and cloud `@ts-nocheck` cleanup.
- Worker C: plugin-local-ai suppressions only.
- Worker D: plugin-wallet analytics DTOs only.
- Worker E: plugin-wallet LP/DEX service typing only.
- Worker F: LifeOps mixin base and first 3 small mixins only.
- Worker G: core/shared contract re-export plan and `TradePermissionMode`.
- Worker H: agent/UI DTO extraction for triggers and memory APIs.
- Worker I: app-core sensitive requests/Discord target source hardening.
- Worker J: UI persistence/native bridge result unions.
- Worker K: non-TS/generated artifacts cleanup.

Each worker must update this ledger with completed items, changed files,
validation commands, and remaining blockers before handing off.
