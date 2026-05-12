# Phase 2 Deep Dive: Knip, Madge, Barrels, Types

Date: 2026-05-11

Worker: Phase 2 deep-dive worker 5

Scope: tooling failures and consolidation candidates only. No source, config, or test files were edited. This report is the only file created by this worker.

## Executive Summary

The cleanup program should not proceed with deletion-oriented work from Knip yet. Knip is blocked before analysis by the local `oxc-resolver` native binding load failure, so every Knip deletion signal is either stale or absent.

Madge and the package-barrel audit are actionable. Madge currently finds exactly 4 two-file cycles. The package-barrel check currently fails on 22 workspace package subpath references, 266 published package subpath exports, and 630 literal "re-export" markers.

The highest-confidence type consolidation is still `packages/ui/src/types/index.ts` and `packages/shared/src/types/index.ts`: they are byte-identical 723-line files. Several other type families are real consolidation candidates, but some have semantic drift and must not be blindly re-exported by name.

## Commands Run

| Command | Exit | Relevant output |
| --- | ---: | --- |
| `git status --short` | 0 | Existing unrelated worktree state included `m packages/inference/llama.cpp` and untracked deep-dive docs. Left untouched. |
| `./node_modules/.bin/knip --version` | 1 | Fails before version output with `Cannot find native binding` from `oxc-resolver@11.19.1`. |
| `codesign --verify --verbose=4 node_modules/.bun/@oxc-resolver+binding-darwin-arm64@11.19.1/node_modules/@oxc-resolver/binding-darwin-arm64/resolver.darwin-arm64.node` | 0 | Binding is "valid on disk" and satisfies its designated requirement. |
| `codesign -dv --verbose=4 .../resolver.darwin-arm64.node` | 0 | `Signature=adhoc`, `TeamIdentifier=not set`. Node still rejects it at `dlopen` because mapped file and process Team IDs differ. |
| `node scripts/knip-workspaces.mjs --list \| wc -l` | 0 | 199 matching workspace packages. |
| `/Users/shawwalters/.bun/bin/bunx madge --circular --extensions ts,tsx --exclude '(dist\|build\|node_modules\|.turbo\|coverage\|.claude\|packages/inference/llama.cpp\|packages/app-core/platforms/electrobun/build)' packages plugins test` | 1 | Processed 7,715 files in 1m 4.8s, 143 warnings, 4 cycles. |
| `node scripts/audit-package-barrels.mjs --check` | 1 | 214 packages, 10,617 source files, 22 subpath refs, 266 subpath exports, 630 re-export markers. |
| Read-only AST probe mirroring `scripts/type-audit.mjs` collection/extraction | 0 | 6,341 TS files, 16,593 type definitions, 2,696 duplicate names. |
| `cmp -s packages/ui/src/types/index.ts packages/shared/src/types/index.ts; wc -l ...` | 0 | Files are byte-identical, 723 lines each. |

The full structural-overlap count was not rerun in-place because `scripts/type-audit.mjs` writes fixed files under `scripts/`. The Phase 2 research report recorded 102,503 structural overlaps: 7,391 identical, 31,073 subset/superset, and 64,039 partial.

## Blocker 1: Knip Cannot Run

Root cause is environmental/native-binding, not repository findings.

Current local failure:

- Loader: `node_modules/.bun/oxc-resolver@11.19.1/node_modules/oxc-resolver/index.js`
- Native binding: `@oxc-resolver/binding-darwin-arm64/resolver.darwin-arm64.node`
- Error: `Cannot find native binding`
- Cause: `ERR_DLOPEN_FAILED`
- macOS detail: `code signature ... not valid for use in process: mapping process and mapped file (non-platform) have different Team IDs`
- Codesign inspection says the file is ad-hoc signed with no Team ID, which explains why it can verify on disk while still being rejected by the process loader.

Safe next actions:

