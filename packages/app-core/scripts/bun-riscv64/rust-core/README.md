# Bun Rust-core → riscv64-linux-musl port (in progress)

Bun's core was rewritten **Zig → Rust** (oven-sh/bun PR #30412, merged 2026-05-14,
after Anthropic's acquisition). `main` is now `language: Rust` (Cargo workspace,
no `build.zig`). The **last Zig release was v1.3.14** — which the sibling
`../bun-version.json` + `../bun-patches/` series build for riscv64 today.

Upstream scoped the Rust rewrite to **linux x64 glibc**; `scripts/build/rust.ts`
hardcoded `arch = cfg.x64 ? "x86_64" : "aarch64"` and `allRustTargets` had no
riscv64. (Notably `main` already carries *partial* in-progress riscv64 wiring —
`config.ts` referenced an undeclared `riscv64`, and `zlib.ts`/`tinycc.ts`/
`webkit.ts` already branch on `cfg.riscv64` — so upstream had *started* riscv64.)

## What this directory contains

`0001-riscv64-rust-core-port.patch` — a consolidated patch (31 files, +238 lines)
that adds `riscv64gc-unknown-linux-musl` support to the Rust-core Bun build. It is
the rebase of the proven `../bun-patches/` riscv64 series (v1.3.14) onto Rust-core
`main` (oven-sh/bun @ `9d000561c937b8e00569519ba1c7973e4b967fb5`, 2026-05-29),
plus the one piece the old per-dep patches didn't cover.

Of the 22 legacy `../bun-patches/`: **15 apply cleanly** to `main`, **1 is
obsolete** (`0003-zig-*` — `scripts/build/zig.ts` is gone), and **6 were rebased**
(config.ts ×2, deps/webkit.ts, source.ts, glob-sources.ts, BunCPUProfiler.cpp,
JSPerformance.cpp). The new piece: `scripts/build/rust.ts` —
`rustTarget()` now emits `riscv64gc` (was collapsing riscv64→aarch64) and
`riscv64gc-unknown-linux-musl` is added to `allRustTargets`.

Build-system changes (config.ts `Arch`+`riscv64` boolean+detectHost+asserts+
`riscv64Tool` env overrides; rust.ts target; webkit.ts `kind:none` on riscv64;
source.ts extern-libs + riscv64 cmake cross flags; flags.ts `-march=rv64gc
-mabi=lp64d`; tinycc/zlib riscv64) + C++ C_LOOP guards (`__riscv && __riscv_xlen==64`:
CPU profiler, inspector agents, DOMJIT, NodeVM cached-data) + the
`0021` open-flags / `0022` zlib-generic-kernel / big-endian fixes.

`0002-second-wave-riscv64-source-gaps.patch` — fixes the compile-stop Rust
*source* gaps that the build-system patch (0001) didn't cover. 4 files:
- `src/bun_core/env.rs` — `Architecture::Riscv64` (+ `npm_name` "riscv64", `NAMES`
  entry, `IS_RISCV64`, `ARCH` arm). Without this the `ARCH` const `panic!`s at
  compile time and `process.arch` is wrong.
- `src/bun_core/Global.rs` — `arch_name` → "riscv64" (was falling to "unknown").
- `src/crash_handler/CPUFeatures.rs` — riscv64 `Flags { NONE }` + empty
  `NAMED_FLAGS` (matches `CPUFeatures.cpp` `CPU(RISCV64) → return 0`), clears the
  `compile_error!("unsupported target architecture")`.
- `src/perf/hw_timer.rs` — riscv64 `read_counter()` via the `rdtime` CSR (the
  userspace fixed-frequency counter, analog of aarch64 `CNTVCT_EL0`), clears the
  `compile_error!`.

## Status — VALIDATED

- ✅ 0001 **applies cleanly** to fresh `main` (host + builder container); build-system `tsc`-clean.
- ✅ 0002 **applies cleanly** on top of 0001; the four files are untouched by 0001.
- ✅ The riscv64 `rdtime` inline asm **assembles** (`rustc --target riscv64gc-unknown-linux-musl`).
- ✅ riscv64 rust target installed (Tier-2, prebuilt std).

## Status — NOT YET VALIDATED (the multi-hour build)

- ⬜ **Full riscv64 cross-build** — run **`../run-build.sh --rust-core`** (sets
  `BUN_RISCV64_RUST_CORE=1` → build.sh uses `rust_core_port.{target_commit,
  rust_channel,webkit_commit}` and mounts `rust-core/` as the patch series).
  Expected next blockers, in order: (a) **WebKit patches** (`../webkit-patches/`)
  are pinned to the Zig-era WebKit `5488984d`; against `963f8758` they likely
  need refreshing. (b) A further wave of Rust-source cfg gaps beyond 0002 —
  notably `src/runtime/ffi/ffi_body.rs` (FFI-callback trampolines need a riscv64
  asm arm) and `src/crash_handler/lib.rs` (register-dump needs a riscv64
  `ucontext` arm). (c) The ICU `icudt74l.dat` packaging fix (NFKC/NFKD segfault).
  Triage compile errors into a `0003-*.patch`.

## How to drive it

```sh
cd packages/app-core/scripts/bun-riscv64
docker run --rm --privileged tonistiigi/binfmt --install riscv64   # for the QEMU smoke test
./run-build.sh --rust-core            # image build + Rust-core cross-build (multi-hour)
# artifact: dist/bun-linux-riscv64-musl.zip
```

The Zig v1.3.14 build (`./run-build.sh`, no flag → `../bun-patches/` + `bun.tag`)
remains the **last-validated** riscv64 Bun and the safe fallback until the
Rust-core cross-build is green.
