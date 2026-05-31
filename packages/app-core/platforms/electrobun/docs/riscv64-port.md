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

## Build findings — verified end-to-end through `buildNative` (2026-05-31)

The riscv64 cross-build was actually driven (fork branch `shaw/riscv64-gui-headless`
+ the green Rust-core riscv64 Bun at `../../../scripts/bun-riscv64/dist/bun-linux-riscv64-musl.zip`).
**Proven working:** the riscv64 GTK/WebKitGTK cross-toolchain (a standalone
`#include <gtk/gtk.h>` + `<webkit2/webkit2.h>` + `gtk_init` test compiles to a
`UCB RISC-V` ELF via `/opt/cross/bin/riscv64-linux-musl-clang++`), and electrobun's
`build.ts` harness runs end-to-end through deps → vendor → zig-0.13 download →
`BunInstall` → into `buildNative`, where pkg-config (pointed at the sysroot) feeds
the riscv64 GTK includes correctly.

### Alpine riscv64 GTK/WebKitGTK sysroot recipe (≈884 MB)
```
apk add --root <sysroot> --arch riscv64 --no-scripts --allow-untrusted --initdb \
  -X .../v3.21/main -X .../v3.21/community \
  gtk+3.0-dev webkit2gtk-4.1-dev glib-dev cairo-dev pango-dev gdk-pixbuf-dev \
  harfbuzz-dev libsoup3-dev musl-dev g++ libstdc++-dev shared-mime-info
```
Then add a STUB `<sysroot>/usr/lib/pkgconfig/shared-mime-info.pc` (Name/Description/
Version only): Alpine ships no `shared-mime-info.pc` but `gdk-pixbuf-2.0.pc`
`Requires` it, so without the stub `pkg-config --cflags gtk+-3.0` fails and the
GTK includes are never passed. `g++`/`libstdc++-dev` are required for the C++
stdlib headers (`glib-typeof.h` includes `<type_traits>`).

### Build invocation (in the bun-riscv64 builder image; sysroot at /sysroot)
```
ELECTROBUN_TARGET_ARCH=riscv64 ELECTROBUN_ZIG_TARGET=riscv64-linux-musl \
ELECTROBUN_CXX=/opt/cross/bin/riscv64-linux-musl-clang++ \
ELECTROBUN_BUN_PATH=<riscv64 bun> \
PKG_CONFIG_SYSROOT_DIR=/sysroot PKG_CONFIG_LIBDIR=/sysroot/usr/lib/pkgconfig \
bun build.ts --release
```

### Fork build.ts gaps found (need fixing on the fork branch)
1. **Vendored tooling has no riscv64 release** — `vendorBsdiff`/`vendorZstd`/
   `vendorAsar` 404 on `zig-*-linux-riscv64.tar.gz`. They are installer/update
   tooling, not runtime; make them non-fatal on riscv64 (skip with a warning) or
   cross-build them.
2. **`BunInstall()` runs the TARGET bun on the host** — it calls
   `${PATH.bun.RUNTIME} install`, but with `ELECTROBUN_BUN_PATH` set, RUNTIME is
   the riscv64 bun, which can't execute on the x86_64 build host
   (`qemu-riscv64: ... ld-musl-riscv64.so.1 not found`). Build-time `bun install`
   must use the HOST bun; only the BUNDLED bun should be riscv64.
3. **`nativeWrapper.cpp` WGPU/Dawn guard — RESOLVED (commit `720e9e88` on
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
   `#endif`); end-to-end riscv64 link verification is the remaining step (needs an
   idle host for the cross-compile).

### Wiring
The fork branch is local-only in the `upstreams/electrobun` submodule; the only
remote is the read-only upstream `blackboardsh/electrobun`. Pointing the parent
gitlink at the riscv64 work needs a writable fork remote (push `shaw/riscv64-gui-headless`
there, then set the submodule URL+branch). Until then the riscv64 electrobun is
build-from-local-branch only.

## Status / scope note

- **Code complete on `shaw/riscv64-gui-headless`** (platform.ts/build.ts/
  nativeWrapper arch hooks + the WGPU guard, commit `720e9e88`); cross-build
  driven through `buildNative`. All known source blockers are resolved; the only
  remaining step is to re-drive the riscv64 cross-compile/link end-to-end on an
  idle host to confirm the guarded wrapper links clean.
- **Lower priority for the OS image:** the riscv64 elizaOS image does **not** use
  electrobun. `packages/os/linux/elizaos/.../start-kiosk` stages no Electrobun
  binary on riscv64 and falls back to **cage + Epiphany (WebKitGTK) + the Node
  agent** — proven working. Electrobun-riscv64 only matters for a riscv64
  *desktop* (non-kiosk) shell, and is blocked on the Bun-riscv64 runtime above.
