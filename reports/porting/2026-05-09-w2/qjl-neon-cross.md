# W2-A — QJL aarch64 NEON cross-validation report

**Date:** 2026-05-09
**Agent:** W2-A (Wave-2 verification agent A)
**Scope:** Cross-validate W1-A's QJL fork-build on aarch64 NEON via `qemu-user-static`. Confirm 100/100 bit-parity is real on the NEON code path, not just on AVX2.
**Branch:** `worktree-agent-ac6729c486579e1dd` (this worktree, with W1-A's `worktree-agent-a53ef95991ef78732` merged in)
**W1-A commits validated:**
- `8f2a91556f feat(aosp): wire QJL llama.cpp patches into compile-libllama + fix block layout`
- `cf4eaeddb2 feat(aosp-llama): qjl1_256 KV-cache type + dlopen-based fork parity test`

## TL;DR

**PASS.** 100/100 bit-parity confirmed on the aarch64 NEON code path under qemu-user emulation, end-to-end:

- Standalone NEON-vs-ref parity (in-process, no dlopen): **100/100 signs match, 100/100 norms match, 100/100 full match**.
- Fork dlopen parity (cross-built `libggml-cpu.so` quantize_row_qjl1_256 vs standalone reference): **100/100 signs match, 100/100 norms match, 100/100 full match**.
- All 6 required QJL symbols present in the cross-built `libggml-cpu.so` / `libggml-base.so`.
- NEON kernel sources are byte-identical between the standalone qjl-cpu library and the vendored copy in the apothic fork tree (verified via `diff`), so the same machine code runs in both binaries.

## Environment

Build host: Linux x86_64 (no native arm hardware available). The validation runs the cross-built aarch64 binaries under `qemu-aarch64-static` user-mode emulation.

Tools used:
- `zig` 0.13.0 — `/home/shaw/.local/bin/zig`
- `cmake` 3.28.3
- `qemu-aarch64-static` 8.2.2 (Debian 1:8.2.2+ds-0ubuntu1.16) — extracted out-of-place from `qemu-user-static_1%3a8.2.2+ds-0ubuntu1.16_amd64.deb` to `/tmp/cross-tools/qemu-aarch64-static`. The build host has no sudo, so the deb was downloaded with `apt-get download` and extracted via `dpkg-deb -x`.
- `aarch64-linux-gnu-nm` / `aarch64-linux-gnu-readelf` 2.42 — extracted from `binutils-aarch64-linux-gnu` and `libbinutils` debs (plus libctf, libsframe, libjansson supporting libs) into `/tmp/binutils-aarch64/`. A wrapper at `/tmp/cross-tools/aarch64-linux-gnu-nm` sets `LD_LIBRARY_PATH` to find libbfd.
- aarch64 glibc sysroot at `/tmp/arm64-sysroot/` — extracted from `libc6_2.39-0ubuntu8.7_arm64.deb`, `libstdc++6_14.2.0-4ubuntu2~24.04.1_arm64.deb`, `libgcc-s1_14.2.0-4ubuntu2~24.04.1_arm64.deb` from `http://ports.ubuntu.com/ubuntu-ports/`.

## Steps performed and results

### 1. Cross-build the standalone qjl-cpu library for aarch64 NEON

Two builds were produced:

- `/tmp/qjl-aarch64-build/` — `aarch64-linux-gnu` target (dynamic glibc, used for the dlopen-based fork-parity binary).
- `/tmp/qjl-aarch64-static-build/` — `aarch64-linux-musl` target with `-static` (used for the standalone NEON-vs-ref self-parity binary that runs under qemu without any sysroot).

CMake toolchain files at `/tmp/qjl-aarch64-build/toolchain-aarch64.cmake` and `/tmp/qjl-aarch64-static-build/toolchain-aarch64-musl.cmake` set `CMAKE_SYSTEM_PROCESSOR=aarch64` so the existing `packages/native-plugins/qjl-cpu/CMakeLists.txt` selects the NEON sources (`src/qjl_quantize_neon.c`, `src/qjl_score_neon.c`) per its arch dispatch block.

Confirmed via `file`:
```
/tmp/qjl-aarch64-static-build/build/qjl_bench: ELF 64-bit LSB executable, ARM aarch64, version 1 (SYSV), statically linked
/tmp/qjl-aarch64-build/build/qjl_fork_parity:  ELF 64-bit LSB executable, ARM aarch64, version 1 (SYSV), dynamically linked, interpreter /lib/ld-linux-aarch64.so.1
```

### 2. Standalone NEON-vs-ref parity under qemu

A self-parity test (`reports/porting/2026-05-09-w2/qjl_fork_parity_aarch64_qemu.c` is the dlopen variant; the simpler self-parity test was a one-off at `/tmp/qjl_neon_self_parity.c`) compares `qjl_quantize_row_ref` vs `qjl_quantize_row_neon` on the same 100 random Gaussian vectors of head_dim=128, using the default seed-42 projection matrix.

Run:
```
/tmp/cross-tools/qemu-aarch64-static /tmp/qjl_neon_self_parity_aarch64
```
Output:
```
[qjl-neon-self-parity] 100/100 signs match, 100/100 norms match, 100/100 full match
[qjl-neon-self-parity] standalone SIMD path: neon
[qjl-neon-self-parity] PASS
```

`qjl_active_simd()` returns `"neon"`, confirming the NEON dispatch is what ran (not a fallback to ref).

`qjl_bench --throughput` corroborates: the NEON kernels are measurably faster than ref under qemu (90945ns vs 120034ns per quantize, 743ns vs 1079ns per score), which is the expected directional signal that the NEON intrinsics are being JIT-translated by qemu.

### 3. Cross-build the fork's libggml family for aarch64 NEON

Two cross-builds of the apothic/llama.cpp-1bit-turboquant fork were produced:

- **Production target (`aarch64-linux-musl`):** `node packages/app-core/scripts/aosp/compile-libllama.mjs --abi arm64-v8a --assets-dir /tmp/qjl-build-test/assets`. This is the AOSP shipping configuration. Output at `/tmp/qjl-build-test/assets/arm64-v8a/`. The script auto-applied W1-A's 5 vendored patches (all reported as "already in git log" since they had been applied during a previous run on the cached checkout — that's the expected idempotent behavior).
- **Test target (`aarch64-linux-gnu`):** `/tmp/qjl-fork-glibc-build/` — same fork sources, glibc target instead of musl. Built specifically because the W1-A `qjl_fork_parity` test needs to be a glibc-dynamic-linked binary that dlopen()s the fork's libggml-cpu.so under qemu, and qemu-user has well-known issues with TLS-cleanup of static-musl PIE binaries that try to dlopen glibc shared objects. The same NEON kernel sources are compiled in either way — only the libc differs.

