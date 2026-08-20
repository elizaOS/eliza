# Owned coding runtime: architecture, QA, and handoff

Date: 2026-08-20

## Ship decision

Eliza's first-party coding path is the implementation being shipped. OpenCode
and pi-agent were not copied into the runtime. They remain useful references or
explicit optional ACP backends, but neither is required for the owned path.

Correctness is release-ready after both the normal-person browser regression and
the exact-head parent/orchestrator matrix below. The final live matrix passed on
`cbb6da285f8f983dbc16379fe2998c762704939e`, with a clean repository before and
after the run. The OpenRouter/Qwen QA configuration is still not a flawless
interactive experience: successful two- to four-step coding turns took 62-81
seconds in the saved runtime trajectories. Treat provider/model latency as a
visible ship caveat, not as evidence of a tool or orchestration failure.

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

### Immediate durable ownership after spawn

The first exact-head rerun after the normal-person browser fix exposed a second
real failure: native ACP successfully spawned the child, but the durable coding
task did not appear before the five-minute gate timed out. `spawn_agent` created
the durable row only after the child was live, and criteria-free `createTask`
then made an optional `TEXT_SMALL` model request before writing that row. A slow
or stuck provider could therefore leave a running child temporarily unowned.

Top-level `spawn_agent` now supplies Eliza's deterministic coding acceptance
criteria when creating its post-spawn durable owner. `createTask` records those
caller-owned criteria without another model request, then `attachSession` binds
the already-live child immediately. A focused regression pins that exact input,
and the final live rerun progressed through ownership, child completion,
evidence ingestion, validation, archive, and reopen for all three scenarios.

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

### Workspace/device FILE routing

A normal browser prompt naming an absolute host file initially exposed a real
failure. The planner selected `FILE target=device`, the device bridge rejected
the absolute path, and later successful SHELL work could not clear that earlier
failure because it was a different tool operation. The edit landed correctly,
but the UI first reported that the runtime step failed and leaked raw command
evidence. That run is a failed UX acceptance, not a pass.

`FILE` now states that workspace is the default for every code/project file and
every absolute path, while `target=device` is only for an explicitly requested
phone/mobile file with a relative path. An impossible absolute device path is
returned as a structured, retryable parameter error naming `target`; device
bridge I/O errors are translated to explicit action failures rather than thrown
through the action boundary. The corrected browser retry used workspace FILE
read/edit calls only and produced a clean final response.

## Acceptance coverage

### Deterministic suites

- `plugin-agent-orchestrator`: 252 test files passed, 7 skipped; 2,941 tests
  passed, 11 skipped.
- `plugin-coding-tools`: 38 test files and 622 tests passed after the FILE
  routing regression was added; package typecheck and build passed.
- `packages/examples/code`: 89 tests passed across 28 files; typecheck and
  packaged `index.js`/`acp.js` build passed.
- Focused regression coverage proves planner-visible exact-workdir locking,
  top-level pre-task trace reservation, trace/session correlation, detached
  trajectory ingestion, immediate deterministic durable ownership, secret
  redaction, source-content exclusion, and exact FILE/SHELL completion evidence.

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

The final 2026-08-20 release run at
`cbb6da285f8f983dbc16379fe2998c762704939e` passed all three scenarios. Both
concurrent sessions were observed `busy`, their execution windows overlapped,
every independent fixture test returned one pass and zero failures, every
read-only workspace was unchanged, and all three lifecycle sequences reached
`done`, `archived`, then `active` after reopen. The sanitized local report is
`work/qa-artifacts/owned-parent-final-20260820-cbb6da2/owned-parent-2026-08-20T19-23-40-914Z-51341/report.json`.

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

### Normal-person browser coding acceptance

The same isolated browser Eliza runtime was then exercised with ordinary chat
requests against a disposable Git fixture. These were not direct shell commands
from the QA driver: each request went through the app UI, parent response
handler, model planner, real FILE/SHELL actions, and persisted trajectory.

