# Owned coding runtime: architecture, QA, and handoff

Date: 2026-08-20

## Current local decision

Eliza's first-party coding path is the implementation being shipped. OpenCode
and pi-agent were not copied into the runtime. They remain useful references or
explicit optional ACP backends, but neither is required for the owned path.

This is a local candidate, not a flawless or published release. Per the latest
owner instruction, none of this coding-agent work is pushed. The final
exact-output behavior checkpoint is
`93d8d0a12dfb29f63e34dcc37b7c60c44d1bff32`; this document update is the only
newer working-tree change before the final local documentation checkpoint.

The earlier OpenRouter/Qwen diagnostic remains historical evidence only; it is
not the current configuration. Interactive browser acceptance uses Cerebras
`gemma-4-31b` through Eliza's protected provider-account store rather than a
long-lived plaintext environment variable. The clean headless matrix uses the
same provider/model through a single authorized process environment and retains
no credential material.

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

Completion-time evidence now follows the same race-safe rule in both owners of
the ACP `task_complete` event. If the durable task bridge wins the event race
before the router's live metadata write, it independently captures the same
baseline-scoped change set, verifies every changed path against the real
workdir, and stores both `lastChangeSet` and `lastArtifactVerification`. This
prevents a truthful new file from having a visible diff but a missing disk
verification record.

New untracked files produced by the nested Eliza FILE action are also captured
without scooping up unrelated pre-existing files. The spawn records the exact
untracked baseline; completion subtracts it and includes only newly introduced
paths. Legacy callers that do not have a baseline retain the conservative
no-scoop behavior.

### Clean completion projection and exact outputs

The child still emits a structured `CompletionEnvelope` for machine validation,
trajectory retention, and diagnostics. The user-facing relay now parses and
removes only a valid envelope, bounded tool transcript, proof footer, and
internal summary lines. Ordinary JSON that is not a valid envelope is preserved.
The coordinator therefore keeps verifier-grade evidence without dumping JSON,
absolute paths, or raw tool receipts into chat.

When the user explicitly asks for exact or verbatim output, the router records a
short, path-free child deliverable and relays that value unchanged after
verification. This is a generic output-fidelity contract, not a special case for
greetings or any tested phrase. Normal requests still use the parent's ordinary
natural-language completion path.

A live regression exposed an evaluator-ordering edge: generic routing could add
a stale `TASKS` candidate after the completion evaluator had cleared it, forcing
a second model pass that paraphrased the otherwise-correct child result. The
completion evaluator now runs after generic routing and authoritatively clears
candidate actions and parent hints before setting the captured reply. It does
not invoke `REPLY`: synthetic child-completion messages have the agent role, and
the existing user-only action gate correctly rejects that action. A focused
regression executes both evaluators in priority order and proves the final plan
contains the literal reply with no stale action candidate.

The residual gate now scopes unpushed commits to commits created after the
session's spawn baseline. A local branch that was already ahead when the child
started no longer makes every later child look unfinished, while a commit the
child creates after spawn is still reported as an `unpushed_commits` residual.

### Child prompt compaction

The packaged Eliza Code child previously injected the repository's roughly
10 KB root orchestration scaffold plus a second redundant system paragraph into
every model call. The exact scaffold is now represented by a compact coding
workspace manual while project-authored instructions remain verbatim. The
duplicate paragraph was removed.

The live prime-script retry kept the same two FILE/SHELL operations and exact
output while reducing prompt tokens from 32,634 to 24,987, a 23.4% reduction.
This is still larger than ideal, but it removes the avoidable child-side
duplication without weakening workdir, test, secret, or completion rules.

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

- `plugin-agent-orchestrator`: 252 test files passed, 7 skipped; 2,956 tests
  passed, 11 skipped. Package typecheck, build, and Biome checks passed.
- `plugin-coding-tools`: 39 test files and 644 tests passed; package typecheck,
  build, and Biome checks passed.
- `packages/examples/code`: 99 tests passed; typecheck and
  packaged `index.js`/`acp.js` build passed.
- `packages/core`: the 140 focused message-routing and planner-loop regressions
  passed; package typecheck and Node build passed. The package Biome gate passed
  with seven pre-existing warnings outside this change.
- Focused regression coverage proves planner-visible exact-workdir locking,
  top-level pre-task trace reservation, trace/session correlation, detached
  trajectory ingestion, immediate deterministic durable ownership, secret
  redaction, source-content exclusion, exact FILE/SHELL completion evidence,
  envelope-free chat projection, exact-output delivery, spawn-baseline residual
  attribution, new-untracked capture, and race-safe disk verification. The
  latest narrow orchestrator gate passed 383 tests across the eight directly
  affected files. The final relay-ordering change additionally passed 177 tests
  across its six completion/routing files, plus package typecheck, build, Biome,
  and `git diff --check`.

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

