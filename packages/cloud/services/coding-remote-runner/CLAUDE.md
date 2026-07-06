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
  Claude Code, and opencode CLIs. It can optionally install the elizaOS-owned
  coding agent (`eliza-code-acp`) once `@elizaos/example-code` is published.
  Runs as the non-root `runner` user; healthcheck hits `/health`.

## Scripts (scope with `--cwd`)

```bash
bun run --cwd packages/cloud/services/coding-remote-runner start        # boot the runner
bun run --cwd packages/cloud/services/coding-remote-runner dev          # boot with --watch
bun run --cwd packages/cloud/services/coding-remote-runner test         # bun test
bun run --cwd packages/cloud/services/coding-remote-runner typecheck    # tsgo --noEmit
bun run --cwd packages/cloud/services/coding-remote-runner docker:build # build the local image
```

Disable the bundled coding CLIs at image-build time with
`--build-arg INSTALL_CODEX=false`, `INSTALL_CLAUDE_CODE=false`, and
`INSTALL_OPENCODE=false`. Opt into the elizaOS coding agent with
`--build-arg INSTALL_ELIZA_CODE=true`; override the exact npm package with
`--build-arg ELIZA_CODE_PACKAGE=@elizaos/example-code@<version>`.

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
  `src/index.ts`; `typecheck` uses `tsgo`. The handler is a plain Web
  `Request`/`Response` function, so it is testable without binding a port.

Repo-wide rules (logger-only, ESM, naming, architecture) are in the root [AGENTS.md](../../../../AGENTS.md).

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root AGENTS.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[AGENTS.md](../../../../AGENTS.md)**. Read it.
> Nothing in this package is *done* until it is *proven* done — a reviewer must confirm it
> works **without reading the code**, from the artifacts you attach. This applies to **every**
> feature, fix, refactor, and chore here. "Tests pass" is not proof; "CI is green" is not proof.

- **Record AND read model trajectories.** Capture the *actual* inputs and outputs of the model
  from a **live** LLM — not the deterministic proxy, not a mock: the prompt, the
  providers/context, the raw model output, every tool/action call, and the result. Then **open
  the trajectory and review it by hand.** A captured-but-unread trajectory is not evidence
  (`packages/scenario-runner/bin/eliza-scenarios run <scenario> --report <out>`).
- **Real, full-featured E2E — no larp.** Every feature ships detailed end-to-end tests that
  drive the *real* path end to end. Not the happy "front door" only: cover error paths,
  edge/empty/invalid input, concurrency, roles/permissions, and adversarial input. A test that
  asserts against a mock/stub/fixture standing in for the thing under test **does not count**.
  If the real model/device/chain/connector/account is hard to reach, **make it reachable — that
  is the work**, not an excuse to mock. If the existing tests here are shallow or mocked, fixing
  them is part of your change.
- **Screenshots + logs at every phase**, plus a **complete walkthrough video/run-through** of
  the entire feature or view, start to finish (`bun run test:e2e:record`).
- **Manually review every artifact the change touches** — never just the green check: client
  logs (console + network), server logs (`[ClassName] …`), the model trajectories in and out,
  before/after full-page screenshots, **and the domain artifacts listed below for this package.**
- **No residuals. No shortcuts.** The goal is not "done" — it is *everything* done. Clear every
  blocker by the **hard path**: build the real architecture, stand up the real
  model/device/service, actually test it. Never leave a TODO, a stub, a stepping-stone, or a
  "follow-up." When unsure, research thoroughly, weigh the options, and ship the best,
  highest-effort, production-ready version. Keep going until every possibility is exhausted.

Artifacts → attached inline in the PR (MP4 video, JPG screenshots, logs in `<details>`); attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — cloud backend / security:**
- Real request → response traces against the local cloud stack (`bun run cloud:mock`) hitting real endpoints, plus the structured backend logs.
- The **DB state** the change produced/changed (Drizzle rows), billing/usage records, and migration up **and** down.
- Auth/role-gating and multi-tenant isolation proven by test, including the denied-access paths (see #9853/#9948) — not assumed.
- The agent trajectory for any model-backed endpoint.
<!-- END: evidence-and-e2e-mandate -->
