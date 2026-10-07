# `scripts/` — build, dev orchestration, tooling

Build, development, packaging, and platform orchestration for the Eliza app. Invoke scripts through the root or app package manifests.

This directory is part of `packages/app`.

Build from the repository root:

```bash
bun run build:client
```

Test from the repository root:

```bash
bun run --cwd packages/app test
```

Hosted Android E2E requires SELinux enforcing and never roots the device or relaxes
its policy. The runner requires the renderer stamp to match the full current Git
revision, rebuilding cached output from older revisions before testing.

Thin consumers can build the shared task runtime with `build:consumer-tasks --
OUTPUT SOURCE_ROOT REVIEWED_COMMIT`. The builder exports immutable Git bytes,
records the full source commit and bundle hash, and optionally stages the narrow
browser task/voice contracts through its `browserSource` API option. Product
policy and task workflows are supplied by the consuming host.

`lib/isolated-android-test.mjs` owns disposable consumer APK test admission,
leases, installed-byte checks, complete instrumentation evidence and cleanup.
Callers declare APK identities, fixture AVD/ABI/user and scenarios. Its read-only
`preflightVariant` runs before installation; `cleanupVariant` runs once after
entered setup, including failure/cancellation, with an independent cleanup
command deadline. Context includes `run`, the held `deviceLease` for nested
fixtures, and the report `record`. Cleanup failure retains installations for
explicit recovery. Companion `updates` must declare local APK paths and SHA-256
pins of the same package; only those exact bytes may be cleaned after an
instrumented update. Device-owner and network changes remain explicit caller
policy and must be restored by the cleanup callback.


For process-death qualification, an explicit single-method scenario can call
`context.interruptPhase(name, {args, markerPath, timeoutMs})` from
`collectVariant` after successful setup instrumentation. The app must write a
private JSON marker with the harness-generated `interruptionRunId` extra as
`runId`, main PID and `/proc` start time
as `startTimeTicks` (a decimal string). The runner validates package/user UID,
process identity, live lease and installed APK bytes before force-stopping only
that owned package. It requires all observed UID processes to exit and a matching
started-but-crashed instrumentation result. Timeout, stale marker, changed process
or lost custody fails; a crash alone never passes. Call a separate successful
`instrumentPhase` to verify product recovery before returning. Its record names
the interruption it recovers; cleanup cannot satisfy this requirement. This API
is not a device-acceptance claim and does not retry interrupted user effects.
