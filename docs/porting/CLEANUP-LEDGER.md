# Cleanup ledger — post Wave 3

> Single source of truth for the next cleanup-execute pass. Everything below is
> a read-only audit of the state *after* Wave 1 / 2 / 3 landed. Tags:
> **[HIGH]** = blocker / data loss / shipped misclaim, **[MED]** = real debt
> with a clear fix, **[LOW]** = nice-to-have / cosmetic.
>
> Conventions: file paths absolute from repo root (the `eliza/` checkout under
> `~/milady/`). All claims cite `path:line`.

---

## 1. Unmerged worktree branches (5 dangling locals, none on origin)

`git ls-remote origin` confirms none of these five refs exist on origin; they
are local-only.

| Branch | Tip commit | Verdict | Recommendation |
|---|---|---|---|
| `worktree-agent-a1402895150138b18` | `3d992107d4 feat(catalog): add tokenizerFamily="qwen3" to bonsai DFlash pair` | **SUPERSEDED** | `tokenizerFamily: "qwen3"` is already on develop at `packages/app-core/src/services/local-inference/catalog.ts:268,313,356,392`. Local has additional unpushed commits (`a937626417`, `5155daf9b3`) that diverge from origin's same name; those also already landed via Wave-1. **[LOW] Delete.** |
| `worktree-agent-a3b48813556536b5d` | `04a3fdb24d feat(catalog): add tokenizerFamily field + DFlash-pairing test guard` | **SUPERSEDED** | Identical change set: catalog already has `tokenizerFamily` on every relevant entry (24 occurrences in `packages/ui/src/services/local-inference/catalog.ts`); test guard `it("sets a tokenizerFamily on every chat/code/reasoning entry")` exists at `packages/app-core/src/services/local-inference/catalog.test.ts:85`. **[LOW] Delete.** |
| `worktree-agent-a4af68887afcc1b30` | `dc6d1d34c0 W3-D: CUDA toolkit install + compile-only validation of milady-ai/llama.cpp v0.1.0-milady` | **MERGE-CANDIDATE** (reports only) | 17 of the 19 W3-D report files are still untracked in the main worktree (see §2). The two files that did land (`vulkan-compile-only.md`, `windows-cross-build.md`) came in via a different W3 commit. **[MED] Cherry-pick the CUDA reports as a single `chore(reports): W3-D CUDA compile-only` commit, then delete branch.** |
| `worktree-agent-a55644a05aeeed035` | `f674c14160 feat(aosp-llama): add qjl1_256 KV cache type + auto-detect` (4 commits) | **SUPERSEDED** | `packages/native-plugins/qjl-cpu/` (CMakeLists, scalar+SIMD sources, README, bench) is fully present on develop. The `aosp-llama-adapter.ts:863-892` qjl1_256 KV cache wiring is also live (`active-model.ts:133` lists `"qjl1_256"`). Branch's `aosp-llama-adapter.ts` patch targets a now-deleted path — that file moved to `plugins/plugin-aosp-local-inference/src/aosp-llama-adapter.ts:1-46` via commit `a2f0025e1f`. **[LOW] Delete.** |
| `worktree-agent-a58ffa46f33215b6a` | `1b5cc3f03e chore(tsconfig): map @elizaos/capacitor-llama subpaths in ui` (4 commits) | **SUPERSEDED-WITH-CAVEAT** | The work (Capacitor Llama in-WebView kernel, ios→generic local-agent rename, `kv-cache-resolver.ts`, gating `ElizaAgentService` on `AOSP_BUILD`) clearly landed: `packages/native-plugins/llama/src/{capacitor-llama-adapter,kv-cache-resolver}.ts` exist; `packages/ui/src/api/local-agent-kernel.ts` is the rename target. The branch still diffs against the deleted `packages/agent/src/runtime/aosp-llama-adapter.ts`, so a naive merge would conflict. **[LOW] Delete after one-pass diff to confirm no orphaned hunks.** |