The final clean exact-head rerun is retained at
`work/qa-artifacts/owned-parent-cerebras-93d8d0a-20260820/owned-parent-2026-08-21T00-06-25-861Z-20755/report.json`.
It passed at local behavior checkpoint
`93d8d0a12dfb29f63e34dcc37b7c60c44d1bff32` with the repository clean at both
start and end. The natural parent selected delegation, both concurrent children
overlapped while running, all three independent fixture tests exited zero, all
three workspaces remained unchanged, and every task traversed
`done -> archived -> active`. The three child trajectory IDs are
`tj-a3cad357e3c475`, `tj-a3e00b0de7e4fd`, and `tj-a3e012fa3103da`.

The retained report bundle was scanned against the approved runtime credential
and contains no copy of it. Provider/model fields identify direct Cerebras
`gemma-4-31b`; no Qwen/OpenRouter model participated. This exact-head run covers
the newer relay, prompt, residual-attribution, new-file capture, and durable
artifact-verification changes in the behavior checkpoint.

An earlier exact-head repetition caught the `taskRoomId` ownership bug above and
is recorded as a failed acceptance, despite the child itself completing the
fixture work. The final clean report is the behavior checkpoint's lifecycle
evidence; a one-off green run is deliberately not described as proof of
flawlessness.

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
Native desktop behavior is not part of this coding-runtime acceptance. A later
accidental duplicate native launch from this worktree was terminated after it
collided with the intended integration host; none of its behavior counts as QA.

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

Four later browser/runtime probes exercise the repaired presentation and
evidence path against the same protected Cerebras account:

| Request | Nonsecret evidence | Verdict |
| --- | --- | --- |
| `What is 2 + 2? Answer in one short sentence.` | Visible response `It's 4.` in 1.192 s end to end; trajectory `tj-91d2c66fe42664` records `provider=cerebras`, `modelName=gemma-4-31b`, one simple response stage, no tools | Pass |
| Create and run a shopping-total script | Session `ca33a989-c4ed-4861-a391-52cdfa47bfa7`; trajectory `tj-80fddf59d5c682`; exact independent output `Total: $10.00`; two tools, zero failures | Pass |
| Create and run `visible_exact_result_v2.py`, return exact output | Task `aaec7dea-dfb1-4f7e-8a27-660586749449`; session `ef11f1a3-07b1-4404-bd44-13c706f7ebdd`; visible response exactly `Exact relay works`; clean residuals and passed validation | Pass |
| Create and run `visible_change_evidence_v3.py`, return exact output | Task `564a90b2-eac5-49e0-9628-15ddde828c7b`; session `036daa7a-6013-4c5c-8121-5e104947e440`; visible response exactly `Evidence path works`; one-file new-file diff and independent SHA-256 `72ea0ee3bb114958a51f6098481ea7011b03f19399251296b10ab4d3d63b7e87` | Pass |
| Create and run `final_literal_check_v2.py`, return exact output | Task `61e2a621-7a39-4c7d-910f-20db4b3c1859`; session `e67eed84-9482-48ba-a262-a518c68e96ae`; visible response exactly `Final literal relay works`; task `done`, child `stopped`, validation passed, residuals clean, filesystem artifact verified; child trajectory `tj-a1e636b25b9fd1`; parent completion trajectory `step-1787270655838-qllrvt` used direct reply with no planner tool stage; independent SHA-256 `a7fdb4e1b9d22dea30dc41d6293e685333e132959d564f545da4c01a7f1b0d6b` | Pass |

The `visible_*` and `final_literal_check_v2.py` scripts were QA artifacts and
were removed after their content, execution result, hash, task, session, change
set, and browser result were recorded. The retained chat history still shows
older failed probes above these clean results; it was deliberately not
rewritten.

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

### Eliza Code versus OpenCode normal-person comparison

Two agents were spawned concurrently through the same isolated Eliza runtime
and asked to do the same ordinary work. Eliza Code used its owned native ACP
child and first-party trajectory. OpenCode `1.18.18` used the same protected
Cerebras account selected through Eliza's account policy. No provider secret
was printed, persisted in a tracked file, or added to the runtime process
environment.

