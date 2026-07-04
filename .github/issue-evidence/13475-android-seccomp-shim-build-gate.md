# Issue #13475 Evidence: Android SIGSYS shim build gate

## Scope

- `stageSeccompShimForAbi` now fails the Android staging step when the compiled
  SIGSYS shim artifacts are missing for the ABI being packaged.
- This prevents stock Android APKs from shipping the raw Alpine loader, which
  was confirmed on-device to die with exit 159 / SIGSYS after PGlite init.

## Verification

```bash
bun test packages/app-core/scripts/stage-android-agent.test.mjs
```

Result: 7 tests passed. New coverage asserts an `arm64-v8a` stage with no
cached shim throws instead of continuing with the raw loader.

```bash
bunx @biomejs/biome check \
  packages/app-core/scripts/lib/stage-android-agent.mjs \
  packages/app-core/scripts/stage-android-agent.test.mjs
```

Result: exit 0. Biome reported one pre-existing warning in the launch-script
string literal; no fixes were applied.

```bash
bun run audit:error-policy-ratchet
```

Result: passed; no new fallback-slop in touched files.

## Not run

- Full `build:android` and on-device Moto/emulator boot proof are not captured
  in this slice. This PR gates the known-bad packaging path; runtime boot proof
  still requires a host with Android build prerequisites and device access.
