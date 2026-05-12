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

## Expected Bun fork ABI

The framework must export the C ABI documented in `BRIDGE_CONTRACT.md`:

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

## Current status

Implemented in this repo:

- iOS app build gate for full-engine mode.
- CocoaPods podspec for a generated `ElizaBunEngine.xcframework`.
- Runtime dynamic-loader ABI that can boot a full Bun engine when the framework
  is present.
- Strict probes that prove current upstream Bun has no `bun-ios-*` compile
  target.

Still required in the Bun fork:

- Add iOS and iOS Simulator targets to Bun's Zig/WebKit/JSC build.
- Produce `ElizaBunEngine.xcframework`.
- Implement the C ABI in `BRIDGE_CONTRACT.md`.
- Run simulator smoke against `public/agent/agent-bundle.js`, then repeat on a
  developer-signed sideload/device build.
