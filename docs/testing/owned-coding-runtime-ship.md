# Owned coding runtime: architecture, QA, and handoff

Date: 2026-08-20

## Ship decision

Eliza's first-party coding path is the implementation being shipped. OpenCode
and pi-agent were not copied into the runtime. They remain useful references or
explicit optional ACP backends, but neither is required for the owned path.

The tested production chain is:

```text
User in Eliza
  -> parent AgentRuntime and model planner
  -> plugin-agent-orchestrator / TASKS_SPAWN_AGENT
  -> durable OrchestratorTaskService task and session
  -> AcpService native subprocess transport
  -> packaged packages/examples/code/dist/acp.js (eliza-code)
  -> child AgentRuntime in coding-only mode
  -> plugin-coding-tools FILE and SHELL actions
  -> native child trajectory ingestion
  -> completion-evidence bundle and goal verifier
  -> durable lifecycle event and asynchronous parent/UI result
```

This is the same runtime chain used when a normal Eliza agent delegates a coding
task. The browser-only QA used a separate local Eliza process and UI, but it did
not substitute a test harness for the parent planner or child runtime.

## What was fixed

### Exact workdir ownership

`lockWorkdir` is now a planner-visible optional `TASKS` parameter. When the user
explicitly requires an existing workdir, the parent can mark it authoritative so
project-route and convention inference cannot silently move the coding child to
another directory. The child coding prompt also requires absolute FILE paths and
requires a corrected retry of the same failed operation.

### Detached child trajectory ownership

A top-level `spawn_agent` starts the ACP child before the durable task row exists.
Previously that child could inherit the parent trajectory directory, while the
task verifier searched only its later per-task directory. A genuinely successful
child could therefore look unevidenced and be retried.

The parent now reserves a managed, unique pending child-trajectory directory
before spawning ACP. Its trace ID and parent step ID are passed to the child and
persisted when the session is attached to the durable task. Completion ingestion
accepts only the canonical task directory and that validated direct child of the
managed trajectory root, path-checks it, deduplicates it, and attaches each
trajectory as a task artifact with correlation metadata.

### Verifier-grade tool evidence

Completion evidence now contains an ordered, bounded child tool trace. It keeps
the tool/action, safe path or cwd/command arguments, status, and bounded shell
output needed to prove tests. It deliberately excludes FILE contents, applies
the core sensitive-text redactor, caps entries and field sizes, and only retains
command output for shell-like tools.

The result is evidence such as `FILE read <absolute path>` followed by
`SHELL run cwd=<exact workdir> command=bun test ...`, including the real pass/fail
output. The LLM goal verifier no longer has to infer success from a thin final
sentence.

## Acceptance coverage

### Deterministic suites

- `plugin-agent-orchestrator`: 252 test files passed, 7 skipped; 2,941 tests
  passed, 11 skipped.
- `packages/examples/code`: 89 tests passed across 28 files; typecheck and
  packaged `index.js`/`acp.js` build passed.
- Focused regression coverage proves planner-visible exact-workdir locking,
  top-level pre-task trace reservation, trace/session correlation, detached
  trajectory ingestion, secret redaction, source-content exclusion, and exact
  FILE/SHELL completion evidence.

### Real parent and concurrent child acceptance

Run `e2e:owned-parent-orchestrator-live` with a private OpenRouter credential.
It builds every required package and uses the real OpenRouter-backed parent and
child runtimes with `qwen/qwen3.8-27b`.

The live gate requires all of the following:

1. A natural parent turn selects `TASKS_SPAWN_AGENT` itself.
2. Two additional parent-side spawns run concurrently and have overlapping ACP
   execution windows.
3. Every child uses the packaged native `eliza-code` ACP entrypoint and real
   coding-tools FILE/SHELL actions.
4. Every task has durable ownership, an exact workdir, a correlated child
   trajectory artifact, an independently passing `bun test`, and no workspace
   changes.
5. Every task completes manual validation and then archive/reopen lifecycle
   transitions.
6. The retained report, parent/child trajectories, and verifier completion
   evidence are sanitized before they are written to the requested evidence
   directory.
7. The repository is clean at both the start and end of the run, so the report's
   `repoHead` identifies the exact source that produced the evidence.

The 2026-08-20 release run passed all three scenarios. Both concurrent sessions
were observed `busy`, their execution windows overlapped, every independent
fixture test returned one pass and zero failures, every read-only workspace was
unchanged, and all three lifecycle sequences reached `done`, `archived`, then
`active` after reopen.

### Browser-only Eliza UI acceptance

An isolated browser Eliza instance was run on dedicated ports, separate state,
and this worktree. The real parent planner selected `TASKS_SPAWN_AGENT` for an
ordinary chat message, preserved the requested `packages/examples/code`
workdir, and spawned the owned coding child. The child read exactly the two
requested files and ran exactly:

```bash
bun test src/lib/text-width.test.ts
```

The tool trajectory recorded three successful stages, the command reported
three passing tests and zero failures, the durable task moved through validation
to `done` on the first attempt, and the asynchronous result appeared in the UI.
No native desktop bundle was launched or tested by this coding-runtime lane.

## Reproduce

Install and run the deterministic gates from the repository root:

```bash
bun install
bun run --cwd plugins/plugin-agent-orchestrator test
bun run --cwd packages/examples/code test
bun run --cwd packages/examples/code typecheck
bun run --cwd packages/examples/code build
```

Run the complete live parent matrix without putting a credential in a tracked
file or command argument:

```bash
export ELIZA_LIVE_QA_OPENROUTER_KEY='<private OpenRouter key>'
export ELIZA_LIVE_QA_MODEL='qwen/qwen3.8-27b'
export ELIZA_LIVE_QA_REPORT_DIR='/private/safe/report/directory'
bun run --cwd packages/examples/code e2e:owned-parent-orchestrator-live
unset ELIZA_LIVE_QA_OPENROUTER_KEY
```

`ELIZA_LIVE_QA_KEEP=1` keeps the unsanitized temporary runtime for local
diagnosis. The default removes it. Only the sanitized report directory is fit
for a normal handoff, and it should still be reviewed before publication.

## Operational behavior and limits

- Parent delegation is fire-and-follow-up: the initial reply acknowledges the
  spawn; the orchestrator posts the actual child result asynchronously.
- Durable tasks, sessions, events, evidence, and lifecycle state survive beyond
  the initiating model turn.
- The full deterministic suite covers automatic goal verification, retry,
  recovery, supervision, routing, and fail-closed gates. The live matrix drives
  the lifecycle explicitly after independent verification to avoid spending a
  second model judgment on known read-only fixtures.
- OpenCode and pi-agent are not runtime dependencies of this ship candidate.
- The root macOS SourceKitten/native-gateway verifier remains a host toolchain
  concern and is not evidence against this JavaScript/ACP coding path.

## VPS handoff

Fetch the dedicated `codex/coding-runtime-ship-20260820` branch, inspect the two
candidate commits relative to `761b5e8d7`, install dependencies, and run the
deterministic commands above. Use a private environment-secret mechanism for a
live OpenRouter rerun. Do not copy a credential, local state directory, PGlite
database, or unsanitized trajectory directory from the QA host.

The exact pushed delivery commit is reported by the handoff message and can be
confirmed after checkout with `git rev-parse HEAD`.
