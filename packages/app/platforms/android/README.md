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
