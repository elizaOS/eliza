# @elizaos/scenario-runner

Lean end-to-end scenario runner for elizaOS agents. Loads `.scenario.ts` files, executes them against a real `AgentRuntime` with a live (or deterministic-proxy) LLM, and emits a JSON report.

## Purpose / role

This package is the canonical integration-test runtime for elizaOS plugins and agent behaviour. It boots a real `AgentRuntime` (PGLite-backed, no SQL mocks), routes turns through the runtime's action pipeline, and checks assertions at the per-turn and per-scenario level. It is consumed by `packages/test/scenarios/` and plugin-level test suites (e.g. `plugins/plugin-app-control/test/scenarios/`). The schema types it depends on live in `@elizaos/scenario-runner/schema` (exported from the `schema/` directory).

## Layout

```
packages/scenario-runner/
  bin/
    eliza-scenarios          # CLI entry shim — imports the built dist/cli.js
  schema/
    index.js / index.d.ts   # ScenarioDefinition, ScenarioTurn, CapturedAction, etc.
  src/
    index.ts                 # Public re-exports
    cli.ts                   # `eliza-scenarios run|list` — arg parsing + orchestration
    executor.ts              # runScenario() — core execution loop, including deterministic background control
    background-runtime.ts    # manual virtual-time control over production TaskService workers and queue drivers
    runtime-factory.ts       # createScenarioRuntime() — boots AgentRuntime with PGLite + LLM
    loader.ts                # discoverScenarios / loadAllScenarios / listScenarioMetadata / expandScenarioDefinition / countScenarioCorpus / validateScenarioCorpus
    interceptor.ts           # attachInterceptor() — wraps action handlers to capture CapturedAction[]
    judge.ts                 # judgeTextWithLlm() — LLM-as-judge (Cerebras gpt-oss-120b or fallback)
    cerebras-judge.ts        # CerebrasJudge class — low-level Cerebras API transport + verdict parsing
    reporter.ts              # buildAggregate / writeReport / writeScenarioRunViewer
    native-export.ts         # exportScenarioNativeJsonl — converts trajectories to training corpus rows
    seeds.ts                 # applyScenarioSeedStep — seed dispatch (todo / contact / memory / gmailInbox)
    action-families.ts       # actionsAreScenarioEquivalent — fuzzy action-name matching
    types.ts                 # TurnReport / ScenarioReport / AggregateReport / RunnerContext
    utils.ts                 # toRecord / isLoopbackUrl — internal utility helpers
    final-checks/
      index.ts               # runFinalCheck — dispatches named final-check type handlers
    types/                   # Supporting internal type files
  test/
    scenarios/               # Runner-owned scenarios: deterministic-* PR fixtures plus live-* / live-only coverage
    fixtures/                # Misc test fixtures (e.g. mcp-stdio-fixture.mjs)
```

## Key exports

```ts
// Execution
import { runScenario }       from "@elizaos/scenario-runner";
import { attachInterceptor } from "@elizaos/scenario-runner";
import { judgeTextWithLlm }  from "@elizaos/scenario-runner";

// Discovery / loading
import {
  discoverScenarios, loadAllScenarios, loadScenarioFile,
  listScenarioMetadata, loadScenarioMetadataFile,
  countScenarioCorpus, validateScenarioCorpus,
  expandScenarioDefinition, expandScenarioMetadata,
  SCENARIO_EDGE_VARIANTS,
} from "@elizaos/scenario-runner";

// Reporting
import {
  buildAggregate, writeReport, printStdoutSummary, writeScenarioRunViewer,
} from "@elizaos/scenario-runner";

// Native (training corpus) export
import {
  exportScenarioNativeJsonl, recordedTrajectoryToNativeRows,
  SCENARIO_NATIVE_EXPORT_SCHEMA, SCENARIO_NATIVE_EXPORT_VERSION,
} from "@elizaos/scenario-runner";
import type { NativeBoundaryRow, ScenarioNativeExportManifest } from "@elizaos/scenario-runner";

// Types
import type { ScenarioReport, AggregateReport, TurnReport, FinalCheckReport }
  from "@elizaos/scenario-runner";

// Schema types (ScenarioDefinition lives here, not in dist/)
import type { ScenarioDefinition, ScenarioTurn, CapturedAction }
  from "@elizaos/scenario-runner/schema";
```

`runScenario(scenario, runtime, opts)` is the core API. The CLI calls it for each discovered file. The runtime factory (`createScenarioRuntime`) is defined in `runtime-factory.ts` and is **not** part of the package's main entry; import it from the `@elizaos/scenario-runner/runtime-factory` subpath (or relatively, e.g. `./src/runtime-factory.ts`, when working inside this repo).

## CLI — `eliza-scenarios`

