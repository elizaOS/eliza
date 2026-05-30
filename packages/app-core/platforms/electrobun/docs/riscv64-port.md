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

## Status / scope note

- **Not started as code** — electrobun is an external dep; this needs a fork.
- **Lower priority for the OS image:** the riscv64 elizaOS image does **not** use
  electrobun. `packages/os/linux/elizaos/.../start-kiosk` stages no Electrobun
  binary on riscv64 and falls back to **cage + Epiphany (WebKitGTK) + the Node
  agent** — proven working. Electrobun-riscv64 only matters for a riscv64
  *desktop* (non-kiosk) shell, and is blocked on the Bun-riscv64 runtime above.
