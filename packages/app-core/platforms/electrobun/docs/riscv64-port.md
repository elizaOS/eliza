# Electrobun linux-riscv64 port spec

Electrobun (blackboardsh/electrobun) is consumed here as an npm dep via
`bunx electrobun build` (see `package.json` `build` script). Upstream supports
macOS x64/arm64, Windows x64, **linux x64/arm64** — **no linux-riscv64**. Adding
it requires a fork (or upstream PR); this doc is the actionable spec.

## Why it's tractable

Electrobun's native pieces — launcher, core, extractor — are **Zig**
(`package/src/{launcher,core,extractor}/build.zig`), and they use
`b.standardTargetOptions(.{})`, so `-Dtarget=riscv64-linux-musl` already works
(Zig cross-compiles riscv64 natively). Rendering is delegated to the OS-native
WebView (WebKitGTK on Linux), which Debian ships for riscv64. So the launcher
side is a build-matrix change, not a real port.

## Exact changes (fork of blackboardsh/electrobun)

1. `package/src/shared/platform.ts`
   - `export type SupportedArch = "arm64" | "x64";` → add `| "riscv64"`.
   - In the `ARCH` switch, add `case "riscv64": return "riscv64";`.
2. Build matrix / artifact naming (`package/build.ts`,
   `package/scripts/build-and-upload-artifacts.js`,
   `package/src/bun/core/BuildConfig.ts`): add a `linux-riscv64` entry wherever
   `linux-x64`/`linux-arm64` are enumerated; pass `-Dtarget=riscv64-linux-musl`
   (or `-gnu`) to the launcher/core/extractor `zig build` invocations.
3. `update-channels.json` (here): add a `linux-riscv64` channel URL (currently
   only `macos-x64`/`windows-x64`/`linux-x64`).

## Hard dependency — the bundled Bun runtime

Electrobun bundles a **Bun** binary as the main-process runtime. There is no
riscv64 Bun release, so a linux-riscv64 electrobun must embed a self-built
riscv64 Bun — i.e. it is **gated on the Bun-riscv64 build**:
`../../../scripts/bun-riscv64/` (Zig v1.3.14 build today; Rust-core port in
`../../../scripts/bun-riscv64/rust-core/`). Wire electrobun's bun-download step
to consume that artifact for `linux-riscv64` instead of fetching a (nonexistent)
upstream Bun riscv64 release.

## Build findings — COMPILED + LINKED end-to-end (2026-06-01)

The riscv64 cross-build was driven all the way to a populated `dist-linux-riscv64`
(fork branch `shaw/riscv64-gui-headless` @ `dadfd0ee` + the riscv64 Bun at
`../../../scripts/bun-riscv64/dist/bun-linux-riscv64-musl.zip`, in the
`eliza/bun-riscv64-builder` image with the Alpine riscv64 GTK/WebKitGTK sysroot).

**RESULT: the linux `nativeWrapper.cpp` COMPILES and LINKS for riscv64.** The WGPU
guard works — no `dawn/webgpu.h` include error, no WGPU type errors. Build output:
```
Compiling with flags: pkg-config flags present
Building GTK-only version (libNativeWrapper.so)
CEF libraries not found - only GTK version built
Native wrapper built successfully
```
Artifacts (UCB RISC-V ELF): `nativeWrapper.o` (relocatable),
`dist-linux-riscv64/libNativeWrapper.so` (2.86 MB shared object), `launcher`,
`extractor`, bundled `bun`, and the `electrobun` CLI shim + `electrobun.js`.
`nm -D libNativeWrapper.so` shows **all 22 WGPU C-ABI `#else` stub symbols** as
defined (`T`) and **zero undefined `wgpu`/`dawn` symbols** (Dawn fully removed by
the guard); the `asar_*` symbols are `U`, resolved at link from the cross-built
`libasar.so`. The full `build.ts --release` then runs to
`Successfully created and populated dist-linux-riscv64`.

**Proven working:** the riscv64 GTK/WebKitGTK cross-toolchain, electrobun's
`build.ts` harness end-to-end (deps → vendor → zig-0.13 → `BunInstall` →
`buildNative` → templates → preload → launcher/cli/main → `copyToDist`), with
pkg-config pointed at the sysroot feeding the riscv64 GTK includes.