Confirmed all artifacts are aarch64 ELFs:
```
libggml-cpu.so:  ELF 64-bit LSB shared object, ARM aarch64
libggml-base.so: ELF 64-bit LSB shared object, ARM aarch64
libllama.so:     ELF 64-bit LSB shared object, ARM aarch64
```

### 4. Fork dlopen-based bit-parity test under qemu

A dlopen-based parity binary (`reports/porting/2026-05-09-w2/qjl_fork_parity_aarch64_qemu.c`) is a tightened reproduction of W1-A's `packages/native-plugins/qjl-cpu/test/qjl_fork_parity.c`, with one diff: it calls `_exit()` instead of returning so the process bypasses libc cleanup (qemu-user has known SIGSEGVs in glibc TLS teardown when a dlopen()ed shared library is unwound).

Run:
```
QEMU_LD_PREFIX=/tmp/arm64-sysroot \
  /tmp/cross-tools/qemu-aarch64-static \
  -E LD_LIBRARY_PATH=/tmp/fork-parity-stage:/tmp/arm64-sysroot/lib/aarch64-linux-gnu \
  /tmp/dlopen_parity_aarch64 /tmp/fork-parity-stage/libggml-cpu.so
```
Output:
```
[fork-parity-aarch64-qemu] 100/100 signs match, 100/100 norms match, 100/100 full match
[fork-parity-aarch64-qemu] PASS
```