1. Repair the local binding before using Knip results. Conservative options: clean reinstall dependencies with the same Bun version, remove only the affected `oxc-resolver` binding package from `node_modules/.bun` and reinstall, or run Knip on CI/Linux where the binding loads.
2. After Knip runs, treat output as triage, not deletion authority. This repo has framework entrypoints, generated specs, plugin side-effect registration, native stubs, and route files that Knip can misclassify without package-specific config.
3. Add an environment smoke gate before Knip analysis:

```bash
./node_modules/.bin/knip --version
node scripts/knip-workspaces.mjs --list
```

Only when the first command exits 0 should cleanup workers run:

```bash
/Users/shawwalters/.bun/bin/bun run knip -- --no-exit-code
/Users/shawwalters/.bun/bin/bun run knip:strict -- --filter <package>
```

Guardrail: do not delete files from `reports/porting/2026-05-09-baseline/knip.txt` or the historical cleanup ledger until current Knip runs with package owners reviewing the scoped findings.

## Blocker 2: Madge Cycles

Madge found four current cycles. All are small and should be fixed before broad barrel/type consolidation because they distort dependency direction.

| Priority | Cycle | Exact edge | Owner | Safe fix shape | Validation |
| ---: | --- | --- | --- | --- | --- |
| 1 | LifeOps scheduled-task service/runtime-wiring | `plugins/app-lifeops/src/lifeops/scheduled-task/service.ts:27-30` imports `createRuntimeScheduledTaskRunner` from `runtime-wiring.ts`; `runtime-wiring.ts:362-365` re-exports `getScheduledTaskRunner` and `ScheduledTaskRunnerService` from `service.ts`. | LifeOps | Remove the service-aware re-export from `runtime-wiring.ts`. Put service exports in the scheduled-task package barrel or a neutral module. Preserve one `ScheduledTask` primitive and the cached runner service. | Madge command above; LifeOps scheduled-task tests; `bun run --cwd plugins/app-lifeops test`. |
| 2 | UI branding React split defeated | `packages/ui/src/config/branding.ts:97` re-exports `BrandingContext` and `useBranding`; `branding-react.tsx:7-8` imports `BrandingConfig` and `DEFAULT_BRANDING` from `branding.ts`. | UI/shared config | Keep `branding.ts` node-safe. Prefer a third `branding-base.ts` for `BrandingConfig`, `DEFAULT_BRANDING`, and helpers, with React context importing base. Then export React hooks only from a React barrel. | Madge command; `bun run --cwd packages/ui typecheck`; node-side import smoke for `@elizaos/shared`. |
| 3 | Computer-use route registration side effect | `plugins/plugin-computeruse/src/index.ts:155` exports `*` from `register-routes.ts`; `register-routes.ts:3-5` registers a loader that dynamically imports `./index.js`. | Computeruse plugin | Do not re-export `register-routes.ts` from the runtime public barrel. Make route registration a side-effect entrypoint used only by the app route loader. | Madge command; plugin typecheck; route loader smoke. |
| 4 | GitHub route registration side effect | `plugins/plugin-github/src/index.ts:114` exports `*` from `register-routes.ts`; `register-routes.ts:3-5` registers a loader that dynamically imports `./index.js`. | GitHub plugin | Same fix shape as computeruse. Keep plugin runtime exports separate from app route registration side effects. | Madge command; plugin typecheck; GitHub route smoke. |

Guardrail: for the LifeOps cycle, do not introduce a second runner, a second task primitive, or behavior based on `promptInstructions` content. The fix should only change export direction.

## Blocker 3: Package-Barrel Gate

`scripts/audit-package-barrels.mjs --check` currently fails because it exits non-zero when any package subpath reference or published subpath export exists.

Current counts:

- Workspace packages: 214
- Source files scanned: 10,617
- Workspace package subpath references: 22
- Published package subpath exports: 266
- Literal re-export markers: 630

### Current Subpath References

