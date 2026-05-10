# Patch audit — `build-llama-cpp-dflash.mjs` vs milady-ai/llama.cpp

Date: 2026-05-10
Auditor: bounded read-only audit (no commits, no kernel edits).
Scope: every patch hook in `packages/app-core/scripts/build-llama-cpp-dflash.mjs`,
cross-referenced against the in-tree state of the milady-ai/llama.cpp fork
at the script's pinned ref.

## Pinned fork ref (resolved)

| Item                       | Value                                                                                  |
| -------------------------- | -------------------------------------------------------------------------------------- |
| Remote                     | `https://github.com/milady-ai/llama.cpp.git`                                           |
| Pinned ref (script)        | `v0.4.0-milady` (annotated tag)                                                        |
| Tag-object SHA             | `99ed5f0f93b42b87047b03dc5ef420d0dc2e9c27`                                             |
| Commit the tag points to   | `08032d57e15574f2a7ca19fc3f29510c8673d590` (= current `milady/integration` HEAD)       |
| Tag commit message         | `merge: W4-B CUDA QJL + Polar + TBQ3_TCQ kernels from milady/cuda-extra into milady/integration` |
| Tag date                   | 2026-05-09 22:30:47 -0700                                                              |
| Clone status               | shallow `git clone --depth 1 -b v0.4.0-milady` succeeded                               |

The "verified pin" hash `99ed5f0f` from the original task brief is the
**annotated tag object**, not the commit. The commit it dereferences to
(`08032d57…`) matches `milady/integration` head exactly. There is no
divergence — both refs point at the same code.

## Build-script patch hook inventory

`applyForkPatches(cacheDir, backend, target)` (build-llama-cpp-dflash.mjs:1010)
dispatches to the in-script hooks below. Two impl modules
(`kernel-patches/{metal,vulkan}-kernels.mjs`) are also imported but
**neither is invoked anywhere in the build script** — they are dead
imports. See "Dead imports" section.

| Hook                          | Triggered when                                | Env gate                                  | What it does in the fork                                                                  | In-fork status                                              | Still needed? |
| ----------------------------- | --------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------- |
| `patchVulkanKernels`          | `backend === "vulkan"`                        | `ELIZA_DFLASH_PATCH_VULKAN_KERNELS != 0`  | Logs "fork kernels in sync"                                                               | **MISLEADING** — fork has ZERO `turbo*/qjl*/polar*` `.comp` shaders under `ggml/src/ggml-vulkan/` | Hook itself is no-op; log claim is false. See drift table.   |
| `patchMetalTurbo4`            | `backend === "metal"`                         | `ELIZA_DFLASH_PATCH_METAL_TURBO4 == 1`    | Logs "kernels already present"                                                            | TRUE — `ggml/src/ggml-metal/milady-kernels/tbq4_0.metal` exists | No (no-op log).  |
| `patchMetalTurbo3Tcq`         | `backend === "metal"`                         | `ELIZA_DFLASH_PATCH_METAL_TURBO3 == 1`    | Logs "kernels already present"                                                            | TRUE — `tbq3_tcq.metal` (and `tbq3_0.metal`) present         | No (no-op log).  |
| `patchMetalQjl`               | `backend === "metal"`                         | `ELIZA_DFLASH_PATCH_METAL_QJL == 1`       | Logs "kernels already present"                                                            | TRUE — `qjl.metal` present                                  | No (no-op log).  |
| `patchMetalPolar`             | `backend === "metal"`                         | `ELIZA_DFLASH_PATCH_METAL_POLAR == 1`     | Logs "kernels already present"                                                            | TRUE — `polar.metal` present                                | No (no-op log).  |
| `patchGgmlBaseForWindowsQjl`  | `target` starts with `windows-`               | always (when triggered)                   | Adds `ggml-cpu/qjl/*.c` sources to `ggml-base` so PE/COFF link resolves                   | NOT folded — fork's `ggml/src/CMakeLists.txt:208` still ends `polar_centroids.h\n            gguf.cpp)` (anchor matches)  | **YES — keep.** |
| (DFlash patches)              | n/a                                           | n/a                                       | None — DFlash CLI (`--spec-type dflash`, `--draft-min-prob`, Prom counters) is in-fork    | Confirmed in `tools/server/README.md` and `common/arg.cpp`  | No patch needed. |

## Standalone-vs-fork shader drift (Metal)

All five Metal kernels exist in both places. None are byte-for-byte
identical despite README claims of "byte-for-byte" matches. The
divergences are perf-only (FMA, hoisted loads, parallelized inverse
Hadamard) and do not change numerical results within the published
fixture tolerance. The fork is canonical at runtime; the standalones
are what `metal_verify` actually validated 8/8 PASS against.

