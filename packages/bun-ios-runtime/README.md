# @elizaos/bun-ios-runtime

This package owns the full Bun engine port for iOS. It intentionally lives under
`packages/` so the repo does not need a separate top-level native workspace.

The current upstream Bun release does not publish an iOS target for
`bun build --compile`; the supported standalone executable targets are Linux,
macOS, and Windows. A real phone build therefore needs an embeddable iOS
framework produced from a Bun fork, not a macOS Bun executable copied into an
iOS app bundle.

## Artifact contract

The app build looks for this framework when `ELIZA_IOS_FULL_BUN_ENGINE=1`:

```text
packages/bun-ios-runtime/artifacts/ElizaBunEngine.xcframework
```

You can override the path with:

```bash
ELIZA_IOS_BUN_ENGINE_XCFRAMEWORK=/absolute/path/ElizaBunEngine.xcframework
```

If full-engine mode is requested and the framework is missing, the iOS build
fails before CocoaPods instead of falling back to the JSContext compatibility
host.

## Reference ports

The harness follows the same practical shape as the public mobile runtime
examples:

- `dannote/pi-ios` and `dannote/bun` prove the iOS Bun path by building
  JavaScriptCore in `JSCOnly` / C_LOOP / no-JIT mode, then linking Bun as app
  code that exposes `bun_start(...)`.
- `iOSExpertise/nodejs-mobile` uses the same packaging pattern we need here:
  build static mobile runtime pieces first, then wrap them in an iOS framework
  that Xcode/CocoaPods can sign and embed.

The package supplies the Eliza ABI shim in
`Sources/ElizaBunEngineShim/`. A Bun fork can either export the Eliza ABI
directly or expose the `src/ios/bun_ios.h` style API used by `dannote/bun`; the
build script wraps that Bun API into `ElizaBunEngine.framework`.

The exported Eliza ABI is documented in `BRIDGE_CONTRACT.md`:

- `eliza_bun_engine_abi_version`
- `eliza_bun_engine_start`
- `eliza_bun_engine_stop`
- `eliza_bun_engine_call`
- `eliza_bun_engine_free`

The Capacitor runtime loads this framework dynamically, so compatibility builds
do not link or require the full engine. When the framework exists, `start()`
defaults to `engine: "auto"` and will boot the full engine. Passing
`engine: "bun"` requires the framework and returns an error if it is missing.

## Build workflow

```bash
# Verify upstream target reality on the current Bun binary.
bun run --cwd packages/bun-ios-runtime check

# Build the simulator engine from a fork checkout.
ELIZA_BUN_IOS_SOURCE_DIR=/path/to/elizaos-bun \
  bun run --cwd packages/bun-ios-runtime build:sim

# Build and require the full engine inside the iOS app.
ELIZA_IOS_FULL_BUN_ENGINE=1 \
  bun run --cwd packages/app build:ios:local:sim
```

By default the build script expects a fork checkout at
`packages/bun-ios-runtime/vendor/bun` or `ELIZA_BUN_IOS_SOURCE_DIR`. The public
`https://github.com/elizaos/bun` repository was not available at the time this
package was added, so the scripts do not silently clone or vendor upstream Bun.

The CMake backend is selected automatically when the source checkout has a
`CMakeLists.txt`. Useful inputs:

```bash
# Staged WebKit/JSC output with lib/ and JavaScriptCore/Headers/.
ELIZA_BUN_IOS_WEBKIT_BUILD_DIR=/path/to/WebKitBuild/JSCOnly

# Or a ready include/lib staging directory.
ELIZA_BUN_IOS_WEBKIT_PATH=/path/to/staged-ios-webkit

# Force CMake and pass fork-specific flags.
ELIZA_BUN_IOS_BUILD_BACKEND=cmake
ELIZA_BUN_IOS_CMAKE_ARGS="-DWEBKIT_PATH=/path/to/staged-ios-webkit"
```

When the Bun fork emits `libbun-profile.a` or `CMakeFiles/bun-profile.dir/*.o`
plus `bun-zig.o`, this package links those objects with
`Sources/ElizaBunEngineShim/eliza_bun_engine_shim.c`, validates the required
symbols, and writes `artifacts/ElizaBunEngine.xcframework`.

## Runtime bridge

The C shim starts:

```text
public/agent/agent-bundle.js ios-bridge --stdio
```

`packages/agent/src/cli/ios-bridge.ts` then boots the real agent runtime and
starts the existing API server on an ephemeral loopback port inside the Bun
process. The WebView never connects to that TCP port. UI calls flow:

```text
React fetch / Agent.request
  -> Capacitor ElizaBunRuntime.call("http_request")
  -> ElizaBunEngine C ABI
  -> stdio NDJSON
  -> agent ios-bridge
  -> existing backend routes
```

That gives the app a full local backend over a Capacitor-owned IPC surface. The
remaining architectural cleanup is to expose the backend as a direct
fetch/Hono-style route kernel so `ios-bridge` can call routes without the
internal loopback server.

## Current status

Implemented in this repo:

- iOS app build gate for full-engine mode.
- CocoaPods podspec for a generated `ElizaBunEngine.xcframework`.
- C shim that wraps a `bun_start(...)` iOS fork into the Eliza ABI.
- Agent-side `ios-bridge --stdio` command for bridged HTTP requests and
  `send_message`.
- React/UI transport that uses the full Bun bridge when the Capacitor plugin is
  present, otherwise falls back to the JSContext ITTP compatibility kernel.
- Runtime dynamic-loader ABI that can boot a full Bun engine when the framework
  is present.
- Strict probes that prove current upstream Bun has no `bun-ios-*` compile
  target.

Still required in the Bun fork:

- Add or maintain iOS and iOS Simulator targets in Bun's Zig/WebKit/JSC build.
- Produce `ElizaBunEngine.xcframework`.
- Export `bun_start(...)` compatible with `src/ios/bun_ios.h`, or export the
  Eliza ABI directly.
- Run simulator smoke against `public/agent/agent-bundle.js`, then repeat on a
  developer-signed sideload/device build.
