# Runtime/domain package cleanup audit dry run

Date: 2026-05-13

Scope:

- `packages/core`
- `packages/shared`
- `packages/skills`
- `packages/workflows`
- `packages/prompts`
- `packages/scenario-runner`
- `packages/scenario-schema`
- `packages/vault`

This was a research-only audit. No source files were edited or deleted. The only intended write is this report.

Concurrent-work note: the worktree already had unrelated edits in `packages/core/src/__tests__/message-runtime-stage1.test.ts`, `packages/core/src/__tests__/planner-happy-path.test.ts`, `packages/core/src/__tests__/tiered-action-surface.test.ts`, `packages/core/src/runtime/__tests__/message-handler-output.test.ts`, `packages/core/src/runtime/__tests__/message-handler.test.ts`, `packages/core/src/runtime/__tests__/planner-loop.test.ts`, `packages/core/src/runtime/message-handler.ts`, `packages/core/src/runtime/planner-loop.ts`, and `packages/core/src/services/message.ts`. This audit did not touch them.

## Method

- Inventoried package files, package metadata, tsconfig/vitest config, ignored/generated directories, and large local artifacts.
- Searched for package-boundary imports, `.ts` extension imports, shims, generated files, legacy/back-compat/fallback code, and public barrel exports.
- Checked ignored status for local build/cache artifacts with `git check-ignore`.
- Reviewed representative source around the highest-risk findings.

## Executive summary

The target packages are mostly coherent, but cleanup should be staged rather than mechanical. The largest risks are public API churn from broad barrels in `@elizaos/core` and `@elizaos/shared`, stale or generated artifacts living in source-adjacent paths, and boundary leaks where domain packages reach into runtime packages or plugin test helpers.

Recommended order:

1. Add export and package-content snapshots before moving exports or deleting shims.
2. Normalize package metadata versions and workspace dependency ranges.
3. Clean ignored local artifacts from developer worktrees and ensure they are not required by builds.
4. Split runtime-only helpers out of `@elizaos/shared` or formalize that `shared` is runtime-coupled.
5. Replace scenario-runner shims/direct plugin-test imports with a narrow public scenario/lifeops contract.
6. Consolidate generated prompt/spec outputs around one generator and one tracked source-of-truth policy.

## Package inventory observations

| Package | Shape | Main concerns |
| --- | --- | --- |
| `packages/core` | Large runtime package; `src/runtime.ts` alone is about 8,870 lines; broad node/browser barrels. | Barrel API breadth, generated docs in source, legacy compatibility shims, duplicated/inlined helpers to avoid `shared` dependency, ignored `dist` dominating local package size. |
| `packages/shared` | Shared contracts/config/utilities; depends on `@elizaos/core`. | Not truly dependency-light; exports test-support from public barrel; local generated `.js` and `.d.ts.map` artifacts in `src`; app-core React type path coupling. |
| `packages/skills` | Loader/formatter plus bundled skill content under `skills/`. | Runtime dependency on `@elizaos/core` just for state-dir resolution; bundled scripts in skills are intentionally packaged but should be reviewed as executable surface. |
| `packages/workflows` | Single-file, mostly type-only package. | `files` includes `src`, and the smoke test imports `../src/index.ts`, but package exports point at `dist`; confirm this is intentional for consumers. |
| `packages/prompts` | Source TS prompt templates plus specs/generators. | `main` and `types` point to `src/index.ts`; stale ignored `dist/python` and `dist/rust` artifacts reference the old `.txt` layout; generated specs/docs split across prompts/core. |
| `packages/scenario-runner` | CLI/runtime scenario executor. | Compiles around app-lifeops with shims; imports a plugin test helper by relative path; duplicate tsconfig path keys; tracked `src/*.d.ts.map` artifact. |
| `packages/scenario-schema` | Tiny hand-authored JS/DTS schema package. | Static JS/DTS pair has no build/test script; strict final-check keys and TS union must be kept manually synchronized. |
| `packages/vault` | Focused vault implementation with tests. | Generally clean; some type-file split could be simplified; public index exports testing helpers; doc typo in `CreateVaultOptions` state-dir order. |