| Kernel        | Fork path (relative to fork root)                       | Standalone path (relative to repo root)                | Diff size (lines) | Substantive differences                                                                                                            | Canonical at runtime? | Notes                                                                                                                  |
| ------------- | ------------------------------------------------------- | ------------------------------------------------------ | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| turbo3        | `ggml/src/ggml-metal/milady-kernels/tbq3_0.metal`        | `packages/inference/metal/turbo3.metal`                | ~58               | Standalone hoists per-block byte loads out of the inner loop and uses `fma`. Numerically identical centroid math, both `simd_sum`. | Fork                  | Standalone is faster; fork is what ships. Both pass the same fixture. README "byte-for-byte" overstated.                |
| turbo4        | `ggml/src/ggml-metal/milady-kernels/tbq4_0.metal`        | `packages/inference/metal/turbo4.metal`                | ~38               | Standalone preloads two `qs[]` bytes and uses `fma`. Same `block_turbo4_0` layout (`half norm; uint8_t qs[64]`).                  | Fork                  | Layout claim in README is true; perf-tweak claim of equality is overstated.                                            |
| turbo3_tcq    | `ggml/src/ggml-metal/milady-kernels/tbq3_tcq.metal`      | `packages/inference/metal/turbo3_tcq.metal`            | ~32               | Standalone removes a dead bounds branch and uses `fma`.                                                                            | Fork                  | Both decode the same 9-bit sliding window.                                                                              |
| qjl           | `ggml/src/ggml-metal/milady-kernels/qjl.metal`           | `packages/inference/metal/qjl.metal`                   | ~58               | Standalone uses branchless ±1 sign + `fma`; promotes `tid`/`tg_pos` to `uint3` (Metal compiler attribute-shape requirement).      | Fork                  | The `uint3` attribute promotion was the W3 fix that made the kernel compile at all on Apple — fork shipped that.       |
| polar         | `ggml/src/ggml-metal/milady-kernels/polar.metal`         | `packages/inference/metal/polar.metal`                 | ~190              | **Standalone has a parallel 32-thread Hadamard butterfly (`polar_hadamard_inplace_tg32`); fork still runs it sequentially on tid==0.** Also factors QJL residual sign-vector through threadgroup-shared scratch. | Fork                  | Real perf win unrealized in the fork. Numerically equivalent. See "Conclusions" — flagged for sync sign-off.            |

Per `packages/inference/AGENTS.md` §9 ("Mirror the references bit-for-bit"):
the bit-for-bit mirror is the *C reference + JSON fixture*, not the
fork shader. Both standalone and fork pass the same fixture, so the
8/8 PASS report is honest for the standalone but technically untested
for the fork's slightly-different inner loop. **Recommend a one-time
re-run of `metal_verify` against the fork's in-tree shaders to confirm
parity.** That is a verify step, not a code change.

## Standalone-vs-fork shader drift (Vulkan)

| Kernel family               | Fork path                                | Standalone path                                       | Status                                                                                              |
| --------------------------- | ---------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| turbo3 / turbo4 / turbo3_tcq| **none**                                 | `packages/inference/vulkan/turbo{3,4,3_tcq}.comp`     | Fork has zero matching `.comp` files. Kernels live nowhere reachable from `ggml-vulkan.cpp`.        |
| qjl{,_get_rows,_mul_mv}     | **none**                                 | `packages/inference/vulkan/qjl*.comp`                 | Same — fork has no Vulkan QJL shaders or dispatch sites.                                            |
| polar{,_get_rows}           | **none**                                 | `packages/inference/vulkan/polar*.comp`               | Same.                                                                                               |

A grep of `ggml/src/ggml-vulkan/` for `turbo|tbq|qjl|polar` returns
empty. The fork's CUDA tree carries the kernels; the Vulkan tree does
not.

This contradicts the build-script log line for `patchVulkanKernels`:
`"turbo3/turbo4/turbo3_tcq verified on Intel ARL + lavapipe; fork
kernels in sync."` There are no fork Vulkan kernels to be in sync
with. The kernels were verified against the standalones via
`vulkan_verify` on Intel ARL + lavapipe (per README), but they have
not been integrated into the fork's Vulkan backend at this pin.

The unused `kernel-patches/vulkan-kernels.mjs` impl module already
captures this state in its own header comment (verbatim audit at
v0.4.0-milady commit 08032d57). The build script imports it but never
calls it.

## DFlash patch state

There are no dedicated DFlash patches in the build script. The CLI
surface (`--spec-type dflash`, `--draft-min-prob`,
`n_drafted_total`/`n_drafted_accepted_total` Prometheus counters) lives
in the fork at `tools/server/README.md` + `common/arg.cpp` directly.
`MIN_COMMIT = 7c7818aafc7599996268226e2e56099f4f38e972` is the build
script's known-good ancestor sentinel; current HEAD `08032d57` is later
in the same lineage so no patch is needed.

## Windows QJL patch state

