# elizaOS Android build targets

The build orchestrator at [`packages/app/scripts/run-mobile-build.ts`](../../scripts/run-mobile-build.ts) ships four Android targets.

This directory is part of `packages/app`.

Build from the repository root:

```bash
bun run --cwd packages/app build
```

Test from the repository root:

```bash
bun run --cwd packages/app test
```

Detached resident shutdown matches the complete launch arguments and rechecks the
app UID, process start time, executable identity, and packaged Bun mapping before
sending SIGTERM. An ambiguous or changed identity fails shutdown instead of
falling back to a shared-runtime path match. Ownership and credentials remain
intact when termination is refused so a later stop can retry. A refusal never
escapes `onDestroy`, the restart worker or the watchdog: the service records
`stop-detached-agent-refused`, skips the restart and reports `stop-failed`.
Launch and stop both use canonical runtime paths, because app storage is
normally reached through the `/data/user/0` alias. The launcher sends no broad process
signals, so admitted workflow workers can survive resident restarts.

These checks do not provide an atomic pidfd-based signal operation. Native
qualification must cover normal restart, preserved workflow workers, refused
ambiguous identities, and unconfirmed shutdown without reporting success.

`ResidentStopOwnershipInstrumentedTest` exercises the real service stop path
against an absent deployment and verifies two refused attempts preserve ownership,
credentials, and output pumps, and that refusals during an explicit destroy or a
restart do not escape. Enable it explicitly with `residentStopFixture=1`
in a debug test process with no active service. Only the aliased-storage case
enumerates `/proc`, for a deployment whose resident is not running, so it
cannot match or signal any process; it then records a stopped runtime for the
debug app.

Native hosts can pass an `ElizaAgentService.LocalStreamHandle` when requesting a
local stream and cancel it to close the connection, including during connection
retry. Cancellation never rolls back or replays an already dispatched request.
Premature EOF reports an unknown outcome; only an explicit terminal frame proves
stream completion. Connections verify the kernel-reported app UID before writing
request bytes. The existing two-argument overload remains available; callers must
use the handle overload to propagate cancellation.

`ResidentStreamTransportInstrumentedTest` exercises a controlled native socket
with split frames, cancellation, EOF, terminal errors, and no replay. It requires
a debug APK in a disposable secondary Android user, an inactive resident service,
`residentStreamFixture=1`, and a UUID `residentStreamRunId`. It never starts an
agent or contacts a model provider.

The agent secure-store transport reads bounded frames without Java 9
`InputStream.readNBytes`, retaining Android API 29 compatibility. Its frame-reader
JVM tests cover fragmented input, truncation, zero-progress reads and failures;
these do not replace Android socket peer-identity or Keystore qualification.
