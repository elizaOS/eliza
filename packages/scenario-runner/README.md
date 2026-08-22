# @elizaos/scenario-runner

End-to-end scenario runner for elizaOS agents. Loads `.scenario.ts` files, executes them against a real `AgentRuntime`, and reports pass/fail with per-turn assertion detail.

## What it is

The scenario runner is the integration-testing harness for elizaOS plugins and agent behaviour. Unlike unit tests that mock the runtime, it boots a real `AgentRuntime` backed by PGLite (an in-process Postgres) and drives it through scripted conversation turns. It is used by `packages/test/scenarios/` and by individual plugin test suites.

## Quick start

```bash
# run a single scenario directory with a live LLM provider key
OPENAI_API_KEY=sk-... eliza-scenarios run ./test/scenarios --scenario my-scenario-id

# deterministic mode — no model key required, uses the fixture-backed model provider
SCENARIO_USE_DETERMINISTIC_MODEL=1 eliza-scenarios run ./test/scenarios

# list discovered scenarios without running them
eliza-scenarios list ./test/scenarios
```

## Writing a scenario

Create a `<name>.scenario.ts` file and export a `ScenarioDefinition`:

```ts
import type { ScenarioDefinition } from "@elizaos/scenario-runner/schema";

export default {
  id: "greet-happy-path",
  title: "Greeting: happy path",
  domain: "greet",
  tags: ["deterministic"],
  turns: [
    {
      name: "user says hello",
      kind: "message",
      text: "Hello",
      assertResponse(text) {
        if (!text.toLowerCase().includes("hello")) {
          return "expected a greeting in the response";
        }
      },
    },
  ],
  finalChecks: [
    { type: "actionCalled", name: "REPLY called", actionName: "REPLY", minCount: 1 },
  ],
} satisfies ScenarioDefinition;
```

### Turn kinds

| Kind | What it does |
|---|---|
| `message` | Sends text through `runtime.messageService.handleMessage` (full conversational path) |
| `action` | Calls a runtime-registered action's `validate` + `handler` directly; `expectedValidation: "rejected"` proves an invalid input is refused without invoking the handler |
| `api` | Makes an HTTP request to the agent's registered routes via a loopback server |
| `tick` | Invokes the lifeops scheduler at a logical clock time |
| `wait` | Waits for `durationMs`, or polls a bounded `until(ctx)` state predicate |

### Assertions

**Per-turn:**
- `assertResponse(text | status, body)` — return a non-empty string to fail
- `assertTurn(execution)` — inspect the full `ScenarioTurnExecution`
- `responseIncludesAny: string[]` — response must contain at least one
- `forbiddenActions: string[]` — scenario fails if any of these actions fire
- `responseJudge: { rubric, minimumScore }` — LLM-as-judge scoring

**Final checks** (after all turns, in `finalChecks` array):
`actionCalled`, `selectedAction`, `judgeRubric`, `connectorDispatchOccurred`, `memoryWriteOccurred`, `approvalRequestExists`, `browserTaskCompleted`, `messageDelivered`, and more — see `schema/index.js` for the full list.

## CLI flags

```
eliza-scenarios run  <dir>
  --report <path>          Write JSON aggregate report
  --report-dir <dir>       Write report bundle to directory
  --run-dir <dir>          Store per-turn trajectories here
  --export-native <path>   Export trajectory JSONL for training corpus
  --runId <id>             Override the auto-generated run UUID
  --scenario id1,id2       Filter to specific scenario IDs
  --provider <name>        Pin the live provider: groq, openai, anthropic,
                           google, openrouter, or cli
  [fileGlob ...]           Filter by file glob pattern
```

## Provider-qualified release evidence

The ordinary executor is an in-process diagnostic harness. It can exercise a
real model and real plugin code, but it creates scenario identities and invokes
the runtime directly, so it is never a trustworthy provider-evidence boundary.
Declaring `executionProfile: "provider-qualified"` does not relabel that path:
the executor fails closed, mixed-profile or multi-scenario runs are rejected,
and the CLI returns nonzero and withholds native export unless exactly one
report carries independently verified, publishable qualification.

An out-of-process controller can use the public primitives under
`src/provider-qualified/` to:

1. build a closed, content-hashed run manifest bound to deployment, principal,
   room, every connector account/capability, and the exact required
   observations;
2. drive authenticated production ingress while independent observers collect
   provider, durable-database, and scheduler evidence;
3. recompute exact trajectory and stage hashes from a fresh isolated run
   directory; and
4. derive qualification from a pinned Ed25519 observer signature, exact
   observation/result multisets, independent semantic verdicts, provider
   acceptance, and required readback/idempotency.

The qualifier always records `exactlyOnce: false`; provider idempotency and
readback reduce ambiguity but do not prove end-to-end exactly-once delivery.
Action results, model prose, loopback fixtures, local PGlite, and unsigned
same-process observations cannot satisfy these contracts.

## Key env vars

| Variable | Effect |
|---|---|
| `SCENARIO_USE_DETERMINISTIC_MODEL=1` | Use the deterministic fixture-based model provider (no API key needed) |
| `LIFEOPS_LIVE_JUDGE_MIN_SCORE` | Minimum judge score threshold (default: `0.8`) |
| `SKIP_REASON` | Set to allow intentional scenario skips without exit code 2 |
| `SCENARIO_INCLUDE_PENDING` | `1` = include `status: "pending"` scenarios |
| `ELIZA_BENCH_SKIP_EMBEDDING` | Simulated runs default to no embedding provider; set to `0` for real local-inference embeddings |
| `ELIZA_TRAJECTORY_LOGGING` | The `run` command sets this to `1` when the operator has not already set it, so scenario trajectories are recorded even under `NODE_ENV=test` or `NODE_ENV=production`; explicit `0` and `ELIZA_DISABLE_TRAJECTORY_LOGGING=1` are respected |
| `ELIZA_TRAJECTORY_DIR` | Set automatically when `--run-dir` or `--export-native` creates an effective run directory; otherwise the recorder falls back to the state-dir trajectories path |

