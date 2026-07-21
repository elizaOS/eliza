# Smithers observability pilot, Phase 1

**Issue:** elizaOS/eliza#16632  
**Date:** 2026-07-18  
**Lane:** `[sol-orch]`  
**Base:** `develop` at `f749cbccfcd`

## Scope delivered

This is an observability-only sidecar for one existing issue-to-validated-PR chain. It does not change `OrchestratorTaskService`, ACP, lane planning, scheduling, verification, trajectories, scenario infrastructure, or any code-agent execution policy.

The new `runSmithersObservabilityMacro` API records these durable Smithers nodes in order:

1. `issue-intake`
2. `branch`
3. `implement`
4. `test`
5. `pr`
6. `ci-verdict`

Every callback receives and persists:

- `smithersRunId`
- `smithersNodeId`
- `smithersAttempt`
- existing `elizaTaskId`
- existing `trajectoryId`, when present

The callback contract is observation-only. It returns a summary and string references to work that existing Eliza/GitHub services already performed. The macro cannot create a branch, run an agent, create or merge a PR, or decide whether CI passed. In particular, PR creation and merge remain outside replayable Smithers segments.

## Durability and watchability

The run uses Smithers' native builder and SQLite store at `.smithers/smithers.db`. Smithers therefore owns the ordered `_smithers_events` stream, node attempts, rendered `_smithers_frames`, outputs, and resume behavior. Re-invoking the adapter with the same run ID skips completed nodes.

The result exposes Smithers-native operator commands:

```text
bunx smithers-orchestrator monitor <run-id>
bunx smithers-orchestrator inspect <run-id>
bunx smithers-orchestrator events <run-id> --json
```

The first command opens the live Gateway monitor. The latter two inspect/replay the completed run after the fact.

## Dependency upgrade and compatibility review

- Both direct consumers were upgraded from `smithers-orchestrator@0.26.1` to npm-latest `0.28.0`.
- Upstream tags include `v0.29.0`, but `smithers-orchestrator@0.29.0` is not published to npm as of this receipt. `npm view smithers-orchestrator version` returns `0.28.0`, and requesting `0.29.0` returns `E404`. This PR does not pin an unpublished git artifact.
- Reviewed upstream `CHANGELOG.md` and the `v0.26.1...v0.28.0` diff. The legacy builder methods Eliza uses, `workflow`, `step`, `sequence`, `parallel`, `loop`, `from`, `execute`, plus `sqlite`, `postgres`, and `pglite`, remain available.
- The 0.27 line upgraded Smithers' agent facade to AI SDK 7 and `@ai-sdk/*` v4. Eliza intentionally pins older AI SDK provider packages for cloud compatibility. Importing the all-in-one facade therefore fails under Eliza's root overrides. The two adapters now import the supported builder directly from `@smithers-orchestrator/engine@0.28.0`, avoiding eager loading of unused Smithers agent adapters. This is the only compatibility adaptation and leaves execution semantics unchanged.
- Corrected stale `0.22.0` references in the benchmark integration guide, workflow plugin guide, and builder backend comments.

## Verification

Executed after building local `@elizaos/core` and `@elizaos/shared` workspace packages:

```text
plugin-agent-orchestrator focused Smithers suite: 5 files, 39 tests passed
plugin-workflow focused Smithers suite: 2 files, 15 tests passed
plugin-agent-orchestrator typecheck: passed
plugin-workflow typecheck: passed
Biome check of changed TypeScript: passed
```

The new lifecycle tests prove:

- all six phases execute and persist in order
- run/node/attempt IDs correlate with task and trajectory IDs
- a completed run resumes without repeating observed phases
- the store is a real Smithers SQLite database
- native monitor, inspect, and event replay commands are surfaced

## Demonstration run

The pilot observed its own real delivery chain after PR creation, so the replayable segment contained no GitHub write.

```text
run:        smithers-p1-16638
issue:      elizaOS/eliza#16632
branch:     sol/smithers-pilot-p1
commit:     12ea078b758
PR:         https://github.com/elizaOS/eliza/pull/16638
Eliza task: issue-16632-phase-1
trajectory: sol-orch:3e36e822-4d96-4236-b4a2-9a8b4980a8e1
CI verdict: Develop PR Gate success
```

Live watch proof was captured while `ci-verdict` was in progress:

```text
run:
  id: smithers-p1-16638
  workflow: eliza-issue-to-validated-pr
  status: running
runState:
  state: running
steps[6]{id,state,attempt,label}:
  branch,finished,1,branch
  ci-verdict,in-progress,1,ci-verdict
  implement,finished,1,implement
  issue-intake,finished,1,issue-intake
  pr,finished,1,pr
  test,finished,1,test
```

After CI, native `inspect` replayed the completed frame projection:

```text
run:
  id: smithers-p1-16638
  workflow: eliza-issue-to-validated-pr
  status: finished
  started: "2026-07-18T23:04:54.989Z"
  finished: "2026-07-18T23:05:02.204Z"
runState:
  state: succeeded
steps[6]{id,state,attempt,label}:
  branch,finished,1,branch
  ci-verdict,finished,1,ci-verdict
  implement,finished,1,implement
  issue-intake,finished,1,issue-intake
  pr,finished,1,pr
  test,finished,1,test
```

The durable phase output for every node carried the same task and trajectory correlation. Example:

```json
{
  "phase": "ci-verdict",
  "correlation": {
    "smithersRunId": "smithers-p1-16638",
    "smithersNodeId": "ci-verdict",
    "smithersAttempt": 1,
    "elizaTaskId": "issue-16632-phase-1",
    "trajectoryId": "sol-orch:3e36e822-4d96-4236-b4a2-9a8b4980a8e1"
  },
  "evidence": {
    "references": {
      "commit": "12ea078b758",
      "verdict": "Develop PR Gate success"
    }
  }
}
```

The native event replay returned 20 ordered JSONL records. The opening records were `RunStarted` at sequence 0, six `NodePending` records for the named phases, then `NodeStarted` with `attempt: 1`; the stream closed with the six node completions and terminal run completion. It is replayable from the disposable native store with `bunx smithers-orchestrator events smithers-p1-16638 --json`. The PR gate was green. The separate `claude-review` check had an `is_error:true` action-infrastructure failure with no review comments; it was not a code/test verdict and is called out rather than represented as green.

## Explicit non-goals held

- No `OrchestratorTaskService` semantic changes
- No ACP or account-routing changes
- No lane planning, verification, scheduling, or trajectory restructuring
- No scenario infrastructure changes
- No fork, rewind, or JJ integration
- No PR creation or merge inside replayable segments
- No removal of the legacy one-turn bridge in Phase 1

[sol-orch]

Co-authored-by: wakesync <shadow@shad0w.xyz>
