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
| `action` | Calls a named action's `validate` + `handler` directly (bypasses LLM routing) |
| `api` | Makes an HTTP request to the agent's registered routes via a loopback server |
| `tick` | Invokes the lifeops scheduler at a logical clock time |

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
or judge work makes that declaration invalid.

The rollout is staged: undeclared scenarios temporarily retain the legacy
resolver and reports mark them `legacy-fallback`; declared attempts report
`strict-fixtures` or `model-free`. The migration ratchet currently records 40
explicitly model-free and 79 legacy `pr-deterministic` scenario sources across
the repository. The declared rows contain only direct action/API work or
seed/final checks and are validated again by the real executor before each
attempt. The legacy count may only decrease, and the epic is complete only when
it reaches zero.

Reusable Stage-1/planner fixtures are exported by `@elizaos/core/testing` for
single tools, multiple tools, clarifications, terminal replies, evaluators,
scheduled rendering, and adversarial/malformed outputs.

## Production-boundary observation ledger

`observeProductionBoundary` wraps an existing connector, repository, service,
or use-case call and requires the caller to supply its authoritative readback.
It hashes sanitized request, response, and readback values into an append-only
JSONL receipt. An adapter response cannot be recorded as `succeeded` unless the
real call occurred, its acceptance was typed, its readback exists and matches,
and the caller's production-owned async generation fence admitted the attempt.
The fence must exclude reset/rollover for the complete invocation, readback,
and durable receipt append. If the generation is stale when that fence is
acquired, the boundary is not called.

The ledger is evidence, never desired or provider state. Fault directives are
injected at this consumer boundary and record timeout, retryable/permanent,
rate-limit, partial, ambiguous, and stale-completion outcomes without inventing
successful effects. Its public surface is read-only; only the observer holds
the module-private append capability. Records use strict schema validation and
a SHA-256 chain, and each newline-framed append is synced before it resolves.
Malformed, edited, blank, or truncated frames fail closed rather than being
returned as evidence. The chain is tamper-evident, not signed proof.

`JsonlBoundaryObservationLedger` remains a single-writer primitive. #24076's
cross-process namespace lease must implement the generation-fence contract and
own reset/rollover exclusion; this module does not fabricate that authority or
claim exactly-once behavior for an external provider.

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

- A simulated CLI invocation runs its scenarios in one shared runtime because PGLite cannot be recreated in-process. Provider-qualified definitions are restricted to one scenario and still require an external production controller; the ordinary executor deliberately refuses to qualify them.
- Schema types (`ScenarioDefinition`, `CapturedAction`, etc.) come from `@elizaos/scenario-runner/schema`, not from the main export.
- Scenarios starting with `_` or in directories starting with `_` are skipped by the loader.