## Findings and proposed TODOs

### P1: `@elizaos/shared` is not a low-level shared package

Paths:

- `packages/shared/package.json`
- `packages/shared/src/connectors.ts`
- `packages/shared/src/recent-messages-state.ts`
- `packages/shared/src/utils/character-message-examples.ts`
- `packages/shared/src/utils/sql-compat.ts`
- `packages/shared/src/awareness/registry.ts`
- `packages/shared/src/contracts/apps.ts`
- `packages/shared/src/contracts/awareness.ts`
- `packages/shared/src/config/types.*.ts`
- `packages/shared/src/elizacloud/server-cloud-tts.ts`
- `packages/shared/src/local-inference/paths.ts`

Rationale:

`@elizaos/shared` imports many `@elizaos/core` runtime types and functions, and its `package.json` pins `@elizaos/core` to `2.0.0-alpha.537` while the package itself is `2.0.0-beta.2`. That makes `shared` a runtime-adjacent package rather than a dependency-light shared contract layer. It also increases cycle pressure: core comments explicitly inline shared utilities because core does not depend on shared.

Risk:

Medium-high. Moving these symbols could affect app/plugin consumers that treat `@elizaos/shared` as the stable contract package. Changing the dependency relationship without snapshots could break package builds, app-core bundling, or published package installs.

Validation needed:

- `bun run --filter @elizaos/shared typecheck`
- `bun run --filter @elizaos/shared test`
- `bun run --filter @elizaos/core typecheck`
- Consumer import scan for `@elizaos/shared` runtime symbols.
- Package install smoke from packed tarballs, not only workspace aliases.

Proposed TODOs:

- Decide and document whether `@elizaos/shared` may depend on `@elizaos/core`.
- If yes, change `@elizaos/core` dependency to `workspace:*` and publish versions consistently.
- If no, move core-coupled files to `@elizaos/core` or introduce a small contracts-only package for type primitives.
- Add an import-boundary check preventing new accidental `shared -> app-core` or `shared -> core` imports outside approved files.

### P1: Scenario runner depends on plugin test internals and compile-time shims

Paths:

- `packages/scenario-runner/src/judge.ts`
- `packages/scenario-runner/src/shims/eliza-app-lifeops.ts`
- `packages/scenario-runner/src/shims/elizaos-app-lifeops-runtime.ts`
- `packages/scenario-runner/src/executor.ts`
- `packages/scenario-runner/tsconfig.json`
- `packages/scenario-runner/tsconfig.build.json`

Rationale:

`judge.ts` imports `../../../plugins/app-lifeops/test/helpers/lifeops-eval-model.ts`, which makes a package source file depend on a plugin test helper. The package also aliases `@elizaos/app-lifeops` to `src/shims/eliza-app-lifeops.ts` for TypeScript, while `executor.ts` dynamically imports `@elizaos/app-lifeops` at runtime. This avoids compiling the app-lifeops graph but leaves two behavior surfaces: a stub result for build/type paths and a real runtime module for live execution.

Risk:

High for cleanup and publish reliability. Test helper paths are not stable public API, and the shim can mask missing runtime exports. A packaged `@elizaos/scenario-runner` may compile but fail or behave differently outside the monorepo if `@elizaos/app-lifeops` resolution differs.

Validation needed:

- `bun run --filter @elizaos/scenario-runner typecheck`
- `bun run --filter @elizaos/scenario-runner test`
- Pack and install `@elizaos/scenario-runner` into a temp project and run `node -e 'import("@elizaos/scenario-runner")'`.
- Run one LifeOps scenario that exercises `executeLifeOpsSchedulerTask`.

Proposed TODOs:

- Move `isCerebrasEvalEnabled` behind a public config helper in `scenario-runner`, `scenario-schema`, or app-lifeops source, not app-lifeops tests.
- Replace `src/shims/*` with a narrow published app-lifeops scenario runtime contract, or inject scheduler execution into `runScenario`.
- Add a test that fails if scenario-runner imports from `plugins/**/test/**`.
- Add a package export/import smoke test against built `dist`.

### P1: Public barrels are too broad for safe cleanup

Paths:

- `packages/core/src/index.node.ts`
- `packages/core/src/index.browser.ts`
- `packages/core/src/index.ts`
- `packages/shared/src/index.ts`
- `packages/core/package.json`
- `packages/shared/package.json`

Rationale:

`@elizaos/core` and `@elizaos/shared` expose broad `export *` barrels plus wildcard package exports (`"./*": "./dist/*.js"`). `index.browser.ts` duplicates some exports (`cloud-routing` appears twice) and includes browser stubs for Node-only functions. `shared/src/index.ts` exports contracts, CLI utilities, terminal helpers, config, themes, and `test-support`.

Risk:

High. Removing or moving files that look internal may break external imports through the package wildcard or root barrel. Browser bundle behavior also depends on named exports existing even when values are stubs.

Validation needed:

- Generate root export snapshots for `@elizaos/core`, `@elizaos/core/browser`, `@elizaos/core/node`, and `@elizaos/shared`.
- Build app-core/browser bundle after any export narrowing.
- Run a package import matrix for root exports and common subpath exports.

Proposed TODOs:

- Add export snapshot tests before cleanup.
- Split explicit public exports from compatibility exports with comments and owner decisions.
- Consider deprecating wildcard `./*` exports before deleting source paths.
- Remove duplicate browser barrel exports only after snapshot and browser bundle tests pass.

### P2: Generated and stale artifacts live beside source

Paths:

- `packages/core/src/generated/action-docs.ts`
- `packages/core/src/generated/spec-helpers.ts`
- `packages/core/src/features/advanced-capabilities/experience/generated/specs/specs.ts`
- `packages/core/src/features/advanced-capabilities/experience/generated/specs/spec-helpers.ts`
- `packages/core/src/i18n/generated/validation-keyword-data.ts`
- `packages/shared/src/i18n/generated/validation-keyword-data.ts`
- `packages/shared/src/i18n/generated/validation-keyword-data.js`
- `packages/shared/src/i18n/keywords/action-search.generated.keywords.json`
- `packages/prompts/specs/actions/plugins.generated.json`
- `packages/scenario-runner/src/cerebras-judge.d.ts.map`
- `packages/shared/src/types/index.d.ts.map`
- `packages/prompts/dist/python/prompts.py`
- `packages/prompts/dist/rust/prompts.rs`

Rationale:

Some generated files are tracked source, some are ignored local artifacts, and some generated local artifacts appear stale. `packages/prompts/dist/python/prompts.py` and `packages/prompts/dist/rust/prompts.rs` still say they were generated from `packages/prompts/prompts/*.txt`, while `packages/prompts/README.md` says the source of truth moved to `src/index.ts`. `packages/scenario-runner/src/cerebras-judge.d.ts.map` is tracked beside source. `packages/shared/src/i18n/generated/validation-keyword-data.js` is ignored, but comments say release workflows import it by literal `.js` path, so its ignored/untracked status deserves verification.

Risk:

Medium. Deleting generated artifacts blindly could break codegen consumers or release workflows. Keeping stale artifacts creates confusing audit and packaging surfaces.

Validation needed:

- Run the relevant generators from a clean checkout.
- Confirm which generated files are intentionally tracked.
- Confirm whether ignored `packages/shared/src/i18n/generated/validation-keyword-data.js` is required by any release workflow.
- Compare package tarball contents for `@elizaos/prompts`, `@elizaos/core`, and `@elizaos/shared`.

Proposed TODOs:

- Add a `GENERATED.md` or comments in package READMEs listing tracked vs ignored generated outputs.
- Remove stale ignored local `packages/prompts/dist` artifacts from developer worktrees after confirming no workflow needs them.
- Either track or stop relying on `packages/shared/src/i18n/generated/validation-keyword-data.js`; an ignored required source file is a reproducibility smell.
- Move `packages/scenario-runner/src/cerebras-judge.d.ts.map` out of `src` or regenerate it under `dist`.

### P2: Local build/cache output dominates the audited package folders

Paths:

- `packages/core/dist` (~72 MB)
- `packages/shared/dist` (~5.1 MB)
- `packages/prompts/dist`
- `packages/scenario-runner/dist`
- `packages/vault/dist`
- `packages/workflows/dist`
- `packages/skills/dist`
- `packages/*/.turbo`
- `packages/*/node_modules`
- `packages/core/test-results/.last-run.json`
- `packages/prompts/.DS_Store`

Rationale:

These are ignored, but they make local audits noisy. `packages/core` is about 80 MB, with `dist` about 72 MB. The ignored `dist` outputs include multi-megabyte source maps such as `packages/core/dist/node/index.node.js.map` (~19 MB), `packages/core/dist/edge/index.edge.js.map` (~12 MB), and `packages/core/dist/browser/index.browser.js.map` (~11 MB).

Risk:

Low for Git, medium for human cleanup. The risk is mistaking ignored local outputs for tracked source or letting stale generated artifacts influence manual review.

Validation needed:

- Confirm all `dist`, `.turbo`, `node_modules`, test-results, and `.DS_Store` paths are ignored.
- Run builds after local cleanup to confirm reproducibility.

Proposed TODOs:

- Add a package cleanup script that removes ignored outputs for these packages.
- Include `git clean -ndX packages/...` output in future cleanup plans before actual deletion.
- Keep source audit commands excluding `dist`, `node_modules`, `.turbo`, and `test-results`.

### P2: Dependency version drift in runtime/domain package metadata

Paths:

- `packages/shared/package.json`
- `packages/skills/package.json`
- `packages/core/package.json`
- `packages/scenario-runner/package.json`

Rationale:

`packages/shared` and `packages/skills` depend on `@elizaos/core` version `2.0.0-alpha.537`, while these packages are versioned `2.0.0-beta.2`. Other target packages use `workspace:*` for local runtime dependencies. This can cause published installs to resolve older core APIs than the current source expects.

Risk:

Medium-high for published packages and external consumers.

Validation needed:

- `npm pack --dry-run` or package-specific dry-run equivalent for shared/skills.
- Install packed `@elizaos/shared` and `@elizaos/skills` in a temp project and import root exports.
- Confirm release tooling rewrites dependency ranges intentionally.

Proposed TODOs:

- Standardize internal package dependency ranges to `workspace:*` during development.
- Document any release-time range rewrite if alpha pins are intentional.
- Add CI check for mismatched internal package versions in target packages.

### P2: `packages/shared` tsconfig reaches into app-core React type paths

Paths:

- `packages/shared/tsconfig.json`
- `packages/shared/src/config/boot-config-react.tsx`
- `packages/shared/src/config/branding-react.tsx`

Rationale:

`shared/tsconfig.json` includes `../app-core/src/ui` and maps `react`, `react/jsx-runtime`, `react/jsx-dev-runtime`, and `react-dom` to `../app-core/node_modules/@types/...`. That couples shared typechecking to app-core's dependency layout. It is unusual for a shared contracts package and makes isolated package work less reliable.

Risk:

Medium. Moving app-core, changing node_modules layout, or packing shared in isolation can break typechecking.

Validation needed:

- Typecheck `@elizaos/shared` with only root workspace dependencies.
- Typecheck from a package-isolated install if supported.
- Confirm whether React helpers belong in `shared` or app/ui packages.

Proposed TODOs:

- Move React-specific helpers to a UI/app package, or add direct peer/dev dependencies on React types in `@elizaos/shared`.
- Remove `../app-core/src/ui` from `shared` include unless tests prove it is required.

### P2: Prompt package publish/build contract is unusual and stale outputs obscure it

Paths:

- `packages/prompts/package.json`
- `packages/prompts/src/index.ts`
- `packages/prompts/scripts/generate-action-docs.js`
- `packages/prompts/scripts/generate-plugin-action-spec.js`
- `packages/prompts/test/prompts.test.js`
- `packages/prompts/dist/python/prompts.py`
- `packages/prompts/dist/rust/prompts.rs`

Rationale:

`@elizaos/prompts` root export points directly at `./src/index.ts` for both `import` and `types`; `typecheck` is a no-op; build scripts generate specs/docs rather than JS for package consumption. This may be intentional for Bun/workspace usage, but it is a sharp edge for standard Node consumers. The ignored dist outputs are stale relative to the README.

Risk:

Medium. Consumers may need TS loaders to import the published package. Stale generated language outputs may be mistaken for current supported artifacts.

Validation needed:

- Pack and import `@elizaos/prompts` using Node without workspace TS resolution.
- Run `bun test packages/prompts/test/prompts.test.js`.
- Confirm whether Python/Rust prompt outputs are still supported.

Proposed TODOs:

- Decide whether `@elizaos/prompts` is a source-TS package or should build JS declarations to `dist`.
- If source-TS is intentional, document runtime requirements in package README.
- Delete or regenerate stale ignored Python/Rust outputs after confirming their status.

### P2: Core contains deliberate duplicated/inlined helpers to avoid package cycles

Paths:

- `packages/core/src/services/relationships-graph-builder.ts`
- `packages/core/src/runtime/system-prompt.ts`
- `packages/core/src/features/plugin-manager/providers/relevance.ts`
- `packages/shared/src/utils/name-tokens.ts`

Rationale:

Core comments explicitly note helpers inlined from shared to avoid `core -> shared` dependency. This is a reasonable short-term cycle break, but it creates two maintenance sources. The relationship graph builder is also very large and has local type definitions aligned with service internals.

Risk:

Medium. Consolidating the helpers incorrectly could create a package cycle or break core's ability to build independently.

Validation needed:

- Import graph check proving no `core -> shared` dependency is introduced.
- Unit tests around system prompt name token replacement, plugin relevance scoring, and relationships graph building.

Proposed TODOs:

- Extract truly package-neutral helpers into a lower-level package, or accept duplication and add drift tests/comments.
- For the relationships graph builder, identify whether graph DTO types belong with `RelationshipsService` or in a shared contract package.

### P2: Back-compat and legacy shims need owners and removal criteria

Paths:

- `packages/core/src/runtime/cost-table.ts`
- `packages/core/src/utils/read-env.ts`
- `packages/core/src/actions/to-tool.ts`
- `packages/core/src/runtime/response-grammar.ts`
- `packages/core/src/runtime/response-handler-field-registry.ts`
- `packages/core/src/features/basic-capabilities/index.ts`
- `packages/core/src/features/autonomy/service.ts`
- `packages/core/src/features/secrets/**`
- `packages/vault/src/pglite-vault.ts`

Rationale:

Several files intentionally preserve legacy aliases, back-compat parse paths, old env vars, old encryption/storage behavior, and fallback schemas. These are not automatically bad, but most lack explicit removal windows or owner notes. Cleanup without criteria risks breaking migrations and old trajectories.

Risk:

Medium-high where persisted data or public API is involved, especially trajectories, secrets, env vars, and vault migration.

Validation needed:

- Migration tests for old env vars, old secret formats, old trajectory outputs, and old vault JSON.
- Consumer scan for legacy aliases and old import paths.

Proposed TODOs:

- Create a compatibility registry listing shim, owner, reason, data/API affected, and removal condition.
- Prefer a single compatibility module per domain instead of scattered comments.
- Keep tests until the shim is actually removed.