**Action:** delete all 5 local refs after pulling the W3-D reports onto develop.
Total cleanup: `git branch -D worktree-agent-{a1402895150138b18,a3b48813556536b5d,a4af68887afcc1b30,a55644a05aeeed035,a58ffa46f33215b6a}`.

---

## 2. Untracked files in main worktree

`git status` (eliza/) lists **13 untracked files** all under
`reports/porting/2026-05-09-w3/`:

```
all-cu-files.txt           build-bin-listing.txt   build-bin-md5.txt
cmake-version.txt          cuda-compile-only.md    cuda-symbols-tbq-qjl-polar.txt
nvcc-version.txt           per-kernel-status.tsv   probe-cuda-compile-only.sh
ptx-tbq-md5.txt            ptx-tbq-sample-tbq3_0-tbq3_0-sm80-head200.ptx
ptx-tbq-sample-tbq3_0-tbq3_0-sm80-tail30.ptx       test-cuda-compile-only.cmake.patch
```

Plus 4 larger logs already committed but currently re-listed by the W3-D branch
(`build-cuda-ggml.log`, `build-llama-and-server.log`, `cmake-configure.log`,
`ptx-tbq-probe.log`).

**Recommendation [HIGH]: commit these as `chore(reports): W3-D CUDA
compile-only artifacts` to develop.** They are the evidence that
`milady-ai/llama.cpp v0.1.0-milady` builds cleanly under CUDA 12.6 (167/167
.cu files) — losing them re-creates a multi-hour install + build dance for the
next agent who needs to verify the unified fork.

No other agent leakage detected outside this worktree's own scratch (the
`.claude/worktrees/agent-*/` siblings each have their own dirty state, but
those are orthogonal to develop).

---

## 3. Twin local-inference namespaces (`app-core` vs `ui`)

`packages/app-core/src/services/local-inference/` (45 files, 4,920 lines) and
`packages/ui/src/services/local-inference/` (32 files, 2,803 lines) are largely
duplicated. The `ui` copy was created when the React shell was extracted; it
has *zero* files that don't also exist in `app-core`. Most "ui-only" features
are stripped-down forks of the `app-core` originals — same exports, smaller
surface, drift accumulating.

### 3a. Server-only (keep in app-core) — 13 files

`active-model.runtime.test.ts`, `backend.{ts,test.ts}`,
`cache-bridge.{ts,test.ts}`, `conversation-registry.{ts,test.ts}`,
`dflash-cache-flow.test.ts`, `dflash-doctor.test.ts`,
`llama-server-metrics.{ts,test.ts}`, `session-pool.ts`, `__stress__/`. Backend
runtime, llama-server lifecycle, KV cache I/O — all node-only.

### 3b. UI-only — none.

### 3c. Identical duplicates (byte-for-byte) — collapse

11 files where `diff` reports zero lines of difference:

- `assignments.ts` (211 LOC each)
- `bundled-models.ts` (116)
- `downloader.ts` (486)
- `external-scanner.ts` (312)
- `hf-search.ts` (235)
- `paths.ts` (46)
- `readiness.ts` (238)
- `registry.ts` (136)
- `routing-policy.ts` (227)
- `routing-preferences.ts` (113)
- `verify.ts` (128)

**[HIGH] Move these 11 files to `packages/shared/src/local-inference/` (or a
new `packages/local-inference-shared/`), import from both consumers.** Total
saved: ~2,250 lines. They are pure-data utilities (catalog access, file system
paths, scanner glue) with no DOM/Node fork.

### 3d. Near-identical (drifted, ≤30 lines diff) — **[MED]** ui copy fell behind

`device-bridge.ts` (1,109 vs 1,099), `dflash-doctor.ts` (173 vs 163),
`hardware.ts` (170 vs 173), `index.ts` (52 vs 34). Several (`dflash-doctor`,
`router-handler`, `routing-policy`) are knip-flagged unused on the ui side —
the ui copy is dead.