| Group | Exact refs | Recommended action |
| --- | --- | --- |
| `@elizaos/ui/api/client-types-cloud` | `plugins/app-task-coordinator/src/CodingAgentTasksPanel.tsx:1-5`, `PtyConsoleBase.tsx:1`, `PtyConsoleDrawer.tsx:1`, `PtyConsoleSidePanel.tsx:1`, plus matching `.d.ts` files. Symbols include `CodingAgentSession`, `CodingAgentTaskThread`, `CodingAgentTaskThreadDetail`, defined in `packages/ui/src/api/client-types-cloud.ts:940`, `985`, `1102`. | These are already reachable through `@elizaos/ui` because `packages/ui/src/api/client-types.ts:9` exports `client-types-cloud`, `client.ts:134` exports `client-types`, and `src/index.ts:6` exports `api`. Migrate source imports to root `@elizaos/ui`; handle committed `.d.ts` files via their generator/build owner, not by hand if generated. |
| `@elizaos/ui/onboarding-config` | `packages/app-core/scripts/playwright-ui-live-stack.ts:13`, `packages/app-core/test/app/memory-relationships.real.e2e.test.ts:17`, `packages/app-core/test/app/onboarding-companion.live.e2e.test.ts:22`. | If `buildOnboardingRuntimeConfig` is intended public API, export it from the UI root and use `@elizaos/ui`. If it is test-only, move test helpers to an internal test-support entrypoint and explicitly allowlist it. |
| `@elizaos/ui/config/app-config` | `packages/app/src/app-config.ts:1`, `packages/app/vite.config.ts:16`. | `resolveAppBranding` is a stable app config helper. Export from root UI or a shared config package, then migrate imports. |
| `@elizaos/ui/styles` | `packages/app/src/main.tsx:2`, `packages/ui/src/styles.ts` is the style entrypoint. | This is a deliberate side-effect CSS entrypoint. Do not force it through root `@elizaos/ui`. Either mark `./styles` as an approved public subpath or split the barrel gate into "code subpaths fail" and "asset/style subpaths allowed". |
| `@elizaos/ui/navigation` | `packages/app-core/src/api/dev-route-catalog.test.ts:3` imports `TAB_PATHS`. | If `TAB_PATHS` is public, export from root UI. Otherwise make the test own a local expected route list. |
| `@elizaos/agent/...` | `packages/agent/src/config/plugin-auto-enable.ts:1-17` is itself a compatibility subpath re-export; `packages/agent/src/services/permissions/register-probers.ts:13` documents the subpath; `packages/app-core/platforms/electrobun/src/native/permissions.ts:8` imports `ALL_PROBERS` from a deep agent subpath. | Keep the compatibility shim until the frozen packaged app-core reference is republished. Move permission prober access behind an approved root export or shared/native permissions contract before removing subpaths. |
| `@elizaos/app-core/services/local-inference/*` | `scripts/verify-phone-download.mjs` imports catalog/downloader through subpaths. | Either expose a root app-core verification helper or keep a documented script-only exception. The script comments say mobile runtimes re-import the downloader through `@elizaos/app-core`, so package owner review is required. |
| `@elizaos/app-lifeops/seed-routine-migrator` | `plugins/app-lifeops/scripts/migrate-seed-routines.mjs:66-70` imports the migrator through package entrypoint. | This is an ops script entrypoint. Either export the migrator from root `@elizaos/app-lifeops` or allowlist the script-only subpath with an expiry. |
| `@elizaos/core/testing` | `packages/examples/code/src/__tests__/test-utils.ts:15-20`. | Keep as an approved test-support subpath or export test helpers from root only in test builds. Do not mix runtime root surface with test-only helpers without owner sign-off. |
| `@elizaos/shared/dev-settings-figlet-heading` | `packages/app-core/scripts/lib/orchestrator-desktop-dev-banner.mjs:5`. | Export from root shared if it is a stable dev helper, or make it script-local. |

### Published Export Hotspots

The biggest package export surfaces are:

