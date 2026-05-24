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

## Realized patch series (against `bun-v1.3.13`)

| File                                                | Touches                                       |
|-----------------------------------------------------|-----------------------------------------------|
| `0001-config-add-riscv64-arch.patch`                | `scripts/build/config.ts`                     |
| `0002-flags-add-riscv64-march-mabi.patch`           | `scripts/build/flags.ts`                      |
| `0003-zig-add-riscv64-target-triple-and-cpu.patch`  | `scripts/build/zig.ts`                        |
| `0004-webkit-force-local-mode-on-riscv64.patch`     | `scripts/build/config.ts` + `deps/webkit.ts`  |
| `0005-tinycc-disable-on-riscv64.patch`              | `scripts/build/deps/tinycc.ts`                |
| `0006-build-add-riscv64-cli-validation.patch`       | `scripts/build.ts` (doc-only)                 |
| `0007-deps-per-dep-riscv64-checks.patch`            | `scripts/build/deps/lolhtml.ts`               |
| `0008-source-stabilize-riscv64-musl-build.patch`     | riscv64 source/build stabilization + LLVM strip override |
| `0009-disable-wasm-streaming-hooks-for-c-loop.patch` | C_LOOP-only WebAssembly hook guards           |
| `0010-disable-inspector-profiler-for-riscv64-c-loop.patch` | C_LOOP-only inspector/profiler stubs    |
| `0011-process-arch-add-riscv64.patch`                | `process.arch` + node config riscv64 values   |
| `0012-cpu-features-add-riscv64-fallback.patch`       | portable CPU feature fallback                 |
| `0013-disable-console-inspector-hooks-for-riscv64-c-loop.patch` | C_LOOP-only console inspector guards |
| `0014-disable-custom-inspector-dispatchers-on-riscv64.patch` | C_LOOP-only custom inspector dispatchers |
| `0015-disable-jsc-profiler-builtins-on-riscv64.patch` | C_LOOP-only JSC profiler builtin guards      |
| `0016-node-vm-disable-jit-cached-data-on-riscv64-c-loop.patch` | C_LOOP-only Node VM JIT/watchdog guards |
| `0017-disable-performance-domjit-signature-on-riscv64-c-loop.patch` | C_LOOP-only performance DOMJIT guard |
| `0018-fix-serialized-script-identifier-big-endian-path.patch` | explicit Identifier conversion for fallback string path |
| `0019-add-wtf-timer-fire-bridge-for-c-loop.patch` | C_LOOP/local-WebKit `WTFTimer__fire` link bridge |
| `0020-run-riscv64-smoke-test-under-qemu.patch` | run post-link `--revision` smoke through qemu |
| `0021-fix-riscv64-linux-open-flags.patch` | use riscv64-compatible Linux open flags for resolver file/directory checks |

Note on the original task brief: Bun 1.3.x removed the top-level
`CMakeLists.txt` — the build is now fully driven by `scripts/build.ts`
through ninja directly. There is no `cmake/` directory to patch, so
"patch #7 CMakeLists.txt processor normalization" from the original
brief was obsolete and is collapsed into `0007` (the per-dep audit).

Likewise the `.cargo/config.toml` patch is unneeded: lol-html is the
only cargo-built dep, and patch 0007 sets `rustTarget =
riscv64gc-unknown-linux-${cfg.abi}` directly. `cargo` finds the
cross-clang via the wrapper script in the Docker image's `/opt/cross/`.

## Verifying

```bash
cd ../  # to bun-riscv64/
./validate.sh
```

Runs `git apply --check` against a shallow clone of `oven-sh/bun @
bun-v1.3.13`. See `../README.md` for output details.
