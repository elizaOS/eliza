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