### Alpine riscv64 GTK/WebKitGTK sysroot recipe (≈884 MB)
```
apk add --root <sysroot> --arch riscv64 --no-scripts --allow-untrusted --initdb \
  -X .../v3.21/main -X .../v3.21/community \
  gtk+3.0-dev webkit2gtk-4.1-dev glib-dev cairo-dev pango-dev gdk-pixbuf-dev \
  harfbuzz-dev libsoup3-dev musl-dev g++ libstdc++-dev shared-mime-info
```
Then add a STUB `<sysroot>/usr/lib/pkgconfig/shared-mime-info.pc` (Name/Description/
Version only): Alpine ships no `shared-mime-info.pc` but `gdk-pixbuf-2.0.pc`
`Requires.private` it, so without the stub `pkg-config --cflags gtk+-3.0` fails and
the GTK includes are never passed. `g++`/`libstdc++-dev` are required for the C++
stdlib headers (`glib-typeof.h` includes `<type_traits>`).

Alpine has **no `ayatana-appindicator3-0.1`** package, so its `.pc` is absent.
That is expected and handled: `build.ts` falls back to `pkg-config webkit2gtk-4.1
gtk+-3.0` (no appindicator) and compiles the wrapper with `-DNO_APPINDICATOR`.

If the builder image lacks `apk`, populate the sysroot with the static
`apk-tools-static` binary (`apk.static add --root <sysroot> --arch riscv64
--initdb …`); fetch it from `…/v3.21/main/<host-arch>/apk-tools-static-*.apk`.
The image also needs `rsync` for `copyToDist`'s `createPlatformDistFolder`
(`apt-get install -y rsync`).

### Build invocation (in the bun-riscv64 builder image; sysroot at /sysroot)
```
ELECTROBUN_TARGET_ARCH=riscv64 ELECTROBUN_ZIG_TARGET=riscv64-linux-musl \
ELECTROBUN_CXX=/opt/cross/bin/riscv64-linux-musl-clang++ \
ELECTROBUN_BUN_PATH=<riscv64 bun> \
PKG_CONFIG_SYSROOT_DIR=/sysroot PKG_CONFIG_LIBDIR=/sysroot/usr/lib/pkgconfig \
bun build.ts --release
```

### Fork build.ts gaps — ALL RESOLVED (commit `dadfd0ee` on `shaw/riscv64-gui-headless`)
1. **Vendored tooling has no riscv64 release — RESOLVED.** `vendorBsdiff`/
   `vendorZstd` now skip on riscv64 (installer/update delta tooling, not runtime;
   `copyToDist` skips copying them too). `vendorAsar` cannot skip — the native
   wrapper LINKS `libasar.so` for the 4-function ASAR read ABI (`asar_open` /
   `asar_close` / `asar_read_file` / `asar_free_buffer`) — so on riscv64 it
   cross-builds a minimal but correct ASAR-format reader from embedded C++ with
   `ELECTROBUN_CXX` (`buildRiscv64Asar`); the build-time CLI is skipped.
2. **`BunInstall()` / `buildCli()` run the TARGET bun on the host — RESOLVED.**
   Both now use the HOST bun (`process.execPath`) when cross-building, instead of
   the riscv64 `PATH.bun.RUNTIME` (which can't exec on x86_64:
   `qemu-riscv64: … ld-musl-riscv64.so.1 not found`). bun has no riscv64
   `--compile` target, so on riscv64 the CLI is emitted as a JS bundle
   (`electrobun.js`) executed by the bundled riscv64 bun via a small shell shim
   named `electrobun`.
3. **CEF headers missing — RESOLVED (surfaced once Dawn was guarded).** The linux
   `nativeWrapper.cpp` references CEF types unconditionally (`CefRefPtr`,
   `cef_command_line.h` via `shared/chromium_flags.h`, scheme/V8 handlers, …) and
   is compiled against the CEF headers (the existing "CEF headers only (runtime
   detection)" path). `vendorCEF` previously fully skipped riscv64, so the headers
   were absent → `chromium_flags.h:19: 'include/cef_command_line.h' file not
   found`. CEF ships no riscv64 binary, but its headers are arch-independent, so
   `vendorCEFHeadersOnly` now vendors the linux64-minimal tarball's `include/` +
   `libcef_dll/` only (no libs → `cefLibsExist=false` → buildNative builds the
   GTK-only WebKitGTK `libNativeWrapper.so`). CEF's `include/base/cef_build.h`
   `#error`s on unknown arches, so it is patched in place with a riscv64
   `ARCH_CPU_*` branch (64-bit little-endian).