### P3: `@elizaos/shared` root exports test support

Paths:

- `packages/shared/src/index.ts`
- `packages/shared/src/test-support/process-helpers.ts`
- `packages/shared/src/test-support/test-helpers.ts`

Rationale:

The package root exports `./test-support/process-helpers.js` and `./test-support/test-helpers.js`, making test helpers part of the root public API and tarball surface.

Risk:

Low-medium. Consumers may already rely on the root export. Moving these to a subpath would be cleaner but can break imports.

Validation needed:

- Repo-wide import scan for `test-support` helpers.
- Export snapshot before any change.

Proposed TODOs:

- Move test helpers behind `@elizaos/shared/test-support` subpath export.
- Keep root re-export temporarily with deprecation notes if external usage exists.

### P3: `@elizaos/vault` public index exports testing helpers

Paths:

- `packages/vault/src/index.ts`
- `packages/vault/src/testing.ts`

Rationale:

`packages/vault/src/index.ts` exports `./testing.js` from the root. That can be convenient, but it exposes test-only helpers in normal production imports.

Risk:

Low. The package is small and the helper may be intentionally public for plugin tests.

Validation needed:

- Repo-wide scan for `createTestVault` and root import usage.
- Package export snapshot.

Proposed TODOs:

- Add a `./testing` subpath export and migrate consumers.
- Keep root export only if it is deliberately supported API.

### P3: `packages/vault` type split and docs have small cleanup opportunities

Paths:

- `packages/vault/src/types.ts`
- `packages/vault/src/vault-types.ts`
- `packages/vault/src/vault.ts`

Rationale:

Public vault API types are split between `types.ts` and `vault-types.ts`; `vault.ts` re-exports the vault interface and error class. This is manageable, but a future cleanup could make `vault-types.ts` the only public API type module and keep storage shapes internal. Also, `CreateVaultOptions` docs list `$ELIZA_STATE_DIR` twice in the resolution order; one entry likely intended a legacy env var.

Risk:

Low. Mostly readability/API hygiene.

Validation needed:

- Vault tests: `bun run --filter @elizaos/vault test`
- API extractor/export snapshot if available.

Proposed TODOs:

- Fix the duplicated env-var doc line.
- Decide whether `StoredEntry` should remain exported from root or stay internal.

### P3: Scenario schema JS and DTS are manually synchronized

Paths:

- `packages/scenario-schema/index.js`
- `packages/scenario-schema/index.d.ts`
- `packages/scenario-schema/package.json`

Rationale:

This package has no scripts. Runtime strict key validation in `index.js` and TS unions in `index.d.ts` must be updated manually together. It is tiny, but it is central to scenario definitions.

Risk:

Medium if final-check types drift from runtime validation.

Validation needed:

- Add a small test that iterates known final check types and compares DTS/JS expectations where practical.
- Use scenario-runner tests as an integration check.

Proposed TODOs:

- Generate `index.d.ts` and `FINAL_CHECK_KEYS` from one source, or add a drift test.
- Add a `test` script even if it is a small schema smoke test.

### P3: Workflow package is clean but should document its type-only contract

Paths:

- `packages/workflows/src/index.ts`
- `packages/workflows/__tests__/types.smoke.test.ts`
- `packages/workflows/package.json`

Rationale:

The package is intentionally types-only with one runtime value: `NodeConnectionTypes`. `files` includes both `dist` and `src`, but package exports point to `dist`. The test imports `../src/index.ts`, not the built package.

Risk:

Low. The package has a narrow surface and a useful smoke test.

Validation needed:

- `bun run --filter @elizaos/workflows build`
- `bun run --filter @elizaos/workflows test`
- Import built `dist/index.js` and assert only `NodeConnectionTypes` is exported.

Proposed TODOs:

- Add a built-package smoke test or pack/import smoke.
- Consider dropping `src` from package `files` if source publication is not required.

### P3: Skills package has executable bundled skill scripts

