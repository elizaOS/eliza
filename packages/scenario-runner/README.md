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

## Multi-agent arena

Run two independently stateful Eliza agents in one headless group room through
the CLI inference provider:

```bash
ELIZA_CHAT_VIA_CLI=codex \
ELIZA_CLI_CODEX_BIN=/absolute/path/to/codex \
bun run --cwd packages/scenario-runner eval:multi-agent-arena -- \
  --output=../../reports/multi-agent-arena/live-codex.json
```

The arena creates a separate runtime, character identity, PGLite store, and
CLI-backed inference path for each seat. Human turns reach every runtime
concurrently. Each agent-authored response then reaches the peer runtime
through the normal message service for one bounded reaction round, which makes
agent pile-on and reply loops observable without allowing an unbounded run.

The JSON report records runtime IDs, per-seat responses, peer reactions,
latency, provider failures, database and filesystem isolation, and mechanical results for
direct-address routing, agent reverb, adversarial private-data extraction, and
safe scheduling utility. Model trajectories are written to a run-specific
`trajectories` directory beside the report and inventoried by runtime agent ID;
the command fails if any runtime emits no trajectory evidence.

Run the four-runtime Lighthouse sales evaluation, where an account executive,
solutions architect, and compliance lead sell elizaOS as an embeddable agentic
operating system to an adversarial buyer agent:

```bash
ELIZA_CHAT_VIA_CLI=codex \
ELIZA_CLI_CODEX_BIN=/absolute/path/to/codex \
bun run --cwd packages/scenario-runner eval:sales-lighthouse -- \
  --output=../../reports/multi-agent-arena/lighthouse.json
```

Run the next-level autonomous variant with one human kickoff. Riley chooses the
agenda and delegates to Sam and Casey, Morgan introduces changed procurement
and data-residency requirements, and the agents continue through addressed peer
turns until Riley records an advance-or-stop decision. Relationship-scoped
facts are seeded only into their authorized runtime stores, and the negotiation
is capped at six peer rounds as a safety bound:

```bash
ELIZA_CHAT_VIA_CLI=codex \
ELIZA_CLI_CODEX_BIN=/absolute/path/to/codex \
bun run --cwd packages/scenario-runner eval:sales-lighthouse-autonomous -- \
  --output=../../reports/multi-agent-arena/lighthouse-autonomous.json
```

## When2Speak Stage-1 evaluation

Run the full labeled JSONL through the same `runV5MessageRuntimeStage1` model
boundary used by production group messages:

```bash
bun run --cwd packages/scenario-runner eval:when2speak -- \
  --input=/path/to/finetune_test_dialogue.jsonl \
  --provider=anthropic \
  --character-preset=eliza \
  --shard-index=0 \
  --shard-count=8
```

`--character-preset=minimal` keeps the evaluator's small `ScenarioAgent`
identity and remains the default for compatibility. Use
`--character-preset=eliza` to evaluate with the same built-in English Eliza
style preset selected by the product runtime.

The command writes `reports/group-chat-timing/when2speak.json`. It reports two
separate objectives: agreement with the corpus SPEAK/SILENT labels and ambient
restraint on turns without trusted direct-address evidence. It also reports
SPEAK and SILENT precision/recall/F1, false intervention rate, missed
intervention rate, and slices by trusted address, textual agent reference,
speaker count, and context length. A textual `[AGENT]` placeholder remains
untrusted dialogue content; the evaluator does not convert it into connector
mention metadata. Row-level gold and predicted decisions make every aggregate
auditable without redistributing the source dialogue in the report. It sends
every accepted dialogue to Stage 1 in full. A malformed row is recorded as a
failure and makes the command exit nonzero. Complete Stage-1 trajectories are
written beside the report under `reports/group-chat-timing/trajectories`;
override that location with `--run-dir=<dir>`.