This is the load-bearing W2-A check: the fork's `quantize_row_qjl1_256` symbol — invoked through dlopen against an aarch64 NEON-compiled `libggml-cpu.so` — produces output that is byte-identical to the standalone qjl-cpu library's reference implementation on every one of 100 random Gaussian inputs.

The fork's dispatch path (`ggml/src/ggml-cpu/qjl/quants-qjl.c::quantize_row_qjl1_256`) calls `qjl_quantize_rows()`, which on aarch64 forwards to `qjl_quantize_rows_neon()`. The NEON kernel source is byte-identical between the standalone library and the fork's vendored copy:

```
$ diff packages/native-plugins/qjl-cpu/src/qjl_quantize_neon.c \
       ~/.cache/eliza-android-agent/llama-cpp-main-b8198-b2b5273/ggml/src/ggml-cpu/qjl/qjl_quantize_neon.c
$ diff packages/native-plugins/qjl-cpu/src/qjl_score_neon.c \
       ~/.cache/eliza-android-agent/llama-cpp-main-b8198-b2b5273/ggml/src/ggml-cpu/qjl/qjl_score_neon.c
$ diff packages/native-plugins/qjl-cpu/src/qjl_dispatch.c \
       ~/.cache/eliza-android-agent/llama-cpp-main-b8198-b2b5273/ggml/src/ggml-cpu/qjl/qjl_dispatch.c
(empty diffs — files are identical)
```

### 5. Required QJL symbols in cross-built libraries

Symbol presence verified via `aarch64-linux-gnu-nm -D --defined-only` on the stripped musl-target artifacts at `/tmp/qjl-build-test/assets/arm64-v8a/`:

| Symbol                                | libggml-cpu.so | libggml-base.so |
|---------------------------------------|:--------------:|:---------------:|
| `quantize_row_qjl1_256`               | present        | -               |
| `dequantize_row_qjl1_256`             | present        | -               |
| `qjl_quantize_row_neon`               | present        | -               |
| `qjl_score_qk_neon`                   | present        | -               |
| `ggml_compute_forward_attn_score_qjl` | present        | -               |
| `ggml_attn_score_qjl`                 | -              | present         |

All 6 required symbols are present in the expected library. Full symbol lists captured at:
- `reports/porting/2026-05-09-w2/aosp-symbols-post-cpu.txt` (598 dynamic-defined symbols)
- `reports/porting/2026-05-09-w2/aosp-symbols-post-base.txt` (882 dynamic-defined symbols)

### 6. Baseline diff

The expected baseline file `reports/porting/2026-05-09-baseline/aosp-symbols-pre.txt` does not exist on either the W1-A branch or develop. Treating the post-symbols file as the authoritative record. The 6 required new symbols are all present — that is the load-bearing constraint. If the baseline is later authored on develop, a diff against `aosp-symbols-post-cpu.txt` / `-post-base.txt` will tell exactly which symbols were added by the QJL patch series.

### 7. End-to-end llama-server smoke against a tiny GGUF (optional)

**Not attempted.** The compiled `llama-server` binary is 5.7 MB stripped at `/tmp/qjl-build-test/assets/arm64-v8a/llama-server`. Standing up a real generation under qemu-user requires:

1. Fabricating a tiny GGUF (or pulling one) that the AOSP fork can load. The fork does not include a GGUF generator.
2. Running llama-server under qemu-user with a glibc/musl sysroot that includes everything libllama.so transitively needs.
3. Issuing an HTTP request with `cache_type_k=qjl1_256` and validating the generation does not crash.