### 3e. Genuinely divergent — extract types, keep two implementations

- `engine.ts` (791 vs 287) — app-core full node-llama-cpp + DFlash; ui facade.
- `dflash-server.ts` (1,333 vs 555) — app-core spawns llama-server; ui types.
- `active-model.ts` (563 vs 216) — app-core full validator; ui status reader.
- `catalog.ts` (642 vs 459) — app-core 27 entries (incl. hidden drafters); ui
  24 user-visible. Should be one catalog with `hiddenFromCatalog` flag.
- `types.ts` (410 vs 320) — diverged for no reason. **[HIGH] Extract to
  `@elizaos/shared/local-inference/types.ts`.**
- `service.ts`, `recommendation.ts`, `providers.ts`, `handler-registry.ts`,
  `router-handler.ts` — 30-150 line drift each; canonical = app-core.

**Net plan:** create `packages/shared/src/local-inference/{types.ts,catalog.ts,
hardware.ts,paths.ts,registry.ts,routing-{policy,preferences}.ts,verify.ts,
assignments.ts,bundled-models.ts,downloader.ts,external-scanner.ts,
hf-search.ts,readiness.ts}` and have both `app-core` and `ui` import from
there. Estimated reduction: ~3,500 lines deleted, twin drift problem removed.

---

## 4. Plugin organization

W2-H confirmed `plugin-local-inference` and `plugin-local-ai` are alive.
Re-verified:

- `plugin-local-inference` — `packages/agent/src/api/{server,chat-routes,health-routes}.ts`, `packages/agent/package.json:105`.
- `plugin-local-ai` — `packages/agent/src/runtime/plugin-collector.ts:144`, `platforms/electrobun/electrobun.config.ts:253`, `packages/examples/autonomous/autonomous.ts:19`.
- `plugin-aosp-local-inference` — `packages/agent/src/{bin,cli/index,runtime/eliza}.ts`, `app-core/.../ensure-local-inference-handler.ts:334`.
- `plugin-local-embedding` — `agent-runtime.live.e2e.test.ts:422`, `configbench/.../eliza.ts:633`, electrobun bundler.

All four alive. **[INFO]** No deletions.

### 4a. Naming

`local-inference/kernels/` → `packages/inference/` rename is done
(`packages/inference/package.json` = `@elizaos/inference`). Worktree-scratch
clones at `.claude/worktrees/agent-*/local-inference/kernels/` are
out-of-tree. The split `inference` (kernels) vs `local-inference` (service +
plugins) is intentional. **[LOW]** No further renames.

---

## 5. Documentation duplication (`docs/porting/*.md`)

5 docs, ~1,757 lines total. `unified-fork-strategy.md:7` self-declares as
"successor doc to `on-device-quantization-porting-plan.md`". The plan is
referenced from `packages/native-plugins/{qjl-cpu,polarquant-cpu}/README.md`
so deletion would orphan links.

| Doc | Lines | Lens |
|---|---|---|
| `on-device-quantization-porting-plan.md` | 501 | "what we promised to ship" |
| `unified-fork-strategy.md` | 394 | "what the fork composes" |
| `build-matrix.md` | 410 | per-(platform,ABI,GPU) status cells |
| `dflash-drafter-strategy.md` | 174 | tokenizer pairing analysis |
| `benchmark-harness.md` | 278 | profile-inference.mjs ref |

**[MED]** Keep all five; add `docs/porting/STATUS.md` as a 1-page index. If
forced to merge: fold `dflash-drafter-strategy.md` into the porting plan
§G (already a subsection there).

---

## 6. TODO / FIXME / HACK survey (inference scope)

Full repo grep (excluding `node_modules`, `dist`, `.git`, `.cache`, `.claude`,
`docs`, `cloud`, `test`) for `TODO|FIXME|HACK|XXX` in
`*.{ts,tsx,c,h,cu,metal,comp,mjs}` filtered to inference/llama/kv keywords:

