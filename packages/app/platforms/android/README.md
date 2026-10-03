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

The agent secure-store transport reads bounded frames without Java 9
`InputStream.readNBytes`, retaining Android API 29 compatibility. Its frame-reader
JVM tests cover fragmented input, truncation, zero-progress reads and failures;
these do not replace Android socket peer-identity or Keystore qualification.
