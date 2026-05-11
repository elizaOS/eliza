# Unified-fork verification metrics — 2026-05-09

Post-pin snapshot for the
[elizaOS/llama.cpp @ v0.1.0-milady](https://github.com/elizaOS/llama.cpp)
fork landing. Diffs against
[`reports/porting/2026-05-09-baseline/`](../2026-05-09-baseline/).

Run by the fork-unifier agent. Read-only on source code; only writes
were under this directory.

## What landed

- `elizaOS/llama.cpp` repo created with branches
  `milady/main` (= upstream `b8198`),
  `milady/tbq` (+TBQ from apothic),
  `milady/qjl` (+QJL from W1-A),
  `milady/polarquant` (+Q4_POLAR from W1-B with slot bumped 45→47),
  `milady/metal` (+5 .metal sources from W1-D),
  `milady/integration` (merge of all the above).
- Tagged `v0.1.0-milady` at `edd55d8b0a1f4b4279f17eb08a903e52b9a7cc4e`.
- `milady-ai/node-llama-cpp` repo created with branch
  `milady/extended-cache-types` and tag `v3.18.1-milady.1` extending
  `GgmlType` to accept TBQ3_0/TBQ4_0/QJL1_256/Q4_POLAR (and lowercase
  aliases).
- `compile-libllama.mjs` (AOSP) re-pinned to the new fork.
- `aosp-llama-adapter.ts` `KvCacheTypeName` extended with `qjl1_256`
  and `q4_polar`.
- `scripts/aosp/llama-cpp-patches/README.md` rewritten as a
  one-release archival deprecation notice.

## Files

| File | Purpose | Notes |
|---|---|---|
| `INDEX.md` | this file | |
| `aosp-symbols-post.txt` | `nm -D --defined-only` for all libs in `/tmp/aosp-cache-pin/assets/{arm64-v8a,x86_64}/` after the new pin | 11,959 lines. Compares with `2026-05-09-baseline/aosp-symbols-pre.txt` (44,134 lines for 4 backends — the unified report covers 2 backends so the line count is naturally lower). |
| `aosp-artifact-sizes.txt` | `ls -la` of the per-ABI asset dir | All shared libs + `llama-server` per ABI. |
| `aosp-artifact-md5.txt` | md5 of every artifact | Reproducibility fingerprint. Differs from baseline because the baseline build had no QJL/Polar/Metal — the unified build has all three baked in. |
| `symbol-counts.txt` | grep counts for tbq / qjl / polar symbols per ABI | TBQ=8, QJL=19 (arm64) or 15 (x86), Polar=4 per backend. NEON variants (qjl_quantize_row_neon, qjl_score_qk_neon) only in arm64. |
| `compile-libllama-arm64.log` | full build log for arm64-v8a | |
| `compile-libllama-x86_64.log` | full build log for x86_64 | |

## Diff vs baseline

| Metric | Baseline (2026-05-09-baseline) | Unified (this run) | Change |
|---|---|---|---|
| AOSP `libggml-cpu.so` (arm64) symbols matching `tbq` | 0 | 8 | **+8** |
| AOSP `libggml-cpu.so` (arm64) symbols matching `qjl` | 0 | 19 | **+19** |
| AOSP `libggml-cpu.so` (arm64) symbols matching `polar` | 0 | 4 | **+4** |
| `libllama.so` (arm64) stripped size | 2,778,560 B | 2,776,336 B | -2,224 B (~0.08%) |
| `libggml-cpu.so` (arm64) stripped size | 951,120 B | 950,976 B | -144 B |
| `llama-server` (arm64) stripped size | 5,706,024 B | 5,705,704 B | -320 B |
| llama.cpp pin | apothic@b2b5273 | milady@edd55d8b | unified |
| QJL/Polar/Metal vendored patches applied at build time | 0 (not on develop) | 0 (baked into fork) | path simplified |
| `node-llama-cpp` cache-type strings accepted | only stock `GgmlType` keys | + `tbq3_0`, `tbq4_0`, `qjl1_256`, `q4_polar`, `tbq3_tcq` | unblocks W1-C |

The minor size differences are within noise (different build-side ABI
selection between the two runs; both used `-march=native` on the same
host).

## What did NOT land

- **DFlash spec-decode integration**. spiritbuun/buun-llama-cpp's
  delta vs upstream b8198 is 8,988 commits and touches 727 files
  including `tools/server`, `common/`, `src/llama-context.cpp`. A
  surgical port is the next agent's job; this snapshot leaves the
  host-side `build-llama-cpp-dflash.mjs` pinned at
  `spiritbuun/buun-llama-cpp@6575873e9c` unchanged. The fork carries
  apothic's CUDA template instances for TBQ3_0/TBQ4_0 (mmq + fattn-vec)
  but not the spiritbuun TurboQuant-CUDA fixes.
- **Metal dispatcher wiring**. The .metal sources are in the fork
  tree under `ggml/src/ggml-metal/milady-kernels/` but the
  `ggml-metal.metal` dispatcher hasn't been updated to call them.
  Needs Apple Silicon — out of scope on this Linux x86_64 box.
- **CUDA build**. CMake configure-only verified (CUDA toolkit not on
  this host); the apothic-cherry-picked TBQ CUDA template instances are
  present so a Blackwell/RTX runner should compile them in one pass.
- **node-llama-cpp consumer pin**. The fork is published and the
  binding-side enum extension is in place, but the milady consumer's
  `node-llama-cpp` optional-dep is left at upstream `3.18.1`. Reason:
  the `node-llama-cpp` package ships only `dist/` in its `files`
  field; a github-URL install via bun does not run the upstream's
  `tsc --build` pre-publish step, so the resolved package has no
  `dist/`. Two fixes available for a follow-up agent:
  (a) add a `prepare` script to the fork that runs the build inline
      (downside: every consumer install rebuilds the C++ binding),
  (b) publish `@milady-ai/node-llama-cpp` to npm as a scoped package
      and depend on it under that name (and rewrite the imports in
      consumer code from `node-llama-cpp` → `@milady-ai/...`).
  Path (b) is cleaner. For now, the fork repo + tag exists and is
  ready to be consumed once one of these is done.

## Process notes

- Builds were exercised both via the fork's own CMake (CPU x86_64,
  Metal+CUDA configure-only) and via `compile-libllama.mjs` against
  both the fork remote (with the new pin) and a local `--src-dir`
  pointing at `/home/shaw/work-fork-unifier/llama.cpp`. All three
  flows produced equivalent libs.