| File | Line | Marker | Classification |
|---|---|---|---|
| `packages/native-plugins/qjl-cpu/test/qjl_bench.c` | 315 | `TODO: NEON throughput TBD on cuttlefish/arm64 (see README).` | **Defer.** Real-hardware bench note; W3-D landed CUDA compile-only, NEON throughput requires arm64 device. Keep as-is. |
| `packages/app-core/src/connectors/capacitor-{quickjs,jsc,sqlite}.ts` | 1 | `TODO(native): Swift/Kotlin implementation pending` | **Defer.** Out-of-scope for inference cleanup; tracked under the Capacitor connector area. |
| `packages/app-core/scripts/build-llama-cpp-dflash.mjs` | 374 | `TODO(milady-ai/llama.cpp): land an upstream fix that either (a) moves...` | **Already-done-just-stale-comment.** Build script TODO references upstream behavior that the unified fork (`v0.1.0-milady` / `v0.2.0-milady`) now controls. **[LOW] Replace TODO with a reference to the fork commit.** |
| `plugins/plugin-sql/src/schema/embedding.ts` | 11, 20, 40 | `XXXL: 3072` (token marker, not a TODO) | **Already-done-just-stale-comment.** False positive — `XXXL` is the schema enum tier, not a marker. **[LOW] No action.** |
| `plugins/plugin-wallet/src/analytics/birdeye/providers/market.ts` | 129 | `FIXME: cache (how fresh does this have to be?)` | Out-of-scope (wallet, not inference). |

**Inference-scope debt:** functionally one real TODO (`qjl_bench.c:315`,
explicitly waiting for hardware bench) and one stale build-script comment.
**[LOW] Net.**

---

## 7. Dead code (knip diff vs baseline)

Baseline knip: 2,619 unused files, 259 unused deps, 3,932 unused exports
(`reports/porting/2026-05-09-baseline/knip.txt`). Current knip after Waves
1+2+3: **1,134 unused files** (`/tmp/knip-current.txt`). Net reduction:
**~1,485 unused files removed across the cleanup waves.**

### Resolved since baseline (no longer flagged)

`build-native-plugins.mjs`, `app-core/.../dflash-doctor.ts` (wired to
`cli/program/register.doctor.ts`), `app-core/.../index.ts`,
`native-plugins/shared-types.ts`, `ui/.../dflash-doctor.ts`,
`ui/.../{index,router-handler,routing-policy}.ts`,
`plugin-local-ai/{index.browser,index.node,index.d}.ts`,
`plugin-local-ai/generated/specs/specs.ts`,
`plugin-local-{ai,embedding}/.../utils/runtime_test.ts`.

### Dead files still present after Wave 3

| File | Recommendation |
|---|---|
| `packages/native-plugins/llama/src/web.ts` | **[MED] Delete.** Knip-flagged in baseline AND current. Browser stub for capacitor-llama; the WebView path now flows through `packages/native-plugins/llama/src/capacitor-llama-adapter.ts` and `definitions.ts`. |
| `packages/native-plugins/{camera,canvas,desktop,gateway,location,screencapture,swabble,talkmode}/electrobun/src/index.ts` (8 files) | **[LOW] Delete.** Knip-flagged in both. Each is an electrobun stub for a connector path that doesn't ship in the desktop bundle. |
| `packages/native-plugins/macosalarm/__tests__/integration.macos.test.ts`, `vitest.config.ts` | **[LOW] Wire or delete.** New since baseline. macOS-only test that's never run in CI. |
| `packages/native-plugins/{swabble,talkmode}/electrobun/src/global.d.ts` | **[LOW] Delete.** Companion stubs to the index.ts above. |

### Dead exports surviving (top inference-area hits)

From `/tmp/knip-current.txt` filtered to `local-inference|native-plugins`:

- `packages/app-core/src/services/local-inference/active-model.ts:129` — `isForkOnlyKvCacheType`, `isStockKvCacheType`, `validateLocalInferenceLoadArgs` flagged unused. Spot-check shows they ARE used in `active-model.test.ts:230`. **Knip false positive (test-only consumer).** [LOW] Add to knip ignore.
- `packages/app-core/src/services/local-inference/dflash-server.ts:152,520,589` — `readDflashBinaryCapabilities`, `appendOptimizationFlags`, `DflashLlamaServer`. Class is exported for tests and for `cli/dflash-doctor` consumers. **[LOW] False positive.**
- `packages/ui/src/services/local-inference/{assignments,device-bridge,dflash-server,handler-registry,providers,routing-preferences,service,types,verify}.ts` — most exports flagged. These are the UI twin's leftovers; collapsing per §3 deletes them.

**Net knip remediation budget:** ~10 file deletes ([MED]/[LOW]) + the
~3,500-line ui/app-core dedup in §3 will collapse another ~50 export warnings.

---

## 8. Larp inventory residual (12 HIGH / 12 MED / 10 LOW from baseline)

Walking `reports/porting/2026-05-09-baseline/larp-inventory.md` against current
state. **R = resolved**, **U = unresolved**, **P = partial**.

### A. Catalog / runtime metadata (6: 3H/2M/1L)

| ID | Status | Evidence |
|---|---|---|
| A1 — `contextLength` plumbing for 128k | **P** | Catalog now sets `contextLength: 131072` on advertised entries; `engine.ts:135-342` honors `cacheTypeK/V` overrides. The 4 hidden DFlash drafters (`bonsai-8b-dflash-drafter`, `qwen3.5-{4,9}b-dflash-drafter-q4`, `qwen3.6-27b-dflash-drafter-q8`) still don't declare `contextLength` (`catalog.ts` per-entry inspection). **[MED] Add `contextLength` to all four drafter entries.** |
| A2 — `POST /api/local-inference/active` rejects KV overrides | **R** | `local-inference-compat-routes.ts:147` enumerates `["cacheTypeK","cacheTypeV"]` overrides; `:662-686` accepts them on POST. |
| A3 — TurboQuant KV-cache desktop drop | **R** | `engine.ts:78-79` and `:334-342` thread `cacheTypeK/V` through `model.createContext`. Verified via the `node-llama-cpp@v3.18.1-milady.3` pin in develop's commit `22856d0e5`. |
| A4 — Recommendation hardcoded ladders | **P** | `recommendation.ts:257` now reads `hardware.gpu?.totalVramGb`; ladders are still per-platform static (`recommendation.ts:13-99`). **[LOW] Generate ladders from catalog metadata or accept as design.** |
| A5 — Downloader disk-quota pre-flight | **U** | `grep -n "statfs\|diskFree\|ENOSPC" downloader.ts` returns nothing. **[MED] Add pre-flight `fs.statfs` check.** |
| A6 — Tokenizer-family test guard | **R** | `catalog.test.ts:85-119` asserts `tokenizerFamily` matches between every target and its drafter. |

### B. Provider / slot (3: 0H/1M/2L)

| ID | Status | Evidence |
|---|---|---|
| B1 — `TEXT_EMBEDDING` slot in local provider | **R** | `providers.ts:94,128,198` — three provider definitions list `TEXT_EMBEDDING` in `supportedSlots`. |
| B2 — DFlash streaming hard-disabled | **U** | `dflash-server.ts:1224` still `stream: false`. **[MED] Either wire SSE through or document the permanent reason.** |
| B3 — `category: "tools"` on `hermes-3-llama-8b` | **U** | (Not re-verified; left for cleanup-execute. **[LOW]**) |

### C. Plugin layout (6: 1H/2M/3L)

