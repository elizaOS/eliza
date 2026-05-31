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

## Status — VALIDATED

- ✅ Patch **applies cleanly** to fresh `main` (verified on host + in the builder
  container).
- ✅ `scripts/build/config.ts` is **tsc-clean** (`bunx tsc -p scripts/build/tsconfig.json` → 0 errors).
- ✅ `scripts/build/rust.ts` and the other edited `scripts/build/*.ts` parse.

## Status — NOT YET VALIDATED (remaining work)

- ⬜ **Full riscv64 cross-build** (`build.sh`: WebKit C_LOOP + `cargo build
  --target riscv64gc-unknown-linux-musl` + link). This is the multi-hour
  "ensure it builds" step and is expected to surface a second wave of
  Rust-*source* riscv64 portability gaps (the crate has ~34 files with
  `target_arch="x86_64"|"aarch64"` cfg and ~6 inline-asm sites; `src/sys/
  linux_syscall.rs` is only partially riscv64-aware — sendfile/syscall numbers
  need a riscv64 arm). Run it with the builder image + a riscv64 musl sysroot;
  triage cfg gaps into follow-up hunks.
- ⬜ Some C++ companion files the old patches' siblings touched (BakeGlobalObject,
  ZigGlobalObject, JSWasmStreamingCompiler, BunDebugger) may need the same
  C_LOOP guards once the compile reaches them.

## How to drive it

```sh
# pin bun to Rust-core main + nightly-2026-05-06 (see ../bun-version.json rust_core_port),
# point build.sh at this patch series, then:
make -C ../../.. ...    # or run build.sh with BUN_TAG=<main sha> and this patch dir
```

The Zig v1.3.14 build (`../bun-patches/` + `../bun-version.json` `bun.tag`) remains
the **last-validated** riscv64 Bun and the safe fallback until the full Rust-core
cross-build is green.
