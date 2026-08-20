# Owned coding runtime: architecture, QA, and handoff

Date: 2026-08-20

## Ship decision

Eliza's first-party coding path is the implementation being shipped. OpenCode
and pi-agent were not copied into the runtime. They remain useful references or
explicit optional ACP backends, but neither is required for the owned path.

Correctness is release-ready only after both the normal-person browser
regression and the exact-head parent/orchestrator matrix below. The pushed
handoff identifies the final exact commit and its retained clean-start/clean-end
report. The earlier OpenRouter/Qwen diagnostic remains historical evidence
only; it is not the ship configuration. Current acceptance uses direct Cerebras
with `gemma-4-31b`, through Eliza's protected provider-account store rather than
a long-lived plaintext environment variable.

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

Normal chat and delegated coding now share one explicit workspace contract.
`ELIZA_WORKSPACE_DIR`, `ELIZA_CODING_WORKSPACE`, and
`ELIZA_CODING_DIRECTORY` identify a concrete user workspace and are used
verbatim. `ELIZA_ACP_WORKSPACE_ROOT` and `ACPX_DEFAULT_CWD` identify shared ACP
scratch roots and remain isolated per session. This distinction matters at
shutdown: ACP may safely remove a scratch child directory, but must never remove
a requested deliverable from the user's real workspace.

The coding-tools session cwd and shell default follow the same precedence. When
no explicit workspace is supplied, a sole `CODING_TOOLS_WORKSPACE_ROOTS` entry
is the deterministic fallback. Relative FILE list/search/glob operations resolve
against that session cwd, so ordinary requests such as "fix temperature.py"
behave the same as absolute-path requests without a prompt-specific special
case.

### Requested mutations and completion cleanup

The completion residual gate now distinguishes a requested workspace mutation
from accidental leftover dirt. A coding goal with create/write/edit/fix-style
intent records `workspaceMutationExpected: true`; its newly requested file is
delivery evidence, not an `uncommitted_changes` failure. Read-only tasks retain
the strict clean-workspace gate. Explicit negative clauses such as "do not
create files", "never edit or write files", and "make no changes" do not count
as mutation intent; a real edit in a separate clause still does.

Automatic validation keeps a completed ACP child alive until evidence is
checked. The only retried delivery race is the explicit transient
`ACP session is already busy` response, with a small bounded retry; unrelated
errors still fail immediately. After validation, the child is stopped while the
concrete workspace and its deliverables remain intact.

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

A later exact-head rerun exposed a second ownership path: a parent planner may
legitimately supply a nonempty `taskRoomId`, but the action treated that routing
choice as proof that the child was already owned by another coding task. The
child performed the requested FILE/SHELL work, yet no durable row was created
and the strict lookup timed out. Ownership classification now uses explicit
sub-agent provenance (`source` / `metadata.subAgent`), not room routing. A
top-level spawn with an explicit task room is regression-tested to create and
attach exactly one durable task.

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

- `plugin-agent-orchestrator`: 252 test files passed, 7 skipped; 2,954 tests
  passed, 11 skipped. Package typecheck, build, and Biome checks passed.
- `plugin-coding-tools`: 39 test files and 644 tests passed; package typecheck,
  build, and Biome checks passed.
- `packages/examples/code`: 95 tests passed across 29 files; typecheck and
  packaged `index.js`/`acp.js` build passed.
- `packages/core`: the 140 focused message-routing and planner-loop regressions
  passed; package typecheck and Node build passed. The package Biome gate passed
  with seven pre-existing warnings outside this change.
- Focused regression coverage proves planner-visible exact-workdir locking,
  top-level pre-task trace reservation, trace/session correlation, detached
  trajectory ingestion, immediate deterministic durable ownership, secret
  redaction, source-content exclusion, and exact FILE/SHELL completion evidence.

### Real parent and concurrent child acceptance

Run `e2e:owned-parent-orchestrator-live` with a private Cerebras credential. It
builds every required package and uses the real direct-Cerebras parent and child
runtimes with `gemma-4-31b` by default.

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