4. **`nativeWrapper.cpp` WGPU/Dawn guard — RESOLVED (commit `720e9e88` on
   `shaw/riscv64-gui-headless`).** The linux `nativeWrapper.cpp` unconditionally
   `#include "dawn/webgpu.h"` and used ~360 WGPU refs, but `vendorWGPU` has no
   Dawn build for riscv64 (→ WebKitGTK/llvmpipe), so the riscv64 cross-build
   could not compile the native wrapper. The WGPU code was confirmed CLUSTERED
   into four regions — the include (line 45), `class WGPUViewImpl` (3619-4001),
   the `initWGPUView` export (chunk A), and the `wgpu*` export/helper block
   (chunk B, ending before `loadHTMLInWebView`) — now each wrapped in
   `#if ELECTROBUN_ENABLE_WGPU`. In the `#else`: a minimal complete `WGPUViewImpl`
   (only `->parentXWindow` is read externally, by the shared resize handler's
   `dynamic_cast<WGPUViewImpl*>()` at line 6075) plus no-op/null stub bodies for
   the 22 `ELECTROBUN_EXPORT` WGPU C-ABI symbols (`initWGPUView`,
   `wgpuViewSetFrame/Transparent/Passthrough/Hidden/Remove`,
   `wgpuViewGetNativeHandle`, `wgpuInstanceCreateSurfaceMainThread`,
   `wgpuCreateSurfaceForView`, `wgpuSurface{Configure,GetCurrentTexture,Present}MainThread`,
   `wgpuQueueOnSubmittedWorkDoneShim`, `wgpuBufferMapAsyncShim`, `wgpuInstanceWaitAnyShim`,
   `wgpuBufferRead{Sync,SyncInto}Shim`, `wgpuBufferReadback{Begin,Status,Free}Shim`,
   `wgpuRunGPUTest`, `wgpuCreateAdapterDeviceMainThread`) so the launcher/main
   still link. `build.ts` defines `-DELECTROBUN_ENABLE_WGPU` exactly when
   `existsSync(wgpuIncludeDir)` (true on x64/arm64, false on riscv64), so x64/arm64
   keep the full WGPU path and only riscv64 gets stubs. mac/win nativeWrapper are
   untouched (separate WGPU handling). Preprocessor balance verified (10 `#if`/10
   `#endif`). **End-to-end riscv64 compile+link CONFIRMED** (see build findings
   above): all 22 `#else` stub symbols present, zero undefined `wgpu`/`dawn`.

### Wiring
The fork branch is local-only in the `upstreams/electrobun` submodule; the only
remote is the read-only upstream `blackboardsh/electrobun`. Pointing the parent
gitlink at the riscv64 work needs a writable fork remote (push `shaw/riscv64-gui-headless`
there, then set the submodule URL+branch). Until then the riscv64 electrobun is
build-from-local-branch only.

## Status / scope note

- **Build verified on `shaw/riscv64-gui-headless`** (platform.ts/build.ts/
  nativeWrapper arch hooks + WGPU guard `720e9e88` + build.ts gap fixes
  `dadfd0ee`). The riscv64 cross-build was driven all the way to a populated
  `dist-linux-riscv64`: `nativeWrapper.cpp` **compiles and links** for riscv64
  (the WGPU guard works — no Dawn include/type errors), and `build.ts --release`
  runs end-to-end. All known source blockers are resolved. Remaining (packaging,
  not source): no riscv64 `bun --compile` target (CLI ships as a JS bundle, not a
  self-contained binary); the launcher/extractor are real riscv64 ELF executables
  but were not runtime-tested on actual riscv64 hardware.
- **Lower priority for the OS image:** the riscv64 elizaOS image does **not** use
  electrobun. `packages/os/linux/elizaos/.../start-kiosk` stages no Electrobun
  binary on riscv64 and falls back to **cage + Epiphany (WebKitGTK) + the Node
  agent** — proven working. Electrobun-riscv64 only matters for a riscv64
  *desktop* (non-kiosk) shell, and is blocked on the Bun-riscv64 runtime above.