This would have been a multi-hour separate effort and is out of scope for the load-bearing "is the NEON code bit-correct" claim. The standalone parity test plus the dlopen-fork parity test plus the symbol-presence check together prove the QJL kernels execute correctly on aarch64 NEON; an end-to-end llama-server load would prove the *integration* into the fork's kernel-dispatch graph, which is what `tests/test-qjl-cache.cpp` (added by W1-A's patch 0004) is supposed to cover when the fork's test suite is built. Recommend running that test inside the apothic fork's CMake build with `-DLLAMA_BUILD_TESTS=ON` on a real arm64 host before declaring the integration verified at the model-load level.

## QEMU caveats encountered (documented for future runs)

1. **qemu-user dlopen+libpthread+TLS cleanup SIGSEGV.** When a dynamically-linked aarch64 binary that dlopen()s a glibc shared library returns from main, the libc cleanup path can SIGSEGV inside the qemu translation block for a libpthread address. The workaround is to call `_exit()` after printing the result. The kernel computation itself runs correctly; the fault is purely in the unwound-cleanup path. This is exactly the "NEON intrinsics issue with QEMU's user-mode emulation" the W2-A spec called out, except in this run the failure surface was libc TLS, not NEON intrinsics. The actual NEON code paths (quantize_row_neon, score_qk_neon) executed bit-correctly.
2. **zig+musl is static-pie by default.** Zig 0.13's musl target produces static-pie binaries even when `-shared`/`-dynamic` is requested at the link line; the loader is embedded, but `dlopen()` is a stub. To run the fork dlopen test, the test binary had to target `aarch64-linux-gnu` and run against an extracted Ubuntu glibc sysroot. The fork's libs were also rebuilt against that glibc target for the dlopen test. The production musl libs (the ones that actually ship in the AOSP APK) were also built and symbol-checked, but were not used for the dlopen-parity run because of the qemu-user dlopen+musl loader interaction.
3. **No sudo on this host.** All required tooling (qemu-aarch64-static, aarch64 binutils, aarch64 glibc, libstdc++, libgcc) was extracted out-of-place from .deb files into `/tmp/cross-tools/` and `/tmp/arm64-sysroot/`. None of it was system-installed. The W1-A `compile-libllama.mjs` script was run unmodified — it only requires zig and cmake, both of which were already on PATH.

## Files in this report bundle

- `qjl-neon-cross.md` — this file.
- `qjl-neon-cross-runlog.txt` — captured stdout of every parity / symbol check, runnable as a regression baseline.
- `qjl_fork_parity_aarch64_qemu.c` — modified version of the W1-A `qjl_fork_parity.c` that calls `_exit()` to bypass qemu-user TLS-cleanup faults. Source of truth for future cross-validation runs.
- `aosp-symbols-post-cpu.txt`, `aosp-symbols-post-base.txt` — full dynamic-defined symbol lists from the cross-built `libggml-cpu.so` / `libggml-base.so`.

## Verdict

W1-A's QJL fork-build holds on aarch64 NEON. The 100/100 bit-parity claim is real on the NEON code path, not an AVX2-only artifact. The 6 required QJL symbols ship in the cross-built libraries.

**Recommended next checks (out of scope for W2-A):**
- Run `tests/test-qjl-cache.cpp` (added by patch 0004) against the cross-built fork tree with `-DLLAMA_BUILD_TESTS=ON`. That exercises the type-trait wiring + ATTN_SCORE_QJL op dispatch end-to-end inside the GGML graph.
- On a real arm64 host (Apple Silicon dev box, Cuttlefish arm64 emulator, or a phone), repeat the qjl_fork_parity test and the test-qjl-cache test without any qemu interposition. The qemu-user run here is a strong indicator but not a substitute for native-NEON validation.