Any one of `GROQ_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, or `OPENROUTER_API_KEY` satisfies the live-provider requirement when deterministic mode is disabled.

## Production manifest persistence

`applyProductionManifest` seeds the scenario runtime through the same
`AgentRuntime` repository methods used in production. Version 1 supports
world-scoped entities, rooms and participants, message and non-message memory
partitions, relationships, tasks, scheduled items, notifications, pending
`execute_workflow` approvals, and provider cache state. Each domain is written
and removed through its production owner; the manifest does not maintain a
parallel mutable world store.

Every apply returns a JSON-serializable receipt containing the exact created
identifiers. `readProductionManifestSnapshot` projects canonical state back
from the authoritative stores, while `resetProductionManifest` accepts that
receipt in a later process, strictly reparses its keys, hashes, UUID sets, and
participant containment, and requires its canonical hash to match the
finalized receipt hash in authoritative world metadata before public read or
reset. Each receipt carries a fresh generation fence. Reset then verifies
namespace and generation ownership, persists an exact receipt-hash-bound
`resetting` control record, deletes through the production boundaries, and
proves absence before persisting `complete`. A retry after an ambiguous process
exit resumes only that authorized generation, while a clean replay returns the
same absence artifact; a never-issued or stale-generation receipt is rejected.
Manifest input is
admitted only as bounded, plain JSON data and recursively validated as lossless
JSON before any write. Logical entity, relationship, and earlier-task
references inside schedules are materialized to production IDs, then
canonicalized back to logical IDs on readback. `proveProductionManifestReset`
captures initial/readback/reset/reseed artifacts and requires byte-equivalent
canonical snapshots.

Receipts include the exact schedule, notification, approval, memory-partition,
and provider-state ownership needed for restart-safe cleanup. Apply discovers
idempotent production rows after post-commit failures and compensates them;
notification enumeration used for cleanup includes expired rows. Approval
seeding awaits its durable notification projection, so no background write can
escape receipt finalization. The manifest generation fences deterministic rows
and reset authority across processes; exclusive multi-host scheduling and
virtual-clock authority remain controller-level composition dependencies.

## Strict model fixtures

Deterministic scenarios can declare a serializable `modelFixtures` manifest on
the scenario definition. Each fixture names an exact model type plus optional
input, prompt, tool-set, and response-schema matchers; its response may contain
text, JSON, or tool calls. Cardinality defaults to exactly once. Ranges, latency,
SSE chunking, declared errors, and wait-for-cancellation behavior are explicit.

The runner begins a fresh registry scope for every scenario attempt and records
only prompt/schema fingerprints, lengths, fixture names, matching reasons, and
consumption counts in `ScenarioReport.modelFixtureDiagnostics`. Unmatched,
ambiguous, over-consumed, and unused required fixtures fail the attempt. There
is no fallback for a declared manifest. Direct action/API scenarios that never
enter a model path may instead declare
`modelFixtures: { mode: "model-free", reason: "..." }`; message, voice, tick,
or judge work makes that declaration invalid. Wait turns are also model-free.

Before final fixture validation, the executor waits a bounded interval for
tracked post-delivery work and requests cancellation through each task's
`AbortSignal`. A task that ignores cancellation leaves its runtime quarantined:
the attempt fails and every later scenario is refused before its fixture scope
or world can start. JavaScript cannot terminate arbitrary code that ignores an
abort signal, so subprocess/generation isolation must end that container before
the runtime can be replaced; quarantine is containment, not a claim that the
task was killed.

The rollout is staged: undeclared scenarios temporarily retain the legacy
resolver and reports mark them `legacy-fallback`; declared attempts report
`strict-fixtures` or `model-free`. The migration ratchet currently records 48
strict or explicitly model-free and 72 legacy `pr-deterministic` scenario
sources across the repository. The declared rows contain only direct action/API work or
wait/seed/final checks and are validated again by the real executor before each
attempt. The legacy count may only decrease, and the epic is complete only when
it reaches zero.

Reusable Stage-1/planner fixtures are exported by `@elizaos/core/testing` for
single tools, multiple tools, clarifications, terminal replies, evaluators,
scheduled rendering, and adversarial/malformed outputs.

## Programmatic use

```ts
import { createScenarioRuntime } from "./src/runtime-factory.ts";
import { runScenario }           from "@elizaos/scenario-runner";

const { runtime, providerName, cleanup } = await createScenarioRuntime();
const report = await runScenario(myScenario, runtime, {
  providerName,
  minJudgeScore: 0.8,
  turnTimeoutMs: 120_000,
});
await cleanup();
```

## Notes

- A simulated CLI invocation runs its scenarios in one shared runtime because PGLite cannot be recreated in-process. All declared plugins are registered before runtime initialization, preserving service availability for existing seeds. Test companions must scope dependency overrides and ledgers to the runtime, dispose them at shutdown, and declare a guaranteed cleanup assertion for exact completeness. The CLI rejects a shared batch that mixes the meetings test companion with production-only meetings scenarios; use process isolation for that selection. Provider-qualified definitions are restricted to one scenario and still require an external production controller; the ordinary executor deliberately refuses to qualify them.
- Schema types (`ScenarioDefinition`, `CapturedAction`, etc.) come from `@elizaos/scenario-runner/schema`, not from the main export.
- Scenarios starting with `_` or in directories starting with `_` are skipped by the loader.
