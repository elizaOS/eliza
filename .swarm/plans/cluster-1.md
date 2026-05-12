# Cluster 1 — Hygiene (research plan)

Scope: fix every lint/biome/format/typecheck/build/test/CI failure repo-wide;
stabilize `uv.lock` + python test deps; reconcile the vulkan/cpu dispatch-smoke
↔ fork pin; fix the `node:fs/promises` mock-pollution leak; update the parent
`/home/shaw/milady/CLAUDE.md` env-var section to the `ELIZA_*` convention; strip
overengineering surfaced along the way.

---

## A. Critical assessment — the real state (measured 2026-05-12)

### 1. Biome — `bunx biome check` at repo root: 2364 errors / 2499 warnings / 248 infos across 11638 files

**The single biggest distortion: 683 of the ~800 "inference" errors are inside `packages/inference/llama.cpp/`** — the upstream `elizaOS/llama.cpp` git submodule. Biome scans into it because `useIgnoreFile` reads `.gitignore`, and submodule contents are tracked-by-reference, not gitignored. **These are upstream files we never edit; fixing them is wrong.** Fix: add `!packages/inference/llama.cpp/**` (and any other submodule paths — `cloud/`'s nested checkouts, `plugins/plugin-agent-orchestrator` in local mode) to `biome.json` `files.includes`.

After that exclusion, the real error distribution by area (file-counts, not error-counts):

| Area | files w/ findings | nature |
|---|---|---|
| `packages/inference/{verify,reports}` | ~117 | almost all are biome **format** (not lint) errors on generated JSON bench/gate/report/fixture files (multi-key-per-line JSON the formatter wants to expand) + a few `.ts`/`.mjs` harness files |
| `test/scenarios/lifeops.*` (repo-root `test/`) | ~399 (mostly `plugins/app-lifeops` mirrors) | lint: `noUnusedVariables`, `organizeImports`, `noDoubleEquals` in scenario fixtures |
| `plugins/app-lifeops` | ~355 | lint sweep (unused vars/imports, `==`, comma operator, `organizeImports`) |
| `packages/benchmarks` | ~170 | benchmark fixtures + skill-runner TS; some intentionally-bad fixtures already in `biome.json` ignores, the rest are real lint |
| `scripts/` (repo root) | ~139 | `.mjs` scripts: `noNodejsImportProtocol`, `useConst`, `noDoubleEquals`, `organizeImports` |
| `plugins/app-training` | ~71 | lint sweep |
| rest: `plugins/plugin-{coding-tools,social-alpha,computeruse,browser,...}`, `packages/{app-core,agent,core,scenario-runner,registry,native-plugins,vault,examples,training}` | ~10-25 each | lint |

**Top biome rules** (post-llama.cpp-exclusion, approx — full counts include the submodule):
`noUnusedVariables` 709, `assist/organizeImports` 615, `noUnusedImports` 403, `noNonNullAssertion` 267 (warn), `noAssignInExpressions` 264 (warn), `useConst` 147, `noDoubleEquals` 138 (error), `noCommaOperator` 132 (warn), `useTemplate` 125 (info), `noExplicitAny` 120 (warn), `useOptionalChain` 97, `useImportType` 79, `useArrowFunction` 68, `noUnusedFunctionParameters` 65, `useLiteralKeys` 57, `noTemplateCurlyInString` 38, `useNodejsImportProtocol` 25, `useHookAtTopLevel` 17 (error, in `packages/app`), `useHtmlLang` 17, `useButtonType` 12, `noInnerDeclarations` 20 (error), `noStaticOnlyClass` 10, `noDuplicateClassMembers`/`noDuplicateObjectKeys`/`noShadowRestrictedNames`/`noRedeclare` — small but real correctness errors.

**Auto-fixable vs hand-fix:**
- **Auto (safe)** — `organizeImports`, `useConst`, `useNodejsImportProtocol`, `useImportType`, `useTemplate`, `useLiteralKeys`, `useOptionalChain`, `noUselessUndefinedInitialization`, `noUselessEscapeInRegex`, `useExponentiationOperator`, `noUselessConstructor`/`Continue`/`Ternary`/`Rename`/`SwitchCase`/`StringRaw`, `useParseIntRadix`, `useArrowFunction`: `bunx biome check --write` (and a few need `--unsafe`). Run **per-package** (`turbo run lint` with `--write` locally) to keep diffs reviewable, NOT a single tree-wide `--write` that touches the submodule or out-of-scope vendor dirs.
- **Auto (format)** — the generated-JSON format errors under `packages/inference/{verify,reports}`: either `bunx biome format --write` them once (clean, low-risk; they're machine-written so re-formatting them is harmless) **or** add `!packages/inference/reports/**`, `!packages/inference/verify/**/bench_results/**`, `!packages/inference/verify/**/fixtures/**` to `biome.json` since they're artifacts. **Preferred: ignore them** — re-formatting bench artifacts every run is churn; they're not source.
- **Hand-fix (errors)** — `noDoubleEquals` (138; mechanical but needs eyeballing for `null` vs `undefined` intent), `noInnerDeclarations` (20, hoist `function`/`var` out of blocks), `useHookAtTopLevel` (17, real React-hooks bugs in `packages/app`), `noShadowRestrictedNames`/`noRedeclare`/`noLabelVar`/`noDuplicateClassMembers`/`noDuplicateObjectKeys`/`noUnsafeDeclarationMerging`/`noFallthroughSwitchClause`/`noSelfAssign`/`noControlCharactersInRegex`/`noInvalidUseBeforeDeclaration`/`noUnknownProperty`/`noAsyncPromiseExecutor`/`noConfusingLabels` — each <10, all genuine bugs, fix individually. `useButtonType`/`useHtmlLang`/`useAltText`/`useMediaCaption`/`useGenericFontNames`/`noDescendingSpecificity`/`noImportantStyles`/`noDuplicateCustomProperties` — a11y/CSS, mechanical.
- **Hand-fix (warnings the user wants gone)** — `noUnusedVariables`/`noUnusedImports` (1100+ combined): biome's `--write` removes unused *imports* safely; unused *vars* it doesn't auto-remove — prefix with `_` only where genuinely a signature requirement, otherwise delete. `noNonNullAssertion`/`noExplicitAny`/`noAssignInExpressions`/`noCommaOperator` — these overlap heavily with **Clusters 2/3/4/5's domains** (`packages/inference/**`, `packages/training/**`, `dflash-server.ts`, `engine.ts`, `structured-output.ts`, `response-grammar.ts`). **Don't fix biome warnings in files those clusters are about to rewrite** — see §E.

### 2. Typecheck — `bun run typecheck` (turbo per-package)

- ✅ Clean: `@elizaos/core`, `@elizaos/shared`, `@elizaos/ui`, `@elizaos/app-core` (`tsc -p tsconfig.json`).
- ❌ `@elizaos/agent` — **56 errors, all in `packages/app-core/src/services/auth-store.ts`**, all from a **duplicate `drizzle-orm@0.45.2`**: bun installed 5 hashed copies (`drizzle-orm@0.45.2+{fc0f68b157690761, 34883faaf1889a16, 5612a1decb63d80b, 5ca896fe6dab5078, 618017aa13271bc5}` — different peer-dep resolution hashes from `@elizaos/plugin-sql` vs direct deps). The agent tsconfig resolves `app-core/src` (via `paths`), and `auth-store.ts` mixes a `pgTable` schema typed by drizzle-copy-A with `db.update(...)` typed by drizzle-copy-B → `SQL<unknown>` is "not assignable to" itself. Fix: dedupe `drizzle-orm` to one copy (a `resolutions`/`overrides` entry in root `package.json`, or align the `@elizaos/plugin-sql` peer range so bun collapses them; verify with `bun pm ls drizzle-orm`). This is the only typecheck failure but it's load-bearing — `agent` is in the CI typecheck job.
- `packages/inference/tsconfig.json` has `"include": []` → `tsc` errors `TS18003 No inputs were found`. It's a stub config (the inference package's TS is checked by `app-core`'s tsconfig via paths, and the `.mjs`/`.c`/`.cu` aren't TS). Either give it a real `include` (the `verify/*.ts` harnesses) or drop it / mark it allowJs-only with a non-empty include — currently `bunx tsc --noEmit -p packages/inference/tsconfig.json` exits 2.
- `homepage`, `scenario-runner`, `workflows`, `vault`, `cloud-routing`, `elizaos`, `prompts` typechecks not individually re-run here — turbo runs them; assume green unless the agent run says otherwise (re-run `bun run typecheck` end-to-end as the gate).
- **Note:** repo-root `CLAUDE.md` references `bun run verify` / `bun run check` — **neither script exists in `package.json`.** Add them as aliases (`"verify": "bun run typecheck && bun run lint"`, `"check": "bun run verify"`) or correct the doc. (This is the *repo* CLAUDE.md, distinct from the parent one in §D.)

### 3. Build — `bun run build` (`turbo run build --concurrency=1` + examples-benchmarks)

Not run to completion here (slow); the per-package `dist/**` is the output. The Electrobun-contract and Client-Tests CI failures (§4) point at *unbuilt* `dist/` for some workspace packages. The build itself is not known-red; re-run `bun run build` as the gate. If it's red, the likely cause is the drizzle dual-version (same as §2) or a missing dep (`ethers` — see §4).

### 4. Tests — `bun run test` (`scripts/run-all-tests.mjs`) and the `test.yml` CI workflow

`test.yml` is currently **red on `develop`** (latest decisive run 25712549286): `Plugin Tests` ❌, `Client Tests` ❌, `Electrobun Desktop Contract` ❌, `Server Tests` cancelled (concurrency), `Cloud Live E2E` ✅. Root causes:

1. **Plugin Tests** — `@elizaos/app-training#test` fails: `Cannot find package 'ethers' imported from packages/agent/src/api/registry-service.ts`. `ethers@^6.16.0` IS declared in `packages/agent/package.json` and IS in `node_modules/.bun/ethers@6.16.0`, so this is a **CI dependency-install flake** (the CI log also shows "`bun.lock changed during dependency install`" and "`No bun/install.js found`" warnings — bun's install is non-deterministic in that CI lane). Fix: pin/clean the bun install in `test.yml` (the retry-after-cache-clean path isn't recovering), or hoist `ethers` so it resolves transitively, or stop `app-training`'s test from transitively importing `registry-service.ts`. **Verify locally**: `bun test plugins/app-training` — if it passes locally it's pure CI-env, fix the workflow's install step.
2. **Electrobun Desktop Contract** — 5 test files under `packages/app-core/platforms/electrobun/src/*.test.ts` fail with `Cannot find package 'bun:test'`. These tests `import { ... } from "bun:test"` but the desktop-contract CI step runs them under **vitest** (not `bun test`). Fix: either run them with `bun test` (add to `scripts/run-all-tests.mjs`'s bun-test lane / the package's `test` script), or convert the imports to `vitest`. Pick whichever matches the package's `vitest.config.ts` / `package.json#test` intent — check what `packages/app-core/platforms/electrobun/package.json` declares.
3. **Client Tests** — `Failed to resolve entry for package "@elizaos/capacitor-llama"` and `"@elizaos/app-wallet"`: their `package.json#exports` point at `./dist/...` which doesn't exist in the test env (not built) and the test's vite config has no source alias for them. Fix: add a `bun`/source-condition alias (capacitor-llama already has `exports["."].import: ./dist/esm/index.js` with no `bun`/`development` condition; `app-wallet` has a `bun` condition → so the failure is specifically `capacitor-llama` missing the source condition + `app-wallet` needing its `dist` built). Add `bun`/`development` export conditions pointing at `src/` to `packages/native-plugins/llama/package.json`, and ensure `app-wallet` is in the `dev:prepare` build filter, or alias both in `packages/app`'s `vitest.config.ts`.
4. **`bun test packages/app-core/src/services/local-inference` is partly red** (17 of 621 fail) **only when run as a directory batch** — see §C below (the mock-pollution leak). Each affected file passes in isolation.

### 5. `uv.lock` / python test deps

- `cd packages/training && uv lock --check` → ✅ **in sync** (no churn now; the last `336031a04c chore: checkpoint uv.lock churn before swarm merge` stabilized it). The resolution-marker reordering the TODO mentions appears already resolved. **Action: re-run `uv lock --check` as the gate; only act if it diverges.**
- `hypothesis>=6.100.0` is a **top-level** dep in `packages/training/pyproject.toml` (not behind an extra) and IS in `uv.lock` (line 1587). The `training-stack.yml` CI runs `pytest` inside `Dockerfile.cpu` which does `uv sync --extra train --frozen --no-install-project` — top-level deps are always installed by `uv sync`, so `hypothesis` is present. `test_format_for_training_privacy.py` (the one file that imports it) should collect fine. **Action: confirm `training-stack.yml`'s latest develop run; if it fails at collection on a missing dep, add that dep to `pyproject.toml` deps and re-lock.** Currently no evidence it's red on a dep.

### 6. `vulkan-dispatch-smoke` ↔ fork pin

- The submodule is at `eae44e75` ("updates", a follow-on to `08032d57 v1.0.0-eliza`) **plus uncommitted modifications** (`git status`: 24 files changed, +1042/-158 — CMakeLists, `ggml-cpu.c`, `qjl/*`, `server-task.cpp`, `server.cpp`, mtmd, ...). `.gitmodules`/`AGENTS.md` still say `08032d57`. Cluster 2's plan says the cpu+vulkan dispatch-smoke ↔ fork-API reconciliation is "already reconciled (the harness now ...)" — so this overlaps Cluster 2.
- `make -C packages/inference/verify cpu-dispatch-smoke` → ✅ **passes locally** (`qjl_mt_check`: bit-identical, no NaN; `ATTN_SCORE_QJL` + `FUSED_ATTN_QJL_TBQ` both 0 mismatches). The fork *does* export `GGML_OP_ATTN_SCORE_QJL` / `GGML_OP_FUSED_ATTN_QJL_TBQ` / `ggml_attn_score_qjl` / `ggml_fused_attn_qjl_tbq` in `ggml/include/ggml.h`.
- `vulkan-dispatch-smoke` needs a Vulkan llama.cpp build (`libggml-vulkan.so`) which isn't built locally — the Makefile target is correctly gated ("native Linux required ... symbol-only staging cannot pass"). **For Cluster 1 the action is small**: ensure the `.cpp` compiles against the *committed* fork API (the smoke `.cpp` references only the two public ops which exist) and the Makefile gating message stays honest. Coordinate with Cluster 2; if Cluster 2's submodule advance changes a signature, the `.cpp` follows. Not a Cluster-1 blocker; track it.

### 7. CI workflows — what's red on `develop` and why

Active push-triggered workflows on `develop`: `quality.yml`, `test.yml`, `docker-ci-smoke.yml`, `scenario-matrix.yml` (✅), `codeql.yml`, `training-stack.yml`, `nightly.yml` (schedule), plus the Cluster-2/3-relevant `local-inference-*`/`lifeops-bench-*`. Most runs show `cancelled` because the concurrency group cancels superseded runs as new commits land — that's expected, not a failure.

- **`quality.yml` (Quality (Extended)) — ❌ red.** The `Format Check (biome)` job runs `turbo run format:check` (per-package `biome format`); **`@elizaos/plugin-suno#format:check` fails with 2 format errors** (`src/actions/musicGeneration.ts`, `src/index.ts` — unwrapped multi-import statements that biome's formatter wants on one line, using plugin-suno's own `biome.json`: single-quote/4-space/es5-trailing-comma). Fix: `cd plugins/plugin-suno && bunx @biomejs/biome format --write ./src` (and check `auto-enable.ts` + `package.json` at the plugin root too — `biome format .` flags those, though `format:check` only runs `./src`). The `Homepage Build (PR smoke)` sub-job is ✅.
- **`test.yml` (Tests) — ❌ red.** See §4: Plugin/Client/Electrobun. `All Tests Passed` gate fails because those 3 required jobs failed.
- **`ci.yaml`** (`Run typecheck` + `lint-and-format` = `bun run typecheck` + `bun run format:check` + `bun run lint`) — does NOT run on `develop` pushes (PR/branch-gated); last develop run was 2025-10. But it IS the gate referenced by repo CLAUDE.md, and its `typecheck` step will fail on the drizzle dual-version (§2). If/when it runs, fix §2 first.
- **`nightly.yml`** — red ("Build & Test" step) every night. Not investigated in depth; likely the same test/build issues + possibly stale. Run `gh run view <latest-nightly> --log-failed` and fix or document.
- **`docker-ci-smoke.yml`** — in_progress in every recent push; check the last completed one.
- **`training-stack.yml`** — recent runs cancelled (concurrency); find the last decisive one. If green, leave it. The `cpu-smoke` lane (`ruff check` + import probe + pytest in Docker) is the part that could break on a python-side change.
- **`codeql.yml`** — long-running, usually completes; leave unless it surfaces a real alert.

---

## B. Recommendations, ordered (B = high-confidence unless flagged)

### Phase 1 — config + the CI-blocking quick wins (do first; small, high-leverage)
1. **`biome.json`**: add `!packages/inference/llama.cpp/**` to `files.includes` (and any other submodule/vendor paths picked up: nested checkouts under `cloud/`, `plugins/plugin-agent-orchestrator` when local-mode, anything `git submodule status` lists). Also add `!packages/inference/reports/**` and the `bench_results`/`fixtures` artifact dirs under `packages/inference/verify/` (machine-written JSON — not source; ignore rather than re-format on every run). **Re-count after**: this should drop biome from ~2364 errors to <600.
2. **`plugins/plugin-suno`**: `bunx @biomejs/biome format --write ./src` (+ `auto-enable.ts`, `package.json`). Unblocks `quality.yml`.
3. **Dedupe `drizzle-orm`**: add `"resolutions": { "drizzle-orm": "0.45.2" }` (or `overrides`, matching bun's config key) to root `package.json`; `bun install`; verify `bun pm ls drizzle-orm` shows one copy; re-run `bunx tsc --noEmit -p packages/agent/tsconfig.json` → expect 0 errors. Unblocks the `agent` typecheck and any build/test paths that hit `auth-store.ts`.
4. **`packages/inference/tsconfig.json`**: give it a real non-empty `include` (`["verify/**/*.ts"]` or similar) so `tsc -p` doesn't exit 2 — OR remove it and rely on `app-core`'s coverage. Pick after checking what (if anything) imports it / runs `tsc -p packages/inference/tsconfig.json`.
5. **Add `verify`/`check` scripts** to root `package.json` (`"verify": "bun run typecheck && bun run lint"`, `"check": "bun run verify"`) so the repo CLAUDE.md isn't lying. (Or, if the maintainers prefer, edit the repo CLAUDE.md instead — but a script is the lower-friction fix.)

### Phase 2 — `test.yml` green
6. **Electrobun contract tests** (`packages/app-core/platforms/electrobun/src/*.test.ts`): make the `bun:test` imports run under `bun test` (add the dir to `scripts/run-all-tests.mjs`'s bun-test lane + the package `test` script), or convert to `vitest`. Match the package's existing `vitest.config.ts` intent.
7. **Client tests**: add `bun`/`development` export conditions → `src/` to `packages/native-plugins/llama/package.json`; ensure `@elizaos/app-wallet` `dist` is built by `dev:prepare`'s turbo filter (or alias it in `packages/app/vitest.config.ts`).
8. **Plugin tests `ethers` flake**: reproduce `bun test plugins/app-training` locally. If green locally → fix `test.yml`'s bun-install step (the `bun.lock changed during install` retry isn't recovering — likely needs `--frozen-lockfile` + a clean cache, or the workflow's node/bun version mismatch). If it fails locally too → hoist `ethers` or break the transitive import from `app-training`'s tests into `agent/src/api/registry-service.ts`.
9. Re-run `bun run test` and `bun run test:e2e` end-to-end; triage anything else; hardware-gated cases (Metal/iOS/Android verify, cloud-paired) stay documented-skipped.

### Phase 3 — the mock-pollution leak (§C)
10. Fix `verify-on-device.test.ts`'s `vi.mock("node:fs/promises")` leak — see §C. After: `bun test packages/app-core/src/services/local-inference` fully green (621/621).

### Phase 4 — the lint sweep (the bulk; per-package, reviewable)
11. Per-package `bunx biome check --write` (safe fixes) then `--write --unsafe` selectively, package by package, **skipping `packages/inference/**`, `packages/training/**`, `dflash-server.ts`/`engine.ts`/`structured-output.ts`/`response-grammar.ts` until Clusters 2/3/4 have landed their rewrites** (see §E). Order: `scripts/` → repo-root `test/` → `plugins/app-lifeops` + `plugins/app-training` → `packages/benchmarks` → the small ones → finally the inference/training/dflash files once their clusters are done.
12. Hand-fix the error-level rules everywhere: `noDoubleEquals` (138), `noInnerDeclarations` (20), `useHookAtTopLevel` (17, real React bugs in `packages/app`), the <10 correctness rules (`noShadowRestrictedNames`, `noRedeclare`, `noLabelVar`, `noDuplicateClassMembers`, `noDuplicateObjectKeys`, `noUnsafeDeclarationMerging`, `noFallthroughSwitchClause`, `noSelfAssign`, `noControlCharactersInRegex`, `noInvalidUseBeforeDeclaration`, `noUnknownProperty`, `noAsyncPromiseExecutor`, `noConfusingLabels`, `noConfusingVoidType`), the a11y/CSS rules (`useButtonType`, `useHtmlLang`, `useAltText`, `useMediaCaption`, `useGenericFontNames`, `noDescendingSpecificity`, `noImportantStyles`, `noDuplicateCustomProperties`).
13. Hand-clear the warnings the user explicitly wants gone: `noUnusedVariables`/`noUnusedImports` (delete dead code per the `AGENTS.md` "remove on sight" mandate — biome's `--write` removes unused imports; unused vars get deleted by hand, `_`-prefixed only if a real signature requirement), `noNonNullAssertion`/`noExplicitAny`/`noAssignInExpressions`/`noCommaOperator`/`useTemplate` — but **only in files no other cluster owns** (§E).

### Phase 5 — python + parent docs
14. `cd packages/training && uv lock --check` — if it diverges, `uv lock` and commit; if `training-stack.yml` fails at pytest collection on a missing dep, add it to `pyproject.toml` and re-lock.
15. **Update `/home/shaw/milady/CLAUDE.md`** (the parent, outside this repo — see §D for the exact edit).

### Phase 6 — slop / overengineering removal (the `AGENTS.md` mandate, opportunistic)
16. As the lint sweep touches files, delete obvious dead branches, stub helpers, narrative-churn comments, "temporary"-turned-permanent fallbacks. Don't gold-plate; flag anything ambiguous.

### Phase 7 — verify everything green
17. `bun run typecheck` ✅, `bun run lint` ✅, `bunx biome check` ✅ (or down to only the documented submodule/artifact exclusions), `bun run format:check` ✅, `bun run build` ✅, `bun run test`/`test:e2e` ✅ (minus documented hardware gates), `gh run list` — every workflow green (re-run + fix until they are).

### Medium / low confidence (needs a decision)
- M: whether to *ignore* vs *re-format* the `packages/inference/{verify,reports}` JSON artifacts — I recommend ignore; a maintainer may prefer they stay biome-formatted. Pick one and be consistent.
- M: `useHookAtTopLevel` (17) in `packages/app` — may be intentional conditional-hook patterns that need a real refactor, not a mechanical fix. Treat as bug-fixes, test the affected components.
- L: should the per-package `lint` scripts that only check `src/` be widened to the whole package tree (so `turbo run lint` == `bunx biome check`)? The user wants the *whole tree* clean, but the *contract* is per-package `src/`. Recommend: keep the per-package contract, fix the whole tree by hand, and let `bunx biome check` at root be the "everything clean" gate (after the submodule/artifact exclusions). Don't change every package's `lint` script.

---

## C. The `node:fs/promises` / `conversationRegistry` mock-pollution leak

**Root cause (confirmed):** `packages/app-core/src/services/local-inference/verify-on-device.test.ts` calls `vi.mock("node:fs/promises", ...)` (also `vi.mock("./engine", ...)` and `vi.mock("./manifest", ...)`). **Bun's `vi.mock` is process-global and is NOT auto-restored between test files** — the file's own header comment admits it. So when `bun test` runs `verify-on-device.test.ts` *before* `downloader.test.ts` (and `dflash-cache-flow.test.ts`, the `cache-*` suites), the stubbed `node:fs/promises` / `./engine` / `./manifest` (and via `./engine`, transitively the conversation/cache registry it pulls in) bleed into those later suites → 17 failures. **Proof:** `bun test downloader.test.ts` alone = 7/7 ✅; `bun test verify-on-device.test.ts downloader.test.ts` (verify first) = 4 pass / 1 fail; `bun test downloader.test.ts verify-on-device.test.ts` (downloader first) = 11/11 ✅. Order-dependent → classic global-mock leak.

**Fix options (pick the cleanest):**
1. **Best — eliminate the `node:fs/promises` mock entirely**: `verify-on-device.ts:33` does `await fs.readFile(manifestPath, "utf8")` purely to parse the manifest, which the *caller* (`downloader.ts`'s `verifyBundleOnDevice` hook site) already has in memory. Pass the manifest content (or the parsed object) into `verifyBundleOnDevice(args)` instead of re-reading from disk → no fs mock needed, and the test mocks only `./engine`/`./manifest` (and `./manifest` it could stop mocking too if it just passes a fixture object). This is a small, justified code simplification — fewer codepaths, no disk re-read.
2. If a code change is unwanted: replace `vi.mock("node:fs/promises", ...)` with `vi.spyOn(fs, "readFile")` set up in `beforeEach` and **`vi.restoreAllMocks()` in `afterEach`** (spies *are* restorable in Bun, unlike module mocks); same for `./engine`/`./manifest` — but those are default-export object mocks, harder to spy. Option 1 is materially cleaner.
3. Failing both: move `verify-on-device.test.ts` to its own bun-test invocation (`scripts/run-all-tests.mjs` runs it isolated) — works but is a band-aid that hides the real problem; only do this if 1 and 2 are somehow infeasible.

Coordinate with Cluster 5: their `voice-duet.e2e.test.ts` lives under `packages/app-core/src/services/local-inference/`, so a clean `bun test` of that dir is a shared dependency.

---

## D. Parent `/home/shaw/milady/CLAUDE.md` env-var update

The repo's canonical env-var prefix is now **`ELIZA_*`** (`DEFAULT_BRANDED_PREFIX = "ELIZA"` in `packages/shared/src/utils/env.ts`); the branded-app prefix (`MILADY_*` when `ELIZA_NAMESPACE`/brand = milady) is **synced over to `ELIZA_*` at boot** (`syncAppEnvToEliza` / `syncBrandEnvToEliza`) so both work, with the branded one winning where both are set. The source reads `ELIZA_*` and accepts `MILADY_*` as an alias.

**Edit to `/home/shaw/milady/CLAUDE.md`** ("Environment variables" section, lines ~40-67):
- Rename every `MILADY_<X>` to `ELIZA_<X>` (the runtime ones: `MILADY_STATE_DIR`→`ELIZA_STATE_DIR` already paired, `MILADY_CONFIG_PATH`→`ELIZA_CONFIG_PATH`, `MILADY_DISABLE_AUTO_BOOTSTRAP`→`ELIZA_DISABLE_AUTO_BOOTSTRAP`, `MILADY_ENABLE_CHILD_SKILL_CALLBACK`→`ELIZA_ENABLE_CHILD_SKILL_CALLBACK`, `MILADY_APP_VERIFICATION_*`→`ELIZA_APP_VERIFICATION_*`, `MILADY_PROTECTED_APPS`→`ELIZA_PROTECTED_APPS`, `MILADY_APP_LOAD_AUDIT_LOG`→`ELIZA_APP_LOAD_AUDIT_LOG`, `MILADY_BROWSER_VERIFY_OPTIONAL`→`ELIZA_BROWSER_VERIFY_OPTIONAL`, `MILADY_WORKSPACE_DIR`→`ELIZA_WORKSPACE_DIR`, the `MILADY_API_PORT`/`MILADY_PORT`/`MILADY_GATEWAY_PORT`/`MILADY_HOME_PORT`/`MILADY_WECHAT_WEBHOOK_PORT` line, the `MILADY_DESKTOP_*`/`MILADY_RENDERER_URL` mentions, `MILADY_ELIZA_SOURCE`→`ELIZA_SOURCE`? check the actual var name in `scripts/lib/eliza-package-mode.mjs` — it may have stayed `MILADY_ELIZA_SOURCE`, leave it if so).
- Add a one-line note near the top of the section: *"Env vars use the `ELIZA_*` prefix. The branded-app prefix (`MILADY_*`) is still honored and is synced to the `ELIZA_*` name at boot — but `ELIZA_*` is canonical and wins where both are set."*
- Leave non-`MILADY`-prefixed vars unchanged: `EXECUTECODE_*`, `ATROPOS_*`, `PARALLAX_OPENCODE_*`, `NODE_ENV`, `ANTHROPIC_*`, `OPENAI_*` (model defaults), `ELIZA_DISABLE_TRAJECTORY_LOGGING` (already `ELIZA_*`). Spot-check each renamed var actually has an `ELIZA_*` form in the repo (`grep -rln ELIZA_<X> packages/`) before flipping it — most do; `MILADY_RENDERER_URL` and the desktop-dev ones may have stayed `MILADY_*` (they're brand-prefixed UI vars) — verify, don't blind-replace.

(Per CLAUDE.md "Review-First File Writes": this is outside `eliza/`; edit `/home/shaw/milady/CLAUDE.md` directly only after verifying each var's `ELIZA_*` form exists.)

---

## E. Cross-cluster dependencies

- **Cluster 2 (backends/build matrix)** — owns `packages/inference/**` (cuda/vulkan/metal kernels, `build-llama-cpp-dflash.mjs`, `aosp/`, `ios-xcframework/`, the verify Makefile, `kernel-contract.json`, `PLATFORM_MATRIX.md`), and the submodule advance + the cpu/vulkan dispatch-smoke ↔ fork-API reconciliation (their plan says it's "already reconciled"). **C1 must NOT lint-sweep `packages/inference/**` `.ts`/`.mjs`/`.c`/`.cu` until Cluster 2 has landed** — they'll rewrite a lot of it; biome on those files is wasted churn. C1 *does* fix: the `biome.json` submodule exclusion, the `packages/inference/tsconfig.json` empty-include, the JSON-artifact format/ignore decision. Once Cluster 2 is done, C1 finishes the lint pass on their files. Their plan explicitly asks C1 to "keep the build scripts + new adapters `tsc`/`biome` clean" — that's the post-Cluster-2 sweep.
- **Cluster 3 (models/training)** — owns `packages/training/**` (the `uv.lock`, `pyproject.toml`, the SFT scripts). C3 might add a `[train]` dep → `uv.lock` change; coordinate. C3's plan flags **Liger broken** (Triton can't JIT without `python3.12-dev`) and asks "Cluster 1?" to fix the python env — that's plausibly in C1's "python test deps" scope: `apt install python3.12-dev` in the relevant Docker/CI images / a `scripts/` setup step. Decide ownership with C3. C1 must NOT lint-sweep `packages/training/**` TS until C3 is done.
- **Cluster 4 (structured decode)** — owns `dflash-server.ts`, `engine.ts`, `structured-output.ts`, `dflash-structured.test.ts`, `structured-output.test.ts`, `response-grammar.ts`, `ensure-local-inference-handler.ts`, the `server-structured-output.mjs` kernel patch (all currently dirty in `git status`). **C1 must NOT touch those files** (lint or otherwise) until C4 lands — heavy rewrites incoming. C4's plan notes the env var `MILADY_LOCAL_GUIDED_DECODE` — when C1 does the parent-CLAUDE.md `ELIZA_*` rename, that one may need `ELIZA_LOCAL_GUIDED_DECODE` (check the actual var name C4 settles on; it's not in the parent CLAUDE.md today so it may not matter for this task).
- **Cluster 5 (e2e duet + emotion)** — adds new files: `voice-duet.mjs`, `voice-duet.e2e.test.ts`, `latency-trace.ts`, `voice/expressive-tags.ts`, edits `manifest/schema.ts`, `voice-interactive.mjs`. Their plan explicitly depends on C1 fixing the `conversation-registry`/`fs-promises` mock leak (§C) so `bun test packages/app-core/src/services/local-inference` (where the duet test lives) is green, and on C1 keeping their new files lint+typecheck-clean (post-landing sweep, same as the others).
- **Net for C1's lint sweep order:** do `scripts/`, repo-root `test/`, `plugins/app-lifeops`, `plugins/app-training`, `packages/benchmarks`, and the many small plugin/package dirs FIRST (no cluster owns those); do `packages/inference/**`, `packages/training/**`, and the `dflash`/`structured-output`/`response-grammar` files LAST, after Clusters 2/3/4 report done. Track which-cluster-owns-what so the sweep doesn't fight an in-flight rewrite.

---

## F. Blocked / open

- Nothing hard-blocked. `vulkan-dispatch-smoke` *runtime* evidence needs a Vulkan llama.cpp build (Cluster 2's box / a Linux Vulkan host) — but the *compile* part is Cluster-1-tractable and the Makefile gating is already honest. `cpu-dispatch-smoke` is ✅ locally now.
- The `ci.yaml` workflow doesn't run on `develop` pushes — so its `typecheck`/`lint`/`format:check` gate isn't currently enforcing anything on `develop`. Worth a maintainer decision (re-enable on develop?) but out of pure-cleanup scope; flag it.