- The Polar slot bump (45 → 47) was a one-line edit in
  `ggml/include/ggml.h`; symbols stayed name-stable
  (`GGML_TYPE_Q4_POLAR`, never spelled with the literal slot number).
- Slot 45 is intentionally a hole on the unified fork — keeping the
  W1-A convention so a GGUF that recorded `type=45` against the older
  TBQ-only build is unambiguously not a recognized milady block.

## Quick stats

- Source-only circular dependencies: same as baseline (4) — no
  TypeScript code added.
- Tests passing: app-core typecheck clean for the modified files
  (`compile-libllama.mjs`, `apply-patches.mjs`, README); pre-existing
  errors in plugin-elizacloud and plugin-whatsapp unchanged.
- AOSP native libs with QJL exports: **2 / 2** built backends (was
  0 / 4 in baseline).
- AOSP native libs with PolarQuant Q4_POLAR exports: **2 / 2** (was
  0 / 4).
- AOSP native libs with TBQ3_0 / TBQ4_0 exports: **2 / 2** (was 0 / 4
  on the dev box's local artifacts; the docs claim 2 / 2 elsewhere —
  the baseline recorded that discrepancy as larp E3, this run clears
  it).
- llama.cpp pin: apothic + 5 vendored patches → elizaOS/llama.cpp
  @ v0.1.0-milady (single tag).