| ID | Status | Evidence |
|---|---|---|
| C1 — `plugin-local-inference` is stub | **R-by-correction** | W1-H/W2-H established the plugin IS alive; the audit was wrong. `index.ts` is intentionally a 10-line re-export wrapping `local-inference-routes.ts` (1100+ LOC of HTTP route impl). **No action.** |
| C2 — `plugin-local-ai` legacy | **R-by-correction** | Same pattern. Used by `plugin-collector.ts:144`, electrobun bundle, autonomous example. |
| C3 — `plugin-local-embedding` partial-dead | **R-by-correction** | Used by configbench + agent live e2e + electrobun. Unused deps (`whisper-node`, `nodejs-whisper`, `stream-browserify`) per knip scoped — **[MED] still drop those three deps.** |
| C4 — `native-plugins/llama/src/web.ts` unused | **U** | Still flagged by current knip. **[MED] Delete.** |
| C5 — `native-plugins/shared-types.ts` unused | **R** | File no longer present. |
| C6 — Multiple `electrobun/src/index.ts` files unused | **U** | All 8 still present and knip-flagged. **[LOW] Delete.** |

### D. Service-layer (2: 0H/1M/1L)

| ID | Status | Evidence |
|---|---|---|
| D1 — `dflash-doctor.ts` UI twin dead | **P** | App-core copy wired; UI twin still exists at `packages/ui/src/services/local-inference/dflash-doctor.ts`. **[MED] Delete UI twin per §3.** |
| D2 — Both `index.ts` flagged | **R** | UI re-exports collapsed; current knip no longer flags them. |

### E. Native libraries (4: 4H/0M/0L)

| ID | Status | Evidence |
|---|---|---|
| E1 — QJL CPU kernels not in libllama.so | **R** | `reports/porting/2026-05-09-unified/symbol-counts.txt`: 19 QJL symbols on arm64-v8a, 15 on x86_64. |
| E2 — PolarQuant block_q4_polar not in libs | **R** | Same: 4 Polar symbols on each. |
| E3 — TBQ symbols missing | **R** | Same: 8 TBQ symbols on each ABI. |
| E4 — `libeliza-llama-shim.so` not built | **R** | `aosp-symbols-post.txt:6011-6012` — `eliza_llama_context_params_set_type_k`, `eliza_llama_context_params_set_type_v` exported. |

### F. GPU kernels (3: 2H/1M/0L)

| ID | Status | Evidence |
|---|---|---|
| F1 — Vulkan turbo3/turbo4/turbo3_tcq 0/8 PASS | **P** | `reports/porting/2026-05-09-w3/vulkan-compile-only.md` shows compile + lavapipe baseline; runtime PASS on real GPU still pending. **[HIGH] Hardware verification still required.** |
| F2 — Metal kernels DRAFT, never run on hardware | **U** | `packages/inference/README.md:1-30` is explicit: "DRAFT — COMPILED ONLY ON LINUX, NOT VALIDATED ON GPU HARDWARE." **[HIGH] Real Apple Silicon validation required.** |
| F3 — Verification fixtures from C reference, not CUDA | **P** | `packages/inference/verify/{vulkan_verify,metal_verify}.{cpp,mm}` exist; CUDA-generated fixtures are not yet checked in. **[HIGH] Run `gen_fixture` against CUDA.** |

### G. DFlash (3: 1H/1M/1L)

| ID | Status | Evidence |
|---|---|---|
| G1 — `--metrics` never scraped | **R** | `dflash-server.ts` imports `llama-server-metrics` (`:35`), tracks `n_drafted`, `n_drafted_accepted` (`:122-125`), and the usage block synthesises from `/metrics` (`:1197-1201`). |
| G2 — AOSP DFlash llama-server never staged | **P** | `~/.eliza/local-inference/bin/dflash/{android-arm64-{cpu,vulkan},linux-x64-{cpu,vulkan},windows-x64-cpu}/` populated locally; CI rebuild pipeline status unknown. **[MED]** |
| G3 — `maybeRepairDflashDrafter` redundant | **U** | Still in `dflash-server.ts`; W2 acceptance was "keep as safety net" — confirmed deferred. **[LOW]** |

