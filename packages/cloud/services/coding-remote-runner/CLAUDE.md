# @elizaos/coding-remote-runner

A small, single-file Bun HTTP runner that exposes a sandboxed workspace
(filesystem + process execution) over HTTP. It powers Eliza Cloud coding
containers and home-machine remote-runner hosting, serving the contract consumed
by `packages/agent/src/services/e2b-capability-router.ts`.

## What it serves

A bearer-authenticated HTTP API over a single workspace root:

```text
GET  /health                          public health (no auth)
GET  /v1/health                       authed health + capabilities
GET  /v1/fs/entries?path=/workspace   list directory entries
GET  /v1/fs/file?path=…               read a file (octet-stream)
PUT  /v1/fs/file?path=…               write a file
POST /v1/processes/run                run a command (JSON body)
```

## Layout / exports

- `src/index.ts` — the entire service. Public exports: `loadConfig`,
  `ensureWorkspace`, `createHandler` (the `Request => Response` fetch handler),
  plus types `RunnerConfig`, `CommandPayload`, `CommandResult`, and
  `CodingRemoteRunnerCommandRunner`. The `import.meta.main` block boots
  `Bun.serve` when run directly.
- `__tests__/server.test.ts` — `bun:test` coverage for auth, fs list/read/write,
  workspace escape rejection, symlink rejection, and process run (injects a fake
  `commandRunner`).
- `Dockerfile` — `node:24-bookworm-slim` base; installs Bun plus `git`,
  `ripgrep`, `python3`, `jq`, `openssh-client`, and (by default) the Codex,
  and Claude Code CLIs.
  Runs as the non-root `runner` user; healthcheck hits `/health`.

## Scripts (scope with `--cwd`)

```bash
bun run --cwd packages/cloud/services/coding-remote-runner start        # boot the runner
bun run --cwd packages/cloud/services/coding-remote-runner dev          # boot with --watch
bun run --cwd packages/cloud/services/coding-remote-runner test         # bun test
bun run --cwd packages/cloud/services/coding-remote-runner typecheck    # tsc --noEmit
bun run --cwd packages/cloud/services/coding-remote-runner docker:build # build the local image
```

Disable the bundled coding CLIs at image-build time with
`--build-arg INSTALL_CODEX=false` and `INSTALL_CLAUDE_CODE=false`.

## Env vars

- `ELIZA_REMOTE_RUNNER_HTTP_TOKEN` (or `REMOTE_RUNNER_HTTP_TOKEN`) — bearer token
  required on every `/v1/*` route. If unset, `/v1/*` returns 503 unless
  `ELIZA_REMOTE_RUNNER_ALLOW_UNAUTHENTICATED=1`.
- `ELIZA_CODING_WORKSPACE` (falls back to `ELIZA_SANDBOX_WORKDIR`,
  `WORKSPACE_DIR`, then `/workspace`) — the real filesystem root that bounds all
  fs/process operations.
- `ELIZA_CODING_CONTAINER_WORKSPACE` — the container-facing workspace path used
  for path normalization in responses (default `/workspace`).
- `HOST` (default `127.0.0.1`; set explicitly to opt into wider binds), `PORT`
  (default `3000`).
- `ELIZA_REMOTE_RUNNER_MAX_READ_BYTES` (default 5 MiB),
  `ELIZA_REMOTE_RUNNER_COMMAND_TIMEOUT_MS` (default 60000),
  `ELIZA_REMOTE_RUNNER_MAX_COMMAND_OUTPUT_BYTES` (default 1 MiB).

## Conventions / gotchas

- **Workspace is the security boundary.** Every path is resolved through
  `realpath` and checked to stay inside the workspace root; escapes return 403,
  missing paths 404. Writes through symlinks are rejected (403). The
  container-path vs. real-fs-path distinction is deliberate — keep both halves
  consistent when touching path resolution.
- **Logging is hand-rolled JSON-lines** to stdout/stderr via the local `log()`
  helper (this is a standalone service with no `@elizaos/core` dependency), not
  the framework logger. Messages are prefixed `[CodingRemoteRunner]`.
- **Command output is bounded** by a ring-buffer (`BoundedOutput`) that keeps the
  tail; a timed-out command is killed (`SIGTERM`) and reported with exit code
  `124` and `timedOut: true`.
- **Runtime-agnostic process exec.** `runCommand` uses `Bun.spawn` when running
  under Bun and falls back to Node's `child_process.spawn` otherwise; tests
  override execution by passing a `commandRunner` into `createHandler`.
- **No build step / no published artifact.** `private: true`, runs directly from
  `src/index.ts`; `typecheck` uses `tsc`. The handler is a plain Web
  `Request`/`Response` function, so it is testable without binding a port.

Repo-wide rules (logger-only, ESM, naming, architecture) are in the root [CLAUDE.md](../../../../CLAUDE.md).

## Verification

Follow the repository-wide verification and evidence standard in the [root CLAUDE.md](../../../../CLAUDE.md). Run
the package's relevant build, typecheck, lint, and test commands, then exercise
the real integration boundary changed by the work. Inspect the produced domain
artifacts and failure behavior; do not substitute mocked success for the system
under test.
