# Eliza File Remote

`eliza.fs` is the File Remote for ElizaLaunch. It exposes scoped filesystem operations for Eliza Orbit through the Remote boundary.

Phase 5 keeps filesystem access brokered:

```text
Surface Remote -> eliza.runtime -> eliza.fs
```

The Surface Remote does not call this Remote directly.

## Roots

Allowed roots come from `ELIZA_FS_ROOTS`, a comma-separated list of absolute paths. If it is unset, the File Remote uses:

1. `ELIZA_REPO_DIR`
2. `ELIZA_REPO_DIR`
3. Current working directory

Every request is resolved against the allowed roots. Path traversal and symlink escape outside those roots are denied.

## Denied Paths

Sensitive paths are denied by default, including `.ssh`, `.gnupg`, `.aws`, `.config/gh`, `.env`, `.env.local`, `.env.production`, `id_rsa`, and `id_ed25519`.

Heavy/generated folders are excluded by default: `node_modules`, `.git`, `dist`, `build`, `.next`, `.turbo`, and `.cache`.

Hidden files are only available where a method supports `includeHidden: true`; sensitive paths remain denied.

## Limits

Defaults:

- Max read size: 1 MiB
- Max write size: 1 MiB
- Max directory entries: 500
- Max search matches: 100
- Max search file size: 512 KiB

Environment overrides:

- `ELIZA_FS_MAX_READ_BYTES`
- `ELIZA_FS_MAX_WRITE_BYTES`
- `ELIZA_FS_MAX_DIR_ENTRIES`
- `ELIZA_FS_MAX_SEARCH_MATCHES`
- `ELIZA_FS_MAX_SEARCH_FILE_BYTES`

## Methods

- `fs.status`
- `fs.roots`
- `fs.stat`
- `fs.list`
- `fs.readText`
- `fs.search`
- `fs.writeText`

`fs.writeText` is implemented but disabled by default. Set `ELIZA_FS_ENABLE_WRITES=1` to enable safe text writes under an allowed root. Delete operations are outside the Phase 5 remote command set.

## Commands

```sh
bun run --cwd elizalaunch/remotes/fs build
bun run --cwd elizalaunch/remotes/fs smoke
bun run --cwd elizalaunch/remotes/fs smoke:phase5
bun run --cwd elizalaunch/remotes/fs typecheck
```

The smoke test creates a temporary allowed root, verifies list/read/search behavior, verifies sensitive path and traversal denial, verifies generated folder skipping, and verifies writes are disabled unless `ELIZA_FS_ENABLE_WRITES=1`.
