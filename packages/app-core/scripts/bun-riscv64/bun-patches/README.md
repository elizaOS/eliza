# Bun riscv64 patches

This directory holds the Bun-side patches that have to land on top of
`oven-sh/bun @ ${BUN_TAG}` (see `../bun-version.json:bun.tag`) so the
build system accepts `riscv64-linux-musl` as a target.

`build.sh` applies every `*.patch` in this directory **in lexical order**
via `git am --3way` inside the Bun clone.

## Why these are needed

Bun's TypeScript build driver explicitly types its `Arch` as
`"x64" | "aarch64"` (`scripts/build/config.ts`). Every codepath downstream
of that — flag selection, CMake processor name, Rust target triple
derivation, dependency build configs — branches on those two values. We
need a small series of patches to:

### Required patch areas

1. **`scripts/build/config.ts`**
   - Extend `Arch = "x64" | "aarch64"` → `Arch = "x64" | "aarch64" | "riscv64"`.
   - In `detectHost()`, accept `arch === 'riscv64'`. (We only run the
     build driver under cross-compile from an x86_64 host, so this is
     mostly defensive — but the resolveConfig path goes through detectHost
     for build-time host introspection too.)
   - Add `cfg.riscv64: boolean` to the Config interface so dep configs
     can switch on it ergonomically.

2. **`scripts/build/flags.ts`**
   - In `cpuTargetFlags`, add a `riscv64` entry that emits
     `-march=rv64gc -mabi=lp64d`. (Match what the Docker wrappers already
     pass — defense in depth, since `cpuTargetFlags` is applied late and
     overrides the wrapper's defaults if the wrapper-supplied flags get
     filtered out anywhere.)

3. **`scripts/build/rust.ts`**
   - `allRustTargets` already covers riscv64gc-unknown-linux-musl as a
     Tier-2 prebuilt-std target, but verify the host→rust-triple mapping
     emits it when `cfg.riscv64` is true.

4. **`scripts/build/deps/webkit.ts`**
   - The prebuilt-tarball URL constructor maps `arch` to `"amd64" | "arm64"`
     only. For riscv64, force `cfg.webkit === "local"` (Bun's WEBKIT_PATH
     env-var path) and disable the prebuilt branch — there is no upstream
     `oven-sh/WebKit` tarball for riscv64 and there never will be unless
     they publish one. `build.sh` already exports `BUN_WEBKIT_PATH`
     pointing at the freshly built `WebKitBuild/riscv64-Release/`, so the
     local-mode path is the only one we need to reach.

5. **`scripts/build/deps/tinycc.ts`**
   - The `oven-sh/tinycc` fork has no riscv64 backend. Gate the dep with
     `enabled: cfg => cfg.tinycc && !cfg.riscv64`. The runtime config flag
     already follows: bun:ffi's JIT-compile path becomes unavailable on
     riscv64, but static FFI bindings still work. This is acceptable for
     the Android agent runtime — `BUN_DISABLE_TINYCC=1` in build.sh's env
     also enforces this through Bun's own toggle.

6. **`scripts/build/bd.ts`** (or wherever `build:release` lives)
   - Accept `--arch=riscv64 --abi=musl` and thread it through to the
     cmake invocation. The `--webkit-path=...` flag should already work
     unmodified; double-check it's not gated by arch.

7. **`CMakeLists.txt`** (top-level)
   - Wherever `CMAKE_SYSTEM_PROCESSOR` is normalized (search for
     `aarch64` / `arm64` matches), add a `riscv64` branch that sets
     `BUN_CPU=riscv64` and emits the correct `-march`/`-mabi`. If the
     project gates entire compilation units behind `BUN_CPU` (some
     vendored deps' CMakeLists do), add riscv64 to the allowlist.

### Optional patch areas

8. **`vendor/bun-uws/uSockets/CMakeLists.txt` (and other vendored libs)**
   - Most vendored C/C++ deps will Just Work with riscv64 since they
     consume `CMAKE_C_COMPILER` directly. Anything that grep'es
     `CMAKE_SYSTEM_PROCESSOR STREQUAL "aarch64"` to enable assembly
     fast-paths should add a `riscv64` branch that falls back to the
     portable C implementation. Examples to check:
     - mimalloc (`MI_ARCH` switch) — falls back fine.
     - boringssl — Bun uses C fallbacks on non-x86 already.
     - lol-html (Rust) — uses target features from cargo, no patches.

## What we cannot pre-write here

The above describes the patch series with full intent and ordering, but
each individual patch is a textual diff against a specific Bun commit
(BUN_TAG). Producing those patches requires a clone of `oven-sh/bun` at
the pinned tag and iterative `bun run build` invocations to find each
new error after fixing the previous one — work that needs a host with the
~15 GB build cache available and is non-trivial to do blind.

## File-naming convention

```
0001-config-add-riscv64-arch.patch
0002-flags-add-riscv64-mcpu.patch
0003-rust-allow-riscv64gc-linux-musl.patch
0004-webkit-force-local-mode-on-riscv64.patch
0005-tinycc-disable-on-riscv64.patch
0006-bd-accept-riscv64-arg.patch
0007-cmake-normalize-riscv64-system-processor.patch
```

When you produce them, set:

```
Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```