`patchGgmlBaseForWindowsQjl` is **still required**. The fork's
`ggml/src/CMakeLists.txt` lines 205-209 still end the `ggml-base`
source list with `polar_centroids.h\n            gguf.cpp)` and do not
include any of the `ggml-cpu/qjl/*.c` sources. PE/COFF would still fail
to link `ggml-base.dll` without the patch on Windows targets. The
script's anchor string (line 452) matches the fork verbatim. Keep.

## omnivoice fuse vs fork

`omnivoice-fuse/cmake-graft.mjs` declares `omnivoice-core` /
`llama-omnivoice-server` / `libelizainference` targets. The fork's
root `CMakeLists.txt` references none of these names — the graft is
purely additive. No conflict. The graft also explicitly skips
`add_subdirectory(omnivoice/ggml)`, honoring the §4 "one ggml pin"
contract.

## Dead imports (informational, not changed in this audit)

`build-llama-cpp-dflash.mjs:60-66` imports
`patchMetalKernels as patchMetalKernelsImpl` and
`patchVulkanKernels as patchVulkanKernelsImpl` from
`./kernel-patches/{metal,vulkan}-kernels.mjs` plus the
`METAL_KERNEL_FILES` / `VULKAN_KERNEL_FILES` arrays. None of the four
imports are referenced anywhere else in the script. The
`applyForkPatches` dispatcher only calls the in-script no-op
`patchMetal*` / `patchVulkanKernels` functions.

The two Impl modules contain the *real* kernel-shipment logic
(copy standalones into `ggml/src/ggml-metal/milady-shipped/` + patch
the metallib `add_custom_command` to merge the resulting `.air` files;
hard-throw on `*-vulkan` targets without an explicit
`ELIZA_DFLASH_ALLOW_INCOMPLETE_VULKAN=1`). They were written but
never wired into `applyForkPatches`. Wiring them is out of scope for
this audit per scope rules ("don't touch patch logic"); flagging here
so a follow-up task can decide whether to (a) wire them in and start
shipping the standalones into the fork build, or (b) delete the
imports.

## Conclusions

**High-confidence redundancies (could be deleted but already opt-in
no-op logs):**

- `patchMetalTurbo4`, `patchMetalTurbo3Tcq`, `patchMetalQjl`,
  `patchMetalPolar` — the four hooks each emit a single log line, are
  guarded behind opt-in env vars (default OFF), and the README already
  documents them as no-ops. They have negligible runtime cost. **No
  code change recommended** — keeping the named hooks documents the
  intent and provides a place for the next agent to attach a real
  patch (e.g. the unwired `patchMetalKernelsImpl`) without growing the
  dispatcher. Aligns with the comment on `patchVulkanKernels` about
  "kept so a future layout drift can attach a warn-on-mismatch
  sentinel guard".

**High-confidence false claim (LOG message corrected by README only):**

- `patchVulkanKernels` log says "fork kernels in sync" — the fork has
  no matching Vulkan kernels. The README change in this audit corrects
  the surrounding doc text. Editing the build-script log is tempting
  but counts as touching patch logic — leaving the log line as-is and
  letting the README carry the corrected story is the lower-risk move.
  Flag for follow-up sign-off.

**Must stay:**

- `patchGgmlBaseForWindowsQjl` — verified-required against fork HEAD.

**Drift requiring sign-off (no auto-sync per AGENTS.md):**

- All five standalone Metal shaders are perf-tuned variants of the
  fork's in-tree versions. `polar.metal` carries a non-trivial
  parallel-Hadamard win the fork lacks. Per AGENTS.md the fork is
  canonical at runtime — but `metal_verify` validated the standalones,
  not the fork's in-tree variants. Recommend re-running `metal_verify`
  against the fork's `ggml/src/ggml-metal/milady-kernels/*.metal`
  files to confirm 8/8 PASS still holds before signing off the next
  bundle release.

**Dead-imports flag (informational):**

- `patchMetalKernelsImpl` / `patchVulkanKernelsImpl` /
  `METAL_KERNEL_FILES` / `VULKAN_KERNEL_FILES` are imported but
  unreferenced in `build-llama-cpp-dflash.mjs`. Either wire them or
  remove the imports.

## Verification

- `git ls-remote` confirmed both refs pre-clone.
- Shallow clone of `v0.4.0-milady` succeeded (exit 0).
- `git rev-parse v0.4.0-milady^{}` resolved to `08032d57` (commit
  identical to `milady/integration` head).
- `find ggml -iname '*turbo*' -o -iname '*qjl*' -o -iname '*polar*'`
  enumerated every in-fork kernel; no Vulkan `.comp` matches.
- `diff -u` ran for each Metal pair. Counts recorded above.
- `node packages/app-core/scripts/build-llama-cpp-dflash.mjs --help`
  parsed cleanly post-audit (no script edits made).
- Temp clone removed.

No commits made. No kernel sources touched. README updated only on
the patch-state claims that this audit found stale.