```
eliza-scenarios run  <dir> [--run-dir <dir>] [--export-native <jsonlPath>]
                            [--report <jsonPath>] [--report-dir <dir>]
                            [--runId <id>] [--scenario id1,id2]
                            [--lane pr-deterministic|live-only]
                            [--provider groq|openai|anthropic|google|openrouter|cli]
                            [fileGlob ...]
eliza-scenarios list <dir> [--lane pr-deterministic|live-only] [fileGlob ...]
```

`--provider` pins a `run` invocation to one configured live provider instead of
using provider precedence. Invalid or unavailable selections fail loudly.

Exit codes: `0` = all passed (or skipped with `SKIP_REASON` set), `1` = at least one failed, `2` = config/usage error or a scenario skipped without `SKIP_REASON`.

### Lanes

A scenario declares its CI lane via the optional `lane` field
(`@elizaos/scenario-runner/schema`):

- `pr-deterministic` — runs on every PR under the deterministic model provider with
  zero credentials. Claim this lane **only** if the scenario passes keyless: no
  live external service, no secret, every LLM call either backed by a registered
  proxy fixture or satisfied by the proxy's default reply.
- `live-only` — needs live model credentials and/or connector services. This is
  the default for any scenario that does not declare a lane.

`--lane <lane>` filters `run`/`list` to one lane. The big `packages/test/scenarios`
corpus is `live-only` by default; the keyless subset is run on PRs via
`test:corpus:pr:e2e` (`run ../test/scenarios --lane pr-deterministic`).

## Commands

```bash
bun run --cwd packages/scenario-runner build
bun run --cwd packages/scenario-runner test
bun run --cwd packages/scenario-runner typecheck
bun run --cwd packages/scenario-runner test:deterministic:e2e
bun run --cwd packages/scenario-runner test:live:e2e
bun run --cwd packages/scenario-runner test:pr:e2e
bun run --cwd packages/scenario-runner clean
```

## Config / env vars

| Env var | Effect |
|---|---|
| `SCENARIO_USE_DETERMINISTIC_MODEL` / `ELIZA_SCENARIO_USE_DETERMINISTIC_MODEL` | `1` = use the fixture-driven core model provider instead of a live provider |
| `SCENARIO_INCLUDE_PENDING` | `1` = include scenarios with `status: "pending"` |
| `SKIP_REASON` | Set to a non-empty string to allow skipped scenarios without failing exit 2 |
| `LIFEOPS_LIVE_JUDGE_MIN_SCORE` | Float, default `0.8`; minimum LLM judge score to pass |
| `ELIZA_BENCH_SKIP_EMBEDDING` | Default `1`; set to `0` to use `@elizaos/plugin-local-inference` for real embeddings |
| `ELIZA_SCENARIO_PGLITE_DIR` / `SCENARIO_PGLITE_DIR` | Override the temp PGLite directory |
| `ELIZA_SAVE_TRAJECTORIES` / `SCENARIO_SAVE_TRAJECTORIES` | `1` = preserve PGLite DB after run |
| `ELIZA_TRAJECTORY_DIR` | Set by CLI when `--run-dir` is active; picked up by the trajectory recorder |
| `ELIZA_TRAJECTORY_LOGGING` | Set to `1` by `eliza-scenarios run` when the operator has not already set it, so bare scenario runs record trajectories even when `NODE_ENV=test|production`; explicit `0` and `ELIZA_DISABLE_TRAJECTORY_LOGGING=1` are respected |
| `ELIZA_LIFEOPS_RUN_ID` | Injected by CLI; tags trajectories with the run ID |
| `ELIZA_LIFEOPS_SCENARIO_ID` | Injected per scenario so trajectory files are tagged correctly |
| `ELIZA_DISABLE_ACTIVITY_TRACKER` | Defaults to `1`; a scenario requiring `activity_tracker` opts in |
| `ELIZA_DISABLE_PROACTIVE_AGENT` | Set to `1` by the runtime factory |
| `ELIZA_DISABLE_LIFEOPS_SCHEDULER` | Set to `1` by the runtime factory |
| `PGLITE_DATA_DIR` | Managed by `createScenarioRuntime`; restored on cleanup |
| `GROQ_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GOOGLE_GENERATIVE_AI_API_KEY` / `OPENROUTER_API_KEY` | Any one satisfies the live-provider requirement |

## Anatomy of a scenario file

Scenario files must end in `.scenario.ts`. They export a `ScenarioDefinition` as `default` or as `export const scenario`:

```ts
import type { ScenarioDefinition } from "@elizaos/scenario-runner/schema";

export default {
  id: "my-feature-happy-path",
  title: "My feature: happy path",
  domain: "my-feature",
  tags: ["deterministic"],
  turns: [
    {
      name: "user asks",
      kind: "message",    // "message" | "action" | "api" | "tick" | "background"
      text: "Do the thing",
      assertResponse(text) {
        if (!text.includes("done")) return "expected 'done' in response";
      },
    },
  ],
  finalChecks: [
    { type: "actionCalled", name: "THING_DONE", actionName: "DO_THING", minCount: 1 },
  ],
} satisfies ScenarioDefinition;
```

Loader discovers files recursively; entries starting with `_` are ignored. The `list` command reads only static metadata via TypeScript AST (no runtime import), so `id` must be a string literal.

## Turn kinds

- `message` — sends text through `runtime.messageService.handleMessage`. Default kind.
- `action` — calls a named action's `validate` + `handler` directly (bypasses LLM routing).
- `api` — sends an HTTP request to the scenario's loopback API server (routes registered on the runtime).
- `tick` — invokes `executeLifeOpsSchedulerTask` from `@elizaos/plugin-personal-assistant/plugin` (tests scheduler ticks at a logical clock time).
- `background` — controls declared production TaskService workers with virtual-time `start`, `pause`, `resume`, `step`, `drain`, `crash`, `restart`, `inspect`, and `reset` operations. Use `requires.services` and `requires.workers`; undeclared/missing workers fail readiness.

## Final check types (from `schema/index.js`)

`actionCalled`, `selectedAction`, `selectedActionArguments`, `judgeRubric`, `connectorDispatchOccurred`, `memoryWriteOccurred`, `approvalRequestExists`, `approvalStateTransition`, `browserTaskCompleted`, `browserTaskNeedsHuman`, `messageDelivered`, `draftExists`, `uploadedAssetExists`, `gmailActionArguments`, `gmailMockRequest`, `custom`, and others. The full list is in `schema/index.js` (`FINAL_CHECK_KEYS` map).

## How to add a scenario

1. Create `<plugin-or-package>/test/scenarios/<name>.scenario.ts` exporting a `ScenarioDefinition`.
2. Use `kind: "message"` for conversational turns, `kind: "action"` for direct action invocations, `kind: "api"` for route testing.
3. Assert per-turn with `assertResponse` / `assertTurn` / `responseIncludesAny` / `responseJudge`.
4. Assert end-state with `finalChecks` entries.
5. Run with `bun src/cli.ts run <dir> --scenario <id>` or via `test:deterministic:e2e`.

For LifeOps persona-pack scenarios, also follow
`plugins/plugin-personal-assistant/test/scenarios/_catalogs/LIFEOPS_PERSONA_SCENARIO_AUTHORING.md`
and update the owning pack catalog.

## Conventions / gotchas

- **Single shared runtime per CLI invocation.** PGLite cannot be torn down and recreated (segfaults). For true per-scenario isolation, invoke `eliza-scenarios run` once per scenario from a shell loop.
- **Deterministic mode.** `SCENARIO_USE_DETERMINISTIC_MODEL=1` registers `createDeterministicModelPlugin` from `@elizaos/core/testing`. Every model call must match exactly one registered fixture or an explicit scenario resolver. Action routes use `registerStrictActionRouteFixtures` from `@elizaos/core/testing`; there is no heuristic fallback.
- **Silent skips fail loudly.** If a scenario skips without `SKIP_REASON` set, the CLI exits 2.
- **UPDATE_ENTITY is removed** from the runtime's action list during scenario runs. It's too broad and steals action selection from domain-specific actions under test.
- **Embeddings in simulated runs.** No embedding model is registered by default, so the runtime explicitly disables semantic retrieval without fabricating vectors or downloading a model. Set `ELIZA_BENCH_SKIP_EMBEDDING=0` to use `@elizaos/plugin-local-inference`.
- **LLM judge.** Uses Cerebras `gpt-oss-120b` when `isCerebrasEvalEnabled()` returns true; falls back to the runtime's `TEXT_LARGE` model. No heuristic fallbacks — the judge call genuinely fails if neither is available.
- **Template tokens in turn text.** `{{now}}`, `{{now+1h}}`, `{{now-2d}}`, `{{definitionId:<title>}}`, `{{occurrenceId:<title>}}` are resolved at execution time.
- **Clock seeding.** `seed` steps of type `advanceClock` shift `ctx.now`; all subsequent template tokens are relative to the shifted clock.
- **Schema vs dist exports.** `ScenarioDefinition` and schema types come from `@elizaos/scenario-runner/schema` (the `schema/` directory, not `dist/`). Do not import them from `@elizaos/scenario-runner` directly.

## Verification

Follow the repository-wide verification and evidence standard in the [root CLAUDE.md](../../CLAUDE.md). Run
the package's relevant build, typecheck, lint, and test commands, then exercise
the real integration boundary changed by the work. Inspect the produced domain
artifacts and failure behavior; do not substitute mocked success for the system
under test.