Paths:

- `packages/skills/skills/nano-banana-pro/scripts/generate_image.py`
- `packages/skills/skills/skill-creator/scripts/init_skill.py`
- `packages/skills/skills/skill-creator/scripts/package_skill.py`
- `packages/skills/skills/skill-creator/scripts/quick_validate.py`
- `packages/skills/skills/tmux/scripts/find-sessions.sh`
- `packages/skills/skills/tmux/scripts/wait-for-text.sh`
- `packages/skills/package.json`

Rationale:

The `files` list intentionally includes `skills/**/*`, so Python and shell scripts are published as skill assets. This is not necessarily a problem, but executable bundled content should have a clear review/security expectation.

Risk:

Low-medium depending on how skills are executed. Scripts embedded in skills can become a supply-chain surface.

Validation needed:

- Confirm loader treats these as references/assets and does not execute automatically.
- Review scripts for network/file-system behavior before publishing.

Proposed TODOs:

- Add a skill asset policy: scripts allowed only when referenced by `SKILL.md`, with review tags.
- Add package audit command listing executable files under `skills/`.

## Consolidation candidates

1. Core/shared utility split:
   - Candidates: `replaceNameTokens`, simple type guards, plugin relevance helpers.
   - Target: a lower-level no-runtime-coupling package or explicit accepted duplication.

2. Prompt/spec generation:
   - Candidates: `packages/prompts/specs/**`, `packages/core/src/generated/**`, experience-specific generated specs.
   - Target: one documented generator pipeline and generated-file policy.

3. Scenario contracts:
   - Candidates: `scenario-schema`, `scenario-runner/src/types.ts`, app-lifeops scheduler runtime contract.
   - Target: schema owns scenario definitions; runner owns reports; app-lifeops exposes a stable scenario execution adapter.

4. Testing helpers:
   - Candidates: `@elizaos/shared` test-support root exports, `@elizaos/vault` root testing export, core testing exports.
   - Target: explicit `./testing` or `./test-support` subpaths.

5. Package export surfaces:
   - Candidates: core/shared wildcard exports and root barrels.
   - Target: export snapshots first, then gradual deprecation of wildcard subpaths.

## Validation checklist before deletion or moves

- `bun run --filter @elizaos/core typecheck`
- `bun run --filter @elizaos/core test`
- `bun run --filter @elizaos/shared typecheck`
- `bun run --filter @elizaos/shared test`
- `bun run --filter @elizaos/skills build`
- `bun run --filter @elizaos/skills test`
- `bun run --filter @elizaos/workflows build`
- `bun run --filter @elizaos/workflows test`
- `bun run --filter @elizaos/prompts build`
- `bun test packages/prompts/test/prompts.test.js`
- `bun run --filter @elizaos/scenario-runner typecheck`
- `bun run --filter @elizaos/scenario-runner test`
- `bun run --filter @elizaos/vault typecheck`
- `bun run --filter @elizaos/vault test`
- Package tarball/import smoke for `core`, `shared`, `skills`, `prompts`, `scenario-runner`, `scenario-schema`, `vault`, and `workflows`.

## Dry-run cleanup TODO list

- Add export snapshot tests for `@elizaos/core`, `@elizaos/shared`, `@elizaos/vault`, `@elizaos/workflows`, and `@elizaos/scenario-runner`.
- Add a package-boundary lint rule for target packages.
- Normalize internal dependency ranges, especially `@elizaos/core` in `packages/shared/package.json` and `packages/skills/package.json`.
- Replace scenario-runner's app-lifeops test-helper import with a public helper or local config.
- Decide tracked vs generated/ignored policy for i18n keyword data and prompt/action docs.
- Clean stale ignored local artifacts only after a `git clean -ndX` review.
- Move root-exported test helpers to subpath exports with temporary compatibility.
- Document compatibility shims and removal criteria for core runtime legacy paths.
- Add built-package import smoke tests for source-TS or types-only packages.