### H. iOS / macOS Metal (3: 0H/3M/0L)

| ID | Status | Evidence |
|---|---|---|
| H1 — iOS Metal opaque (npm prebuilt) | **U** | No own iOS framework build pipeline; `build-llama-cpp-dflash.mjs` still excludes iOS targets. **[MED]** |
| H2 — `setSpecType` not feature-detected | **R** | `capacitor-llama-adapter.ts:87,191` — `setSpecType?:` optional + `typeof plugin.setSpecType === "function"` guard. |
| H3 — `setCacheType` warn-and-continue | **R** | `capacitor-llama-adapter.ts:79,186-189` — same feature-detect pattern, surfaces back to caller. |

### I. KV / prompt cache (3: 0H/1M/2L)

| ID | Status | Evidence |
|---|---|---|
| I1 — Cache key fallback to `""` silent | **U** | `cache-bridge.ts:235-242` still returns `null` silently; no log/counter wired. **[MED]** |
| I2 — Disk eviction once at startup | **U** | `cache-bridge.ts:150` defines `evictExpired`; no periodic scheduler in `dflash-server.ts`. **[LOW]** |
| I3 — No conversation→session pinning | **R** | `conversation-registry.ts:75-233` — `ConversationRegistry` exposes the API. W2 cache-stress report confirms 99.90% warm-only hit rate at parallel=16. |

### J. Bench harness (1: 1H)

| J1 — Per-call cache-type override unsupported | **R** | Same fix as A2. |

### Tally

| Category | Total | Resolved | Partial | Unresolved | High remaining | Med remaining | Low remaining |
|---|---|---|---|---|---|---|---|
| A | 6 | 2 | 2 | 2 | 0 | 3 | 1 |
| B | 3 | 1 | 0 | 2 | 0 | 1 | 1 |
| C | 6 | 4 | 0 | 2 | 0 | 2 | 1 |
| D | 2 | 1 | 1 | 0 | 0 | 1 | 0 |
| E | 4 | 4 | 0 | 0 | 0 | 0 | 0 |
| F | 3 | 0 | 2 | 1 | 3 | 0 | 0 |
| G | 3 | 1 | 1 | 1 | 0 | 1 | 1 |
| H | 3 | 2 | 0 | 1 | 0 | 1 | 0 |
| I | 3 | 1 | 0 | 2 | 0 | 1 | 1 |
| J | 1 | 1 | 0 | 0 | 0 | 0 | 0 |
| **Total** | **34** | **17** | **6** | **11** | **3** | **10** | **4** |

**Half the larp inventory closed; the GPU-hardware-validation tier (F1/F2/F3)
is the remaining HIGH bucket.**

---

## 9. Reports cleanup recommendation

`reports/porting/2026-05-09-*/` totals **7.7 MB** across four dated subdirs:

| Dir | Size | Contents |
|---|---|---|
| `2026-05-09-baseline/` | 6.4 MB | knip / madge / larp inventory / coverage — **historical evidence the cleanup waves measure against**. |
| `2026-05-09-unified/` | 824 KB | post-W3-A symbol counts confirming TBQ/QJL/Polar shipped. |
| `2026-05-09-w2/` | 164 KB | embedding e2e + cache stress + neon parity. |
| `2026-05-09-w3/` | 288 KB | CUDA + Vulkan + Windows compile-only validation. |

**[LOW] Recommendation: keep as-is.** 7.7 MB is a rounding error against the
14 GB `node_modules`. The reports are append-only audit evidence; consolidating
them loses provenance ("which agent wrote what") and saves nothing meaningful.
A `reports/porting/INDEX.md` summarizing each subdir would help discoverability
but is optional.

---

## 10. Production-quality gate (must-haves still missing)

For the user's explicitly-scoped "production quality" target on local
inference, these are the unresolved blockers:

1. **[HIGH] Real-hardware GPU kernel validation.** `packages/inference/README.md`
   itself says "DRAFT — COMPILED ONLY ON LINUX, NOT VALIDATED ON GPU
   HARDWARE." Required: Apple Silicon `metal_verify` 8/8 PASS, real Intel/AMD
   Vulkan `vulkan_verify` PASS against CUDA-generated fixtures, NVIDIA real-GPU
   smoke (W3-D was compile-only).

2. **[HIGH] CUDA-generated fixtures.** `packages/inference/verify/gen_fixture`
   exists but the C-reference variant is what's checked in. F3 acceptance:
   regenerate from real CUDA build, commit, then any kernel "PASS" actually
   means CUDA parity.

3. **[HIGH] 128k KV-cache offload measured end-to-end.** `contextLength:
   131072` is set in catalog and threaded through `createContext`, but no
   bench output proves a 128k turn round-trips cleanly with KV offload (TBQ
   on V + QJL1_256 on K) on a single phone or desktop.

4. **[HIGH] Prompt-cache hit rate under load.** `__stress__/cache-100conv-stress`
   reports 89.91% / 99.90% warm-only at N=100, parallel=16 in vitest. A
   measurement under real concurrent agent load (multiple conversations,
   real prefill cost, real token throughput numbers) is missing — current
   data is synthetic.

5. **[HIGH] Embedding parity numbers across backends.** W2-H confirms
   `plugin-local-embedding` 3/3 e2e PASS on `nomic-embed-text-v1.5.Q5_K_M.gguf`,
   but cross-platform parity (AOSP arm64 NEON vs x86 AVX2 vs Apple Metal) has
   no committed numbers. Required: golden-vector cosine ≥ 0.9999 across all
   four backends.

6. **[HIGH] Speed/throughput on real hardware.** No tok/s numbers on real
   arm64 device, no DFlash acceptance-rate measurements outside cache-stress
   synthetic. `qjl_bench.c:315` even comments "TODO: NEON throughput TBD".

7. **[HIGH] Benchmark CI green nightly.** `local-inference-bench.yml` workflow
   exists and is `actionlint`-clean per W2-H, but its status against develop
   nightly is unverified — no committed badge, no recent green run logged.

8. **[MED] Hidden DFlash drafter `contextLength`** (A1 partial above).

9. **[MED] Disk-quota pre-flight in downloader** (A5).

10. **[MED] Cache-key fallback observability** (I1) — silent regression vector
    that needs a counter or assertion.

11. **[MED] iOS DFlash framework build pipeline** (H1) — still on vendored
    npm prebuilt; on-device DFlash spec is not provable.

12. **[MED] DFlash streaming via SSE** (B2) — currently hard-coded
    `stream: false`.

---

## Closing checklist for cleanup-execute

In rough priority order:

1. Commit the 13 untracked W3-D CUDA report files. (§2)
2. Delete the 5 local worktree branches. (§1)
3. Collapse the ui/app-core `local-inference` twin: 11 byte-identical files
   to `@elizaos/shared`, plus types extraction. (§3, §8 D1)
4. Delete `packages/native-plugins/llama/src/web.ts` and the 8 electrobun
   stub `index.ts` files. (§7 dead-files, §8 C4/C6)
5. Drop unused deps (`whisper-node`, `nodejs-whisper`, `stream-browserify`)
   from `plugin-local-embedding`. (§8 C3)
6. Add `contextLength: 131072` to the 4 hidden DFlash drafter entries. (§8 A1)
7. Add disk-quota pre-flight to `downloader.ts`. (§8 A5)
8. Add log+counter when `extractPromptCacheKey` falls through. (§8 I1)
9. Wire DFlash streaming SSE OR commit a permanent reason comment. (§8 B2)
10. Stale TODO cleanup: replace `build-llama-cpp-dflash.mjs:374` TODO with
    a fork-commit reference. (§6)

The HIGH residuals from §10 (1-7) are hardware-blocked and out of scope for a
cleanup-execute pass; they are the real production-quality gate.
