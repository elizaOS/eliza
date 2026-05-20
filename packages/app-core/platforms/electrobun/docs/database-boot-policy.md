# Database Boot Policy

Database startup is Electrobun launch infrastructure. It is not a Satellite and
it is not onboarding.

## Resolution Order

1. `POSTGRES_URL` wins and starts the runtime in Postgres mode.
2. `DATABASE_URL` maps to `POSTGRES_URL` when `POSTGRES_URL` is missing.
3. `ELIZA_DB_MODE=memory` selects `PGLITE_DATA_DIR=memory://`.
4. `PGLITE_DATA_DIR` selects explicit PGlite mode.
5. Packaged desktop uses persistent PGlite under app state:

```text
<appState>/database/pglite
```

Development without a database env is reported as `unknown`; the child runtime
keeps its own development policy, and launch diagnostics records the warning.

## PGlite Path

Packaged desktop never stores PGlite under the repo, cwd, temp directory, or app
bundle resources. The parent process creates and verifies the app-state path
before spawning the agent runtime.

## Startup Lock

Persistent PGlite startup uses an adjacent startup lock:

```text
<pgliteDataDir>.startup.lock
```

The lock records pid and timestamp. A live lock blocks a second startup owner.
A stale lock can be removed during the next explicit startup attempt.

## Migration Visibility

Agent stderr is parsed for plugin-sql migration lifecycle messages. Launch
diagnostics reports:

```text
starting
migrating
migration-failed
ready
locked
corrupt
permission-error
path-error
```

Database failure is shown as launch failure. It must not send the user back to
onboarding.

## Recovery

Recovery actions are explicit:

```text
retry
open-logs
backup
reset-pglite
switch-to-postgres
```

Reset creates a backup first under:

```text
<database>/pglite-backups/<timestamp>
```

The reset helper refuses memory mode, app bundle paths, broad paths, and paths
that do not end in `pglite` or `.elizadb`.

## Diagnostics

`LaunchSnapshot.database`, `desktop:getStartupDiagnostics`, and database RPCs
expose the same `DatabaseSnapshot`:

```text
database:status
database:recoveryPreview
database:backupPglite
database:resetPglite
```

Credential-bearing Postgres URLs are redacted before logging or diagnostics.