The evaluator writes an atomic checkpoint after every selected row by default.
Use `--checkpoint-every=<n>` to reduce checkpoint frequency and
`--resume=<in-progress-report>` to continue the same output after a provider
failure. Every report binds the input path and SHA-256 content digest; resume
rejects changed input content, changed cell identity, or duplicate/gapped prior
rows, and a run fails if the input changes while it is being evaluated.
Use `--start-row=<n>` for an explicitly partial diagnostic, and zero-based
`--shard-index` with `--shard-count` to partition the physical JSONL rows
without shortening any accepted dialogue. Reports record the backend and requested model separately;
the requested identifier is not a claim about an alias the provider actually
served.

After every shard finishes, merge them into a comparative matrix. The merger
reopens the source JSONL and rejects partial status, bounded runs, missing or
duplicate shards, rows assigned to the wrong shard, source-content drift,
duplicate rows, and incomplete physical-row coverage:

```bash
bun run --cwd packages/scenario-runner eval:timing:merge -- \
  --output=../../reports/group-chat-timing/matrix.json \
  /path/to/shard-*.json
```

For long live cells, use the supervisor instead of launching shards by hand:

```bash
bun run --cwd packages/scenario-runner eval:timing:matrix -- \
  --input=/path/to/finetune_test_dialogue.jsonl \
  --output-dir=/path/to/model-cell \
  --provider=cli \
  --shard-count=8 \
  --workers=4
```

It adopts complete shards, resumes validated `in-progress` checkpoints, keeps
per-shard stdout/stderr and trajectories, retries only runtime/provider exits,
and writes an atomic run manifest. A configuration exit is terminal. The run
finishes only after the canonical merger proves that every physical input row
belongs to exactly one complete shard in one model cell. Re-running the same
command performs no model calls after that proof exists.

Pinned Discord replay output can exercise the same Stage-1 boundary:

```bash
bun run --cwd packages/scenario-runner eval:when2speak -- \
  --input=/tmp/discord-replay.jsonl \
  --input-format=discord-replay \
  --provider=cli
```

Only points whose current turn is inbound to the selected target seat are
eligible. The converter's paired SILENT pseudo-label assigns the target seat to
the author of the current turn in a two-author chain; those points are recorded
as explicit eligibility exclusions instead of pretending production evaluates
its own outbound message. Exclusions remain part of physical-row coverage but
do not make the command fail; malformed rows remain failures and exit nonzero.

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

### Plugin requirements

Declare npm plugin import specifiers in `requires.plugins`; the runner passes
each value to the runtime module resolver and registers the exported plugin
before startup. This supports scoped or unscoped packages and package subpath
exports without guessing from the spelling. Relative, absolute, `file:`, and
`workspace:` specifiers fail preflight with a typed error because they are not
portable runtime package requirements.

If a scenario seed registers an in-file fixture plugin, declare its runtime
plugin name in `requires.fixturePlugins` instead. Fixture names are verified
after seeding and are never treated as module specifiers.

### Turn kinds

| Kind | What it does |
|---|---|
| `message` | Sends text through `runtime.messageService.handleMessage` (full conversational path) |
| `action` | Calls a runtime-registered action's `validate` + `handler` directly; `expectedValidation: "rejected"` proves an invalid input is refused without invoking the handler |
| `api` | Makes an HTTP request to the agent's registered routes via a loopback server |
| `tick` | Invokes the lifeops scheduler at a logical clock time |
| `wait` | Waits for `durationMs`, or polls a bounded `until(ctx)` state predicate |

### Multi-world rooms and linked accounts

`rooms[].world` names a logical world and `rooms[].entity` names a canonical
logical entity. Distinct connector `account` values can use the same `entity`
to model verified linked accounts across platforms. Omitting both fields keeps
the legacy single-world, account-derived identity behavior. Seeds and custom
checks receive deterministic runtime IDs through `ctx.roomIds`, `ctx.worldIds`,
`ctx.entityIds`, `ctx.accountEntityIds`, `ctx.roomWorldIds`, and
`ctx.roomEntityIds`. A memory seed may set `roomId` to a logical room name.

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
`strict-fixtures` or `model-free`. Declared rows contain only direct action/API
work or wait/seed/final checks and are validated again by the real executor
before each attempt. Migration is complete when no scenario reports
`legacy-fallback`.

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