| Task | Eliza Code | OpenCode | Independent result |
| --- | --- | --- | --- |
| Create `prime_checker.py` and print primes from 2 through 30 | session `d34f0e5b-7d90-47de-8f78-ac1f1801bd5f`; stopped in about 6 s | session `70cbad2e-59ec-4f52-ba5e-8d43fd8fd63f`; stopped in about 6 s | Both printed exactly `2 3 5 7 11 13 17 19 23 29` |
| Edit the existing script to include 31, then run it | session `bb4b28b1-0fa5-4f86-bde8-67ad4ba24448`; stopped in about 7.6 s | session `3a963171-82e2-4746-a3ac-07a843832629`; stopped in about 13.6 s | Both printed exactly `2 3 5 7 11 13 17 19 23 29 31` |

The Eliza Code creation trace is `tj-673ce59a412ac4`: Cerebras
`gemma-4-31b`, two planner iterations, two successful tool calls, no failures,
and 2.929 s of model latency. It exposed the former 32,634-token prompt; the
post-compaction equivalent used 24,987 tokens and retained the exact result.
OpenCode was not more correct and was slower on the edit. Its raw ACP completion
was noisier, including tool-output payloads, JSON, and absolute paths. The
evidence supports keeping Eliza Code as the default and treating OpenCode as an
optional fallback/reference, not as a replacement that fixes the owned runtime.

Pi Agent was not tested because no Pi CLI is installed in the isolated runtime;
preflight reports `installed: false`, `authReady: false`, and `CLI not detected`.
Adding external software is intentionally deferred rather than changing the
candidate just to manufacture a comparison.

### API-only agent chat-relay regression

The first comparison exposed a serious UI bug: roomless direct API sessions
could synthesize completion messages into whichever chat happened to be active.
This made raw OpenCode/Eliza Code payloads and absolute paths appear in the
browser even though the user had not sent those requests in that conversation.
The messages were ephemeral and disappeared after reload, but the visible
behavior was still incorrect.

Roomless direct `/api/coding-agents/spawn` sessions now receive trusted
`suppressChatRelay: true` metadata, and the swarm coordinator does not synthesize
a chat completion for those sessions. A direct session with a validated origin
room remains relay-capable, so normal parent/delegated results are not muted.

The focused route/coordinator regressions passed 71 of 71 tests. The complete
orchestrator package then passed 2,956 tests with 11 skipped, plus typecheck,
build, Biome, and `git diff --check`. Live proof used roomless OpenCode session
`ac184024-e30b-44fd-864f-140489369025` to create and run `relay_guard.py` with
exact output `relay guard ok`. It stopped normally while the active
conversation remained at 23 messages before and after; browser DOM contained
neither the relay-guard text nor the earlier prime comparison payload.

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
- OpenCode and Pi Agent are not runtime dependencies of this ship candidate.
- The current chat still contains persisted history from earlier failed and
  misleading attempts. Those old messages were not deleted or rewritten, so
  the transcript does not look flawless even though the latest paths pass.
- The runtime's local fused embedding library is unavailable in this isolated
  environment. Memory rows persist, but vector embeddings are degraded. This is
  separate from the verified Cerebras chat/coding path and remains an open
  release concern.
- Eliza Code's compacted 24,987-token prime-script prompt is materially better
  than 32,634, but is still large enough to warrant later profiling before
  calling the coding UX polished.
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
- This lane is browser/headless only. It must never launch Electrobun or a native
  Eliza bundle and must never bind RPC 50000, 50001, or 50002. The accidental
  duplicate native launch described above is a process-isolation failure, not
  acceptance evidence.

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

## Test it yourself now

The isolated browser instance is available at `http://127.0.0.1:2638/chat` with
API `32637`. Suggested normal-person prompts are:

1. `Create a Python script named odds.py that prints the odd numbers from 1 through 15, then run it and tell me the exact output.`
2. `Use a coding sub-agent to edit odds.py so it prints through 21, run it, and tell me the exact output.`

An explicit OpenCode comparison can use: `Use OpenCode to create a Python script
named countdown.py that prints 5 through 1, run it, and tell me the exact
output.` Expect OpenCode to remain an optional backend rather than the default.

When testing, require a concise final answer, the exact command output, the file
persisting in the requested workspace, a stopped child session, and no raw JSON
or unrelated API-agent result appearing in the chat.

## Deferred VPS handoff

Do not fetch or deploy this branch yet: the latest changes are deliberately
local and have not been pushed. After the remaining UX issues are accepted and
a final clean exact-head matrix passes, the handoff should name one reviewed
commit. A VPS must use a private environment-secret mechanism for a live
Cerebras rerun and must not copy a credential, local state directory, PGlite
database, or unsanitized trajectory directory from the QA host.
