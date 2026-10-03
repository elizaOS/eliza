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
intact when termination is refused so a later stop can retry. The launcher sends no broad process
signals, so admitted workflow workers can survive resident restarts.

These checks do not provide an atomic pidfd-based signal operation. Native
qualification must cover normal restart, preserved workflow workers, refused
ambiguous identities, and unconfirmed shutdown without reporting success.

`ResidentStopOwnershipInstrumentedTest` exercises the real service stop path
against an absent deployment and verifies two refused attempts preserve ownership,
credentials, and output pumps. Enable it explicitly with `residentStopFixture=1`
in a debug test process with no active service; it never enumerates or signals
processes because deployment validation fails first.