The 2026-08-20 diagnostic pass at
`cbb6da285f8f983dbc16379fe2998c762704939e` passed all three scenarios. Both
concurrent sessions were observed `busy`, their execution windows overlapped,
every independent fixture test returned one pass and zero failures, every
read-only workspace was unchanged, and all three lifecycle sequences reached
`done`, `archived`, then `active` after reopen. Its sanitized local report is
`work/qa-artifacts/owned-parent-final-20260820-cbb6da2/owned-parent-2026-08-20T19-23-40-914Z-51341/report.json`.

The final post-fix exact-head rerun for this handoff is retained under
`work/qa-artifacts/owned-parent-cerebras-final-20260820/`. Its `report.json`
records the exact source head, clean-start/clean-end checks, parent-selected
delegation, concurrent child overlap, lifecycle transitions, independent test
results, and sanitized provider/model/tool evidence.

An exact-head repetition then caught the `taskRoomId` ownership bug above and is
recorded as a failed acceptance, despite the child itself completing the fixture
work. The pushed handoff names the later post-fix report that counts as the
release gate; a one-off green run is deliberately not treated as flawless proof.

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

The final isolated browser acceptance used UI `2638`, API `32637`, the real
Eliza parent runtime, native ACP transport, the packaged `dist/acp.js` child,
and the protected `cerebras-api` account. No raw Cerebras/OpenAI/OpenRouter key
was present in the restarted parent process. The account metadata reported
`hasCredential: true`, `health: ok`, selection reason `only-eligible`, and a
fresh provider test returned HTTP 200 in 147 ms.

Two ordinary user requests form the release-facing proof:

| User request | Observed runtime path | Independent proof | Trajectory | Verdict |
| --- | --- | --- | --- | --- |
| `temperature.py gives the wrong answer. Fix it so 212 F becomes 100 C, then run it to check.` | Parent FILE/SHELL coding loop | `python3 temperature.py` printed `100.0`; one formula change | `tj-4e03e12b512d9f`, 4.816 s, 2 planner iterations, 1 successful SHELL, 0 failures | Pass |
| `Use a coding sub-agent to create hello_agent_persisted.py, make it print Hello from coding agent, run it, and tell me the exact output.` | Parent `spawn_agent` -> durable orchestrator task -> native packaged eliza-code child -> FILE/SHELL -> LLM verifier -> stop | File remained in the base workspace after child stop; independent Python run printed `Hello from coding agent` | `tj-569474eaf34364`, 5.584 s, 2 planner iterations, 2 successful tools, 0 failures | Pass |

The delegated proof is task `5b8ac18d-bf1f-4951-80e0-4dd366d131eb`, session
`9ddf38df-b2ca-4396-9b5d-7182b8949a42`. The durable task reached `done`; the
session then reached `stopped`; `spawnPath` is `spawn_agent`;
`workspaceMutationExpected` is true; completion residuals are clean; all three
script-specific acceptance criteria passed; and the child trajectory records
`provider=cerebras`, `modelName=gemma-4-31b` for every model stage. The visible
notification included the exact output, and the chat contained no provisional
failure note.

Two failed runs are intentionally retained as regression evidence. The first
used a stale source-checkout cwd. The second produced a correct child result in
an isolated `task-*` directory that ACP deleted at stop; it therefore did not
count as delivery. That failure directly motivated the active-workspace versus
scratch-root contract above.

### Historical normal-person browser coding diagnostic

The earlier OpenRouter/Qwen browser runtime was exercised with ordinary chat
requests against a disposable Git fixture. These were not direct shell commands
from the QA driver: each request went through the app UI, parent response
handler, model planner, real FILE/SHELL actions, and persisted trajectory. The
tool results remain useful regression evidence, but these runs are historical
diagnostics rather than the current Cerebras/Gemma release gate.

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

### Provider correction and simple-turn latency audit

The user's plain `hey` turn on the historical runtime took 5.587 seconds from
the persisted user message to the persisted assistant reply. Its saved
trajectory reported 3.474 seconds inside the Qwen model call, but the trajectory
did not begin until 2.033 seconds after ingress. It also showed 6,481 prompt
tokens, 148 completion tokens, zero cache hits, no planner/tool stages, and a
22,214-character composed prompt. The largest avoidable contributors were an
unrelated 2,989-character widget guide, an over-detailed compact context
catalog, a 2,888-character current-turn boundary, the full thread-operations
field description, and a known-dead embedding provider chain retried on the
turn.

The current delta fixes those causes without branching on greeting text:

- `eliza-code` has a first-class `cerebras` provider selection, requires
  `CEREBRAS_API_KEY` for that selection, preserves explicit non-Cerebras
  choices, reports the real Gemma model in the status bar, and does not copy the
  secret into `OPENAI_API_KEY`.
- Both owned live harnesses require direct Cerebras, default to
  `gemma-4-31b`, remove stale OpenAI/OpenRouter/OpenCode launch variables, and
  fail closed when the Cerebras credential is absent.
- Stage 1 still performs the normal structured simple-versus-actions decision.
  The widget guide is selected only for matching routed contexts, compact
  context lines omit redundant UI/access/cache metadata, and the
  current-turn/thread-operation instructions retain their routing invariants in
  compressed form.
- Recall embedding skips a provider chain the runtime dimension probe has
  already disabled; the existing deferred recovery probe remains responsible
  for clearing that state.
- File trajectories now begin at the trusted server-side `MessageService`
  ingress timestamp, so compose, evaluator, and pre-model work is included in
  end-to-end duration instead of disappearing before the first recorded stage.
- Evaluator-owned replacement candidates remain exclusive after Stage 1;
  generic text retrieval cannot re-add an action that the evaluator explicitly
  cleared.

The provider and prompt work remains covered by the focused transport,
configuration, status, evaluator, and trajectory tests described above. The
fresh browser proof confirms that the protected account resolves at runtime and
that both parent and child model stages are Cerebras Gemma, not Qwen/OpenRouter.

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
export CEREBRAS_API_KEY='<private Cerebras key>'
export ELIZA_LIVE_QA_MODEL='gemma-4-31b'
export ELIZA_LIVE_QA_REPORT_DIR='/private/safe/report/directory'
bun run --cwd packages/examples/code e2e:owned-parent-orchestrator-live
unset CEREBRAS_API_KEY
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
- The first post-browser exact-head parent/orchestrator rerun failed its
  acceptance because durable ownership stalled behind optional model refinement.
  A later run passed, and then an exact repetition exposed a separate
  room-routing/provenance ownership bug. Only the post-provenance-fix exact-head
  report named in the handoff counts as the final full-lifecycle pass.
- The headless live harness deliberately has no connector send handler because
  browser QA owns visible asynchronous delivery. It can log a missing send
  handler and provider/router cancellation during intentional runtime shutdown,
  after the report has been retained. Those messages are teardown noise, not a
  successful UI-delivery claim; the separate browser captures are that proof.
- The root macOS SourceKitten/native-gateway verifier remains a host toolchain
  concern and is not evidence against this JavaScript/ACP coding path.

## AgentNet rendering review and deferred plan

AgentNet was reviewed as a UI reference only; no AgentNet code was copied and it
is not a runtime dependency. Its strongest reusable design ideas are small,
role-specific message components and a normalized tool-event presentation:

- a compact tool card with tool glyph/name, command or file, bounded output,
  and an explicit success/exit-code badge;
- inline diffs with added/removed color bands, line numbers, per-file tabs, and
  a collapsed `+adds/-deletes across N files` summary;
- assistant footer metadata for model and duration;
- separate visual states for pending user messages, thinking, compacted-context
  summaries, approvals, and completed tool events;
- memoized immutable message rows so streaming updates replace only the tail
  message instead of re-rendering the entire transcript.

The recommended later Eliza UI project is to map existing trajectory/action
receipts into one first-party `ToolEventViewModel`, render FILE/SHELL/sub-agent
events as collapsible cards inside the existing canonical chat overlay, and add
diff/exit-code/duration details behind disclosure. Keep the normal assistant
answer concise and human-readable; do not paste raw trajectory JSON into chat.
This should be implemented and browser-tested as a separate UI change after the
runtime checkpoint, rather than mixing borrowed presentation code into the
runtime correctness patch.

## VPS handoff

Fetch the dedicated `codex/coding-runtime-ship-20260820` branch, inspect the
reported delivery commit, install dependencies, and run the deterministic
commands above. Use a private environment-secret mechanism for a live Cerebras
rerun. Do not copy a credential, local state directory, PGlite database, or
unsanitized trajectory directory from the QA host.

The exact pushed delivery commit is reported by the handoff message and can be
confirmed after checkout with `git rev-parse HEAD`.
