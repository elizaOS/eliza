# @elizaos/bun-ios-runtime

Build and validation harness for embedding the full Bun engine in an iOS application.

## Role

This private package produces `artifacts/ElizaBunEngine.xcframework` from an iOS-capable Bun fork, wraps it in the stable Eliza C ABI, and verifies that device/App Store slices satisfy the no-JIT execution policy. It does not own the TypeScript agent runtime; the framework starts the packaged agent bundle and carries requests over the documented host bridge.

`BRIDGE_CONTRACT.md` is authoritative for ABI symbols and request framing. `SWIFT_BUN_COMPATIBILITY.md` defines the separate compatibility experiment. The production full-engine path is the signed `ElizaBunEngine.xcframework`.

## Layout

```
ElizaBunEngine.podspec       CocoaPods packaging boundary
BRIDGE_CONTRACT.md           ABI, lifecycle, and host-call contract
SWIFT_BUN_COMPATIBILITY.md   compatibility-lane policy
Sources/                     C ABI shim and public headers
scripts/
  check-upstream-support.mjs upstream capability probe
  build-ios-bun-engine.mjs   simulator/device framework build
  smoke-ios-bun-engine.mjs   embedded engine smoke
  verify-ios-app-store.mjs   framework/app policy verification
  ios-app-store-runtime-policy.mjs  forbidden capability classifier
patches/                     reference fork patches
artifacts/                   generated xcframework output; not source
```

## Commands

```bash
bun run --cwd packages/native/bun-runtime check
bun run --cwd packages/native/bun-runtime check:strict
bun run --cwd packages/native/bun-runtime build:sim
bun run --cwd packages/native/bun-runtime build:device
bun run --cwd packages/native/bun-runtime smoke:sim
bun run --cwd packages/native/bun-runtime smoke:device
bun run --cwd packages/native/bun-runtime verify:app-store
bun run --cwd packages/native/bun-runtime test
bun run --cwd packages/native/bun-runtime lint:check
bun run --cwd packages/native/bun-runtime format:check
```

Builds require an iOS-capable Bun source tree at `vendor/bun` or `ELIZA_BUN_IOS_SOURCE_DIR`. A missing framework is an error when full-engine mode is requested; never fall back silently to a compatibility runtime.

## Security and ABI rules

- Device/App Store slices are no-JIT and must not import arbitrary dynamic loading, process spawning, shell execution, package installation, or executable-memory permission APIs.
- The framework declares its ABI version, `ElizaBunEngineNoJIT`, and `ElizaBunEngineExecutionProfile` in metadata; build and verification reject mismatches.
- Production links the framework directly through CocoaPods. Debug compatibility loading must not leak into the App Store artifact.
- Preserve request correlation, UTF-8/JSON ownership, callback lifetime, stop semantics, and `eliza_bun_engine_free` ownership from `BRIDGE_CONTRACT.md`.
- Native model operations cross the host callback; do not open an internal TCP server or bypass the signed host bridge.
- Generated frameworks are platform artifacts. Build the latest source and verify the exact framework embedded in the app.

## Verification

Follow the repository-wide standard in the [root CLAUDE.md](../../../CLAUDE.md). Run unit and policy checks, build the affected simulator/device slice, smoke the real agent bundle, verify the embedded framework and signed app, and inspect host-call logs and failure behavior on a simulator or physical device as required.