- `@elizaos/ui` (`packages/ui/package.json:39-54`): `./styles`, `./api/client-types-cloud`, `./config/app-config`, `./onboarding-config`, CSS patterns, and wildcard `./*`.
- `@elizaos/core` (`packages/core/package.json:28-80`): root conditional export, `./node`, `./browser`, `./roles`, `./testing`, `./services/*`, CSS pattern, and wildcard `./*`.
- `@elizaos/shared` (`packages/shared/package.json:40-77`): explicit dev/config/runtime subpaths, CSS pattern, and wildcard `./*`.
- `@elizaos/agent` (`packages/agent/package.json:50-90`): compatibility/config/service/security subpaths, CSS pattern, and wildcard `./*`.

Safe implementation order for barrel cleanup:

1. Split the audit policy before changing packages: approved style/assets/test-support/platform subpaths should not be mixed with accidental source deep imports.
2. Migrate current source references that are already root-reachable (`@elizaos/ui/api/client-types-cloud`, most `@elizaos/ui/config/app-config`, likely `@elizaos/ui/navigation`).
3. Decide explicit allowlist entries for intentional subpaths (`@elizaos/ui/styles`, `@elizaos/core/testing`, `@elizaos/core/node`, `@elizaos/core/browser`) before removing wildcard exports.
4. Remove broad wildcard `./*` exports last. They hide accidental API growth and make the gate noisy, but removing them first is high-risk for downstream consumers.
5. Re-run package builds and package dry-runs for changed owners before tightening the check gate.

Validation commands:

```bash
node scripts/audit-package-barrels.mjs --check
bun run --cwd packages/ui typecheck
bun run --cwd packages/app-core typecheck
bun run --cwd packages/agent typecheck
bun run --cwd packages/core typecheck
bun run --cwd packages/shared typecheck
```

Guardrail: do not remove compatibility exports documented as protecting frozen published bundles, especially `packages/agent/src/config/plugin-auto-enable.ts:1-17`, until the downstream packaged bundle is republished and verified.

## Type Consolidation Candidates

The read-only AST probe confirmed the same inventory size as the Phase 2 type-audit output:

- 6,341 TypeScript files
- 16,593 type definitions
- 2,696 duplicate names

Top duplicate names include `ActionDoc` and `ProviderDoc` (26 each), `JsonValue` (22), `ElizaClient` (16), `CredentialProviderResult` (15), `JsonObject` (14), `ExtendedMessageConnectorRegistration` (12), `JsonPrimitive` (11), and `TradePermissionMode` (10).

### Candidate A: UI/Shared Type Mirror

Evidence:

- `cmp` exit 0 for `packages/ui/src/types/index.ts` vs `packages/shared/src/types/index.ts`.
- Both files are 723 lines.
- `packages/ui/src/index.ts:38` exports `./types`.
- `packages/shared/src/index.ts:233` exports `./types/index.js`.
- High-value duplicated symbols include `ExistingElizaInstallInfo`, `ChannelsStatusSnapshot`, channel/provider status types, `ConfigUiHint`, gateway/session/cron/skill status types, `HealthSnapshot`, and `LogLevel`.

Safe fix shape:

1. Choose `@elizaos/shared` as canonical owner because these are cross-runtime contracts and shared already exports them.
2. Convert `packages/ui/src/types/index.ts` to a compatibility type re-export from `@elizaos/shared` or from a relative shared source only if the build graph supports it.
3. Keep `packages/ui` root exports stable so existing UI consumers do not break.
4. Validate with UI, shared, app-core, and app typechecks.

Guardrail: check package build direction before using a workspace package import from `packages/ui/src/types/index.ts`; avoid creating a UI-to-shared cycle through shared imports that already reference UI.

### Candidate B: Generated Action/Provider Docs

Evidence:

- `ActionDoc`: 26 generated definitions.
- `ProviderDoc`: 26 generated definitions.
- Core generated shape: `packages/core/src/generated/action-docs.ts:52-70`.
- Plugin generated shapes: for example `plugins/plugin-discord/generated/specs/specs.ts:6-21` and `plugins/plugin-anthropic/generated/specs/specs.ts:6-19`.
- Core generator template is `packages/prompts/scripts/generate-action-docs.js:504-589`.
- Plugin files say `DO NOT EDIT - Generated from prompts/specs/**`.

Safe fix shape:

1. Do not hand-edit generated `generated/specs/specs.ts` files.
2. Add a canonical generated-doc type module, likely under `@elizaos/core` or `@elizaos/prompts`, if plugin package boundaries allow it.
3. Update generator templates to import or emit `satisfies` against the canonical type instead of redefining `ActionDoc` and `ProviderDoc`.
4. Regenerate all generated specs and run prompt/spec audits.

Guardrail: some generated shapes include `descriptionCompressed`, some include both `descriptionCompressed` and `compressedDescription`, and some have only the older minimal shape. Preserve runtime fallback behavior in `packages/core/src/action-docs.ts`.

### Candidate C: JSON Primitive Aliases

Evidence:

- `JsonValue`: 22 definitions.
- `JsonObject`: 14 definitions.
- `JsonPrimitive`: 11 definitions.
- Canonical-looking core primitive exists at `packages/core/src/types/primitives.ts:4-15` and is exported from core root variants.
- Copies exist in feature packages and plugins, for example `packages/core/src/features/advanced-capabilities/experience/types.ts:5-10`, `plugins/plugin-local-storage/src/types.ts:4-21`, `packages/native-plugins/gateway/src/definitions.ts:3-7`, `plugins/plugin-elizacloud/src/utils/cloud-sdk/types.ts:25-30`, and `plugins/plugin-agent-orchestrator/src/api/route-utils.ts:7-13`.

Safe fix shape:

1. Use `@elizaos/core` primitive aliases where packages already depend on core.
2. For native/plugin packages that intentionally avoid core, either leave local aliases or introduce a small shared contract package with no runtime pull.
3. Do not force every JSON alias into one dependency if that worsens package layering.

Guardrail: `plugins/plugin-elizacloud/src/utils/cloud-sdk/types.ts:28-30` allows `undefined` values in `JsonObject`; the core alias does not. That is semantic drift and needs owner review.

### Candidate D: Workflow Credential Provider Result

Evidence:

- `CredentialProviderResult`: 15 definitions.
- Canonical-looking workflow type is `plugins/plugin-workflow/src/types/index.ts:277-280`.
- Many connector plugins inline the same shape with comments like `Inlined to avoid adding @elizaos/plugin-workflow as a compile-time dependency`, for example `plugins/plugin-slack/src/workflow-credential-provider.ts:3-9` and `plugins/plugin-elizacloud/src/services/cloud-credential-provider.ts:37-44`.

Safe fix shape:

1. Do not make every connector depend on `@elizaos/plugin-workflow`.
2. Move the duck-typed service constant/result shape to a neutral shared connector contract, or keep local copies with a focused conformance test.
3. Once a neutral contract exists, migrate providers in batches by connector family.

Guardrail: preserving optional workflow dependency is more important than eliminating all duplicate aliases.

### Candidate E: Extended Message Connector Hooks

Evidence:

- `ExtendedMessageConnectorRegistration`: 12 definitions.
- `AdditiveMessageConnectorHooks`: 8 definitions.
- Examples include Discord and Slack: `plugins/plugin-discord/service.ts:220-240` and `plugins/plugin-slack/src/service.ts:75-95`.
- The exact optional hook set differs by connector: Slack/Discord include server listing and mutation handlers; lighter connectors only define fetch/search/user lookup subsets.

Safe fix shape:

1. Define a shared additive hook contract with optional capabilities.
2. Let each connector provide partial implementations.
3. Add conformance tests around registration and handler invocation.

Guardrail: do not collapse to the widest connector type if it implies unsupported capabilities for lighter connectors.

### Candidate F: Trade Permission Mode