| Request                                                | Runtime path                                 | Independent result                                                    | Trajectory time | Verdict                |
| ------------------------------------------------------ | -------------------------------------------- | --------------------------------------------------------------------- | --------------: | ---------------------- |
| Change `milk` to `oat milk` and leave the rest alone   | FILE read -> FILE edit -> REPLY              | Git diff changed exactly line 2; `bread` and `bananas` unchanged      |          70.2 s | Pass after routing fix |
| Make `prime_checker.py` and try 29 and 30              | FILE write -> SHELL run -> REPLY             | `29 is prime`; `30 is not prime`; independent 1/2 checks also correct |          76.1 s | Pass                   |
| Fix `temperature.py` so 212 F becomes 100 C and run it | FILE read -> FILE edit -> SHELL run -> REPLY | One formula change, independent run printed `100.0`                   |          81.1 s | Pass                   |
| Ask a "coding helper" to make and run `hello.py`       | Parent FILE write -> SHELL run -> REPLY      | Independent run printed `Hello, world.`                               |          62.0 s | Pass, handled inline   |

The last task intentionally shows routing policy: a trivial two-operation job
stayed in the parent runtime instead of paying the overhead of a sub-agent. The
dedicated live matrix above separately proves the full parent -> orchestrator ->
packaged eliza-code child path, including concurrent children and durable
lifecycle transitions.

The local-only `work/qa-artifacts/normie-coding-qa-20260820` bundle contains
four clean UI captures plus the fixture diffs/files. The corresponding saved
runtime trajectories are `tj-893f281f56b99c`, `tj-8ada53325b7132`,
`tj-8ccb7336aab84a`, and `tj-8eb677a191c1d2`. The original broken run remains
available as `tj-830fad609544a3` so the regression is auditable rather than
hidden.

## Reproduce

Install and run the deterministic gates from the repository root:

```bash
bun install
bun run --cwd plugins/plugin-agent-orchestrator test
bun run --cwd plugins/plugin-agent-orchestrator typecheck
bun run --cwd plugins/plugin-agent-orchestrator lint:check
bun run --cwd plugins/plugin-agent-orchestrator build
bun run --cwd plugins/plugin-coding-tools test
bun run --cwd plugins/plugin-coding-tools typecheck
bun run --cwd plugins/plugin-coding-tools build
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
- The QA model/provider dominated latency: filesystem and shell actions usually
  completed in under one second, while individual model planning stages took
  roughly 5-40 seconds. A faster configured model/provider should improve the
  interaction without changing the owned runtime architecture, but that is not
  claimed here without a separate live run.
- The first absolute-path browser run failed its UX acceptance even though its
  edit landed. Only the post-fix rerun counts as the grocery-list pass.
- The first post-browser exact-head parent/orchestrator rerun also failed its
  acceptance: the child spawned, but durable ownership stalled behind optional
  model refinement. Only the deterministic-criteria rerun at `cbb6da285f` counts
  as the final full-lifecycle pass.
- The headless live harness deliberately has no connector send handler because
  browser QA owns visible asynchronous delivery. It can log a missing send
  handler and provider/router cancellation during intentional runtime shutdown,
  after the report has been retained. Those messages are teardown noise, not a
  successful UI-delivery claim; the separate browser captures are that proof.
- The root macOS SourceKitten/native-gateway verifier remains a host toolchain
  concern and is not evidence against this JavaScript/ACP coding path.

## VPS handoff

Fetch the dedicated `codex/coding-runtime-ship-20260820` branch, inspect the
reported delivery commit, install dependencies, and run the deterministic
commands above. Use a private environment-secret mechanism for a live OpenRouter
rerun. Do not copy a credential, local state directory, PGlite database, or
unsanitized trajectory directory from the QA host.

The exact pushed delivery commit is reported by the handoff message and can be
confirmed after checkout with `git rev-parse HEAD`.
