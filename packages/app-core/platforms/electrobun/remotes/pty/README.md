# Eliza Terminal Remote

`eliza.pty` is the Terminal Remote for ElizaLaunch. It provides trusted local terminal sessions for Eliza Orbit through the Remote boundary.

This Remote is not a sandbox. It runs commands as the current local user/process and should only be installed or enabled in trusted local environments. The safety model is visibility and explicit enablement: sessions are listed, output is buffered, input is explicit, and lifecycle controls are exposed.

The manifest requests full accepted local terminal permissions: host storage and notifications, host module-management permission for module invocation where required, Bun read/write/env/run/worker/ffi/addons, and isolated-process execution. It does not request a visible window permission; the hidden view entry exists because the current upstream manifest shape requires a view field.

## Implementation Mode

Phase 6 uses Bun's built-in terminal support through `Bun.spawn(..., { terminal })`. This means:

- command/session lifecycle works
- stdout/stderr output capture works
- stdin writes work for spawned processes and shells
- kill works
- resize calls the underlying terminal resize API

## Methods

- `pty.status`
- `pty.session.create`
- `pty.session.list`
- `pty.session.get`
- `pty.session.write`
- `pty.session.resize`
- `pty.session.kill`
- `pty.session.output.tail`
- `pty.session.output.clear`
- `pty.command.run`

## Events

When the host forwards worker events, `eliza.pty` emits:

- `pty.session.created`
- `pty.output`
- `pty.session.exited`
- `pty.session.killed`
- `pty.error`

Output polling through `pty.session.output.tail` is sufficient for Phase 6 when event broadcast is unavailable.

## Environment

- `ELIZA_PTY_MAX_OUTPUT_ENTRIES` defaults to `5000`
- `ELIZA_PTY_MAX_OUTPUT_BYTES` defaults to `5242880`
- `ELIZA_PTY_MAX_SESSIONS` defaults to `8`
- `ELIZA_PTY_COMMAND_TIMEOUT_MS` defaults to `120000`
- `MILADY_REPO_DIR` sets the default cwd before `ELIZA_REPO_DIR`
- `ELIZA_REPO_DIR` sets the fallback default cwd

Session environment inherits `process.env` and merges per-session env overrides.

## Build And Smoke

```sh
bun run --cwd elizalaunch/remotes/pty build
bun run --cwd elizalaunch/remotes/pty smoke
bun run --cwd elizalaunch/remotes/pty smoke:phase6
```

## Upstream Packaging Boundary

The current local module system still requires upstream packaging names like `carrot.json`, `build.carrot`, and `carrotOnly`. They are used only at the packaging boundary.