Evidence:

- `TradePermissionMode`: 10 definitions.
- Core/shared/wallet contract versions omit `"disabled"`: `packages/core/src/contracts/wallet.ts:295-298`, `packages/shared/src/contracts/wallet.ts:467-470`, `plugins/plugin-wallet/src/lib/server-wallet-trade.ts:147-150`.
- Agent/UI/steward versions include `"disabled"`: `packages/agent/src/api/trade-safety.ts:42-46`, `packages/ui/src/api/client-types-core.ts:74-78`, `plugins/app-steward/src/api/trade-safety.ts:42-46`.

Safe fix shape:

1. Decide whether `"disabled"` is a valid persisted/config/API mode or only a UI/API safety state.
2. Update the canonical wallet/trade contract first.
3. Then re-export/import into agent, UI, steward, and wallet route code.

Guardrail: this is not an identical duplicate. Blind unification could either make disabled mode disappear from API clients or permit it in execution paths that currently reject it.

### Candidate G: ElizaClient Augmentations

Evidence:

- `ElizaClient`: 16 interface/class/augmentation definitions.
- `packages/ui/src/api/client.ts:7-10` documents that domain methods are declaration-merged and prototype-augmented across companion files.
- Examples include `client-agent.ts`, `client-chat.ts`, `client-cloud.ts`, `client-wallet.ts`, plus app plugin augmentations such as app-lifeops, app-polymarket, and app-hyperliquid.

Safe fix shape:

1. Treat this as intentional until UI/API owners say otherwise.
2. If reducing duplication, split generated/declared domain client interfaces by API area and compose them into one exported client type.
3. Preserve module augmentation behavior for app plugins.

Guardrail: do not collapse these definitions as ordinary duplicates; they are likely part of the extension mechanism.

## Recommended Implementation Order

1. Fix the `oxc-resolver`/Knip environment and add a Knip smoke check. This unblocks reliable dead-code triage.
2. Fix the four Madge cycles. They are small, low-blast-radius dependency-direction issues and reduce noise for later barrel/type work.
3. Convert `packages/ui/src/types/index.ts` to shared-backed exports after confirming package build direction. This is the safest large duplicate win.
4. Split the barrel audit policy into prohibited source deep imports versus approved style/test/platform entrypoints.
5. Migrate the 22 current subpath references in owner-reviewed batches.
6. Remove or narrow wildcard package exports only after all current source references are gone and package dry-runs pass.
7. Move generated `ActionDoc`/`ProviderDoc` duplication into generator templates.
8. Tackle semantic type families (`TradePermissionMode`, JSON aliases, credential providers, connector hooks) with owner-specific contract decisions and tests.

## Validation Checklist

After each implementation batch:

```bash
/Users/shawwalters/.bun/bin/bunx madge --circular --extensions ts,tsx --exclude '(dist|build|node_modules|.turbo|coverage|.claude|packages/inference/llama.cpp|packages/app-core/platforms/electrobun/build)' packages plugins test
node scripts/audit-package-barrels.mjs --check
bun run typecheck
```

For package-specific batches:

```bash
bun run --cwd packages/ui typecheck
bun run --cwd packages/shared typecheck
bun run --cwd packages/core typecheck
bun run --cwd packages/agent typecheck
bun run --cwd packages/app-core typecheck
bun run --cwd plugins/app-lifeops test
```

For type-audit integration, first change `scripts/type-audit.mjs` to accept an explicit output path or stdout-only mode. Do not run it in normal validation while it writes fixed `scripts/type-audit-report.md` and `.json` outputs.

## Proceed / Do Not Proceed

Proceed now:

- Madge cycle fixes.
- UI/shared byte-identical type consolidation after package-boundary check.
- Barrel policy split and source import migrations.

Do not proceed yet:

- Knip-driven deletion.
- Removal of wildcard package exports.
- Blind consolidation of same-name types with semantic drift.
- Hand edits to generated specs.
