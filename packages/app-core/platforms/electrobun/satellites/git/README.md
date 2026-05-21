# Eliza Git Satellite

`eliza.git` is the Git Satellite for ElizaLaunch. It provides trusted local Git operations to Eliza Orbit through the Satellite boundary.

This Satellite is not a sandbox. It runs `git` commands as the current local user/process, can perform write and remote operations when invoked, and should only be installed or enabled in trusted local environments. The safety model is visibility: every operation records command, cwd, stdout, stderr, exit code, status, and timing.

## Implementation Mode

Phase 7 uses deterministic Git command wrappers through `Bun.spawn(["git", ...args])`. It does not use PTY sessions for Git operations.

## Methods

- `git.status`
- `git.repo.info`
- `git.branches`
- `git.remotes`
- `git.log`
- `git.diff`
- `git.show`
- `git.add`
- `git.restore`
- `git.checkout`
- `git.branch.create`
- `git.branch.delete`
- `git.commit`
- `git.fetch`
- `git.pull`
- `git.push`
- `git.operation.list`
- `git.operation.get`
- `git.command.run`

## Operation History

Recent operations are stored in memory. The default limit is `200`; override with `ELIZA_GIT_MAX_OPERATIONS`.

Each operation includes:

- operation ID
- name
- cwd
- command array
- stdout
- stderr
- exit code
- status
- start/completion timestamps

## Remote Operations

`git.fetch`, `git.pull`, and `git.push` return structured command results or structured errors. Credential prompts are not suppressed or hidden; if Git fails due to credentials, the failure is returned with stderr and exit status.

## Environment

- `MILADY_REPO_DIR` sets the default cwd before `ELIZA_REPO_DIR`
- `ELIZA_REPO_DIR` sets the fallback default cwd
- `ELIZA_GIT_COMMAND_TIMEOUT_MS` defaults to `120000`
- `ELIZA_GIT_MAX_OPERATIONS` defaults to `200`

## Build And Smoke

```sh
bun run --cwd elizalaunch/satellites/git typecheck
bun run --cwd elizalaunch/satellites/git build
bun run --cwd elizalaunch/satellites/git smoke
bun run --cwd elizalaunch/satellites/git smoke:phase7
```

## Host Event Limitation

When the host forwards worker events, the Git Satellite can emit operation events. The current Surface path can operate with polling through `git.operation.list` and `git.operation.get`.

## Upstream Packaging Boundary

The current local module system still requires upstream packaging names like `plugin.json`, `build.carrot`, and `carrotOnly`. They are used only at the packaging boundary.
