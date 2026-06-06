# @elizaos/scenario-runner

Lean end-to-end scenario runner for elizaOS agents. Loads `.scenario.ts` files, executes them against a real `AgentRuntime` with a live (or deterministic-proxy) LLM, and emits a JSON report.

## Purpose / role

This package is the canonical integration-test harness for elizaOS plugins and agent behaviour. It boots a real `AgentRuntime` (PGLite-backed, no SQL mocks), routes turns through the runtime's action pipeline, and checks assertions at the per-turn and per-scenario level. It is consumed by `packages/test/scenarios/` and plugin-level test suites (e.g. `plugins/plugin-app-control/test/scenarios/`). The schema types it depends on live in `@elizaos/scenario-runner/schema` (exported from the `schema/` directory).

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
    executor.ts              # runScenario() — core execution loop (message/action/api/tick turns)
    runtime-factory.ts       # createScenarioRuntime() — boots AgentRuntime with PGLite + LLM
    loader.ts                # discoverScenarios / loadAllScenarios / listScenarioMetadata
    interceptor.ts           # attachInterceptor() — wraps action handlers to capture CapturedAction[]
    judge.ts                 # judgeTextWithLlm() — LLM-as-judge (Cerebras gpt-oss-120b or fallback)
    reporter.ts              # buildAggregate / writeReport / writeScenarioRunViewer
    native-export.ts         # exportScenarioNativeJsonl — converts trajectories to training corpus rows
    seeds.ts                 # applyScenarioSeedStep — seed dispatch (todo / contact / memory / gmailInbox)
    action-families.ts       # actionsAreScenarioEquivalent — fuzzy action-name matching
    types.ts                 # TurnReport / ScenarioReport / AggregateReport / RunnerContext
    final-checks/
      index.ts               # runFinalCheck — dispatches named final-check type handlers
    types/                   # Supporting internal type files
  test/
    scenarios/               # 17 deterministic scenario files (*.scenario.ts)
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
                            [--runId <id>] [--scenario id1,id2] [fileGlob ...]
eliza-scenarios list <dir> [fileGlob ...]
```

Exit codes: `0` = all passed (or skipped with `SKIP_REASON` set), `1` = at least one failed, `2` = config/usage error or a scenario skipped without `SKIP_REASON`.

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
| `SCENARIO_USE_LLM_PROXY` / `ELIZA_SCENARIO_USE_LLM_PROXY` | `1` = use deterministic LLM proxy instead of a live provider |
| `SCENARIO_LLM_PROXY_STRICT` / `ELIZA_SCENARIO_LLM_PROXY_STRICT` | `1` = strict mode: every LLM call must match a registered fixture, else it throws |
| `SCENARIO_INCLUDE_PENDING` | `1` = include scenarios with `status: "pending"` |
| `SKIP_REASON` | Set to a non-empty string to allow skipped scenarios without failing exit 2 |
| `LIFEOPS_LIVE_JUDGE_MIN_SCORE` | Float, default `0.8`; minimum LLM judge score to pass |
| `ELIZA_BENCH_SKIP_EMBEDDING` | Default `1`; set to `0` to use `@elizaos/plugin-local-inference` for real embeddings |
| `ELIZA_SCENARIO_PGLITE_DIR` / `SCENARIO_PGLITE_DIR` | Override the temp PGLite directory |
| `ELIZA_SAVE_TRAJECTORIES` / `SCENARIO_SAVE_TRAJECTORIES` | `1` = preserve PGLite DB after run |
| `ELIZA_TRAJECTORY_DIR` | Set by CLI when `--run-dir` is active; picked up by the trajectory recorder |
| `ELIZA_LIFEOPS_RUN_ID` | Injected by CLI; tags trajectories with the run ID |
| `ELIZA_LIFEOPS_SCENARIO_ID` | Injected per scenario so trajectory files are tagged correctly |
| `ELIZA_DISABLE_ACTIVITY_TRACKER` | Set to `1` by the runtime factory; suppresses activity-tracker background work |
| `ELIZA_DISABLE_PROACTIVE_AGENT` | Set to `1` by the runtime factory |
| `ELIZA_DISABLE_LIFEOPS_SCHEDULER` | Set to `1` by the runtime factory |
| `SKILLS_SYNC_CATALOG_ON_START` | Set to `false` by the runtime factory (avoids live registry calls) |
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
      kind: "message",    // "message" | "action" | "api" | "tick"
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

## Final check types (from `schema/index.js`)

`actionCalled`, `selectedAction`, `selectedActionArguments`, `judgeRubric`, `connectorDispatchOccurred`, `memoryWriteOccurred`, `approvalRequestExists`, `approvalStateTransition`, `browserTaskCompleted`, `browserTaskNeedsHuman`, `messageDelivered`, `draftExists`, `uploadedAssetExists`, `gmailActionArguments`, `gmailMockRequest`, `custom`, and others. The full list is in `schema/index.js` (`FINAL_CHECK_KEYS` map).

## How to add a scenario

1. Create `<plugin-or-package>/test/scenarios/<name>.scenario.ts` exporting a `ScenarioDefinition`.
2. Use `kind: "message"` for conversational turns, `kind: "action"` for direct action invocations, `kind: "api"` for route testing.
3. Assert per-turn with `assertResponse` / `assertTurn` / `responseIncludesAny` / `responseJudge`.
4. Assert end-state with `finalChecks` entries.
5. Run with `bun src/cli.ts run <dir> --scenario <id>` or via `test:deterministic:e2e`.

## Conventions / gotchas

- **Single shared runtime per CLI invocation.** PGLite cannot be torn down and recreated (segfaults). For true per-scenario isolation, invoke `eliza-scenarios run` once per scenario from a shell loop.
- **Deterministic mode.** `SCENARIO_USE_LLM_PROXY=1` swaps the live provider for the deterministic LLM proxy plugin (`packages/test/mocks/helpers/llm-proxy-plugin.ts`). With `SCENARIO_LLM_PROXY_STRICT=1`, any LLM call that has no registered fixture throws instead of falling back. Fixtures are registered programmatically per scenario via `registerStrictActionRouteFixtures` from `test/scenarios/_helpers/strict-llm-action-fixtures.ts` — not loaded from a fixtures directory. (`test/fixtures/` holds only the MCP stdio fixture.)
- **Silent skips fail loudly.** If a scenario skips without `SKIP_REASON` set, the CLI exits 2.
- **UPDATE_ENTITY is removed** from the runtime's action list during scenario runs. It's too broad and steals action selection from domain-specific actions under test.
- **Embedding fallback.** By default a zero-vector 1024-dim embedding fallback is registered instead of `@elizaos/plugin-local-inference` (avoids gated HuggingFace downloads). Set `ELIZA_BENCH_SKIP_EMBEDDING=0` to use the real plugin.
- **LLM judge.** Uses Cerebras `gpt-oss-120b` when `isCerebrasEvalEnabled()` returns true; falls back to the runtime's `TEXT_LARGE` model. No heuristic fallbacks — the judge call genuinely fails if neither is available.
- **Template tokens in turn text.** `{{now}}`, `{{now+1h}}`, `{{now-2d}}`, `{{definitionId:<title>}}`, `{{occurrenceId:<title>}}` are resolved at execution time.
- **Clock seeding.** `seed` steps of type `advanceClock` shift `ctx.now`; all subsequent template tokens are relative to the shifted clock.
- **Schema vs dist exports.** `ScenarioDefinition` and schema types come from `@elizaos/scenario-runner/schema` (the `schema/` directory, not `dist/`). Do not import them from `@elizaos/scenario-runner` directly.
