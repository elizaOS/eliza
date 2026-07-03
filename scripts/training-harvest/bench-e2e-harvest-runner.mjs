#!/usr/bin/env node
/**
 * gpt-5.5 trajectory-training pipeline — Stage 2 harvest driver for the
 * BENCHMARK and E2E families (sibling of harvest-runner.mjs, which owns the
 * scenario family). This driver never touches the scenario code path.
 *
 * Both families drive a real AgentRuntime through the CLI-subscription provider
 * (plugin-cli-inference: `codex exec -m gpt-5.5`), so the runtime's
 * JsonFileTrajectoryRecorder writes RecordedTrajectory JSON to
 * ELIZA_TRAJECTORY_DIR. The driver then converts that to eliza_native_v1 JSONL
 * with the same scenario-runner native-export the scenario family uses.
 *
 * Layout written per item (mirrors the scenario family):
 *   <harvestRoot>/<family>/<suite-or-lane-slug>/<item-slug>/
 *       run/trajectories/<agentId>/<trajId>.json   RecordedTrajectory (recorder)
 *       native.jsonl                                eliza_native_v1 rows
 *       native.manifest.json                        scenario-runner export manifest
 *       verdict.json                               { item, status, rows, exitCode }
 *       result.json (benchmark)                    bench.ts scenario result
 *       stdout.log / stderr.log
 *
 * PROVIDER PARAMETERIZATION (consumes Stage-1 output; identical precedence to
 * harvest-runner.mjs so both drivers take the same --provider-env file):
 *     1. --provider-env <file.json>   (a JSON object of env vars; what S1 writes)
 *     2. $HARVEST_PROVIDER_ENV_FILE
 *     3. inherited ELIZA_CHAT_VIA_CLI / an API key
 *     4. --deterministic (offline driver self-test — enumerate only, no live run)
 *
 * When the resolved provider is a CLI backend (claude or codex), the driver forces
 * the two env vars the CLI route requires end-to-end but that a bare provider-env
 * file may omit:
 *     ELIZA_PLANNER_NATIVE_TOOLS=0   text-planner mode (free-text CLI serves the planner)
 *     ELIZA_TRAJECTORY_RECORDING=1   keep the recorder on (it is default-on; set explicit)
 *
 * FAMILIES
 *   benchmark  The framework TS benchmark (packages/benchmarks/framework/typescript/src/bench.ts).
 *              Its --real-llm cli/codex branch (this stage's bench.ts change) drives one real
 *              gpt-5.5 turn per scenario. Corpus = the model-driving framework scenarios; the
 *              db/startup scenarios never call the model, so they are excluded. Runs each scenario
 *              at --iterations=1 --warmup=0 (one real turn = one trajectory), minimal cost.
 *   e2e        A live app-core vitest lane (packages/app-core/test/live-agent/*). Runs the lane
 *              through vitest.harvest-live-agent.config.ts with ELIZA_LIVE_TEST=1 + the trajectory
 *              env; verdict = vitest pass/fail. The app-core selectLiveProvider now recognizes the
 *              cli backend (this stage) so lanes select gpt-5.5. NOTE: the live-agent lanes eagerly
 *              import first-party plugins, so a dist-less worktree fails at Vite transform → the
 *              driver records status "blocked-workspace-build" (run `bun run build` first). Full
 *              harvestable-vs-env-gated classification + the build precondition: BENCHMARK_E2E_README.md.
 *
 * Usage:
 *   node bench-e2e-harvest-runner.mjs --family benchmark --provider-env s1.json [--limit N]
 *   node bench-e2e-harvest-runner.mjs --family e2e --provider-env s1.json --lane <substr>
 *   node bench-e2e-harvest-runner.mjs --family benchmark --deterministic --dry-run   # self-test
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const TSCONFIG = path.join(REPO_ROOT, "tsconfig.json");
const NATIVE_EXPORT_TS = path.join(
  REPO_ROOT,
  "packages/scenario-runner/src/native-export.ts",
);
const BENCH_TS = path.join(
  REPO_ROOT,
  "packages/benchmarks/framework/typescript/src/bench.ts",
);

const CLI_BACKENDS = new Set(["claude", "claude-sdk", "codex", "codex-sdk"]);

function flag(name) {
  return process.argv.includes(name);
}
function opt(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const DRY_RUN = flag("--dry-run");
const DETERMINISTIC = flag("--deterministic");
const RESUME = flag("--resume");
const LIMIT = Number(opt("--limit", "0")) || 0;
const FAMILY = opt("--family", "benchmark");
const SHARD = opt("--shard", null);
const [SHARD_I, SHARD_N] = SHARD ? SHARD.split("/").map(Number) : [0, 1];
const ITEM_FILTER = opt("--item", null); // benchmark scenario id filter
const LANE_FILTER = opt("--lane", null); // e2e lane path substring filter
const ITEM_TIMEOUT_MS = Number(opt("--item-timeout-ms", "900000")) || 900000;
const HARVEST_ROOT = path.resolve(
  opt(
    "--harvest-root",
    path.join(
      REPO_ROOT,
      ".github/issue-evidence/gpt55-training-pipeline/harvest",
    ),
  ),
);

// ── Corpus definitions ──────────────────────────────────────────────────────

/**
 * The framework benchmark's model-driving scenarios (bench.ts). Ordered
 * cheapest-first (message count). The db/startup scenarios never call the model
 * and cannot emit a trajectory, so they are excluded from the harvest corpus.
 * `single-turn` scenarios send one message; the scaling/burst ones send many —
 * keep them last (expensive on a live subscription).
 */
const BENCHMARK_SUITE = "framework";
const BENCHMARK_SCENARIOS = [
  "single-message",
  "minimal-bootstrap",
  "with-should-respond",
  "with-should-respond-no-name",
  "with-actions",
  "multi-step",
  "conversation-10",
  "history-scaling-100",
  "provider-scaling-10",
  "concurrent-10",
  "conversation-100",
  "provider-scaling-50",
  "provider-scaling-100",
  "history-scaling-1000",
  "concurrent-50",
  "burst-100",
  "burst-1000",
  "history-scaling-10000",
];

/**
 * E2E lanes that exercise the model and need ONLY a live LLM provider (no
 * connector/cloud/device credentials). These app-core live-agent lanes gate on
 * the app-core `selectLiveProvider()` helper, which this stage taught to
 * recognize the cli backend — so they run on gpt-5.5-via-Codex. Ordered
 * lightest-first (in-process createRealTestRuntime, no subprocess/browser).
 * Heavier subprocess/Chrome lanes and the lifeops-harness lanes (which use a
 * separate, still-cli-unaware selector) are documented in BENCHMARK_E2E_README.md.
 * Env-gated lanes (connectors, cloud, vision, computeruse, shopify, gmail, device)
 * are intentionally excluded.
 */
const E2E_HARVESTABLE_LANES = [
  // lightest: in-process runtime, single generateText / harness turn
  "packages/app-core/test/live-agent/cloud-providers.live.e2e.test.ts",
  "packages/app-core/test/live-agent/real-runtime-helpers.live.e2e.test.ts",
  "packages/app-core/test/live-agent/experience-extraction.live.e2e.test.ts",
  "packages/app-core/test/live-agent/action-invocation.live.e2e.test.ts",
  "packages/app-core/test/live-agent/page-scoped-chat.live.e2e.test.ts",
  "packages/app-core/test/live-agent/personality-routing.live.e2e.test.ts",
  "packages/app-core/test/live-agent/runtime-debug.live.e2e.test.ts",
  // heavier: spawn a full startEliza subprocess (slower, but provider-only)
  "packages/app-core/test/live-agent/agent-runtime.live.e2e.test.ts",
  "packages/app-core/test/live-agent/cloud-auth.live.e2e.test.ts",
  "packages/app-core/test/live-agent/database-conversation.live.e2e.test.ts",
  "packages/app-core/test/live-agent/plugin-lifecycle.live.e2e.test.ts",
];

// ── Provider env (shared precedence with harvest-runner.mjs) ─────────────────

function loadProviderEnv() {
  const file = opt("--provider-env", process.env.HARVEST_PROVIDER_ENV_FILE);
  if (file && existsSync(file)) {
    return {
      source: `file:${file}`,
      env: JSON.parse(readFileSync(file, "utf8")),
    };
  }
  if (DETERMINISTIC) {
    return { source: "deterministic-enumerate-only", env: {} };
  }
  if (process.env.ELIZA_CHAT_VIA_CLI) {
    return {
      source: "inherited:ELIZA_CHAT_VIA_CLI",
      env: {
        ELIZA_CHAT_VIA_CLI: process.env.ELIZA_CHAT_VIA_CLI,
        ...(process.env.ELIZA_CLI_CODEX_MODEL
          ? { ELIZA_CLI_CODEX_MODEL: process.env.ELIZA_CLI_CODEX_MODEL }
          : {}),
      },
    };
  }
  const apiKeys = [
    "OPENAI_API_KEY",
    "CEREBRAS_API_KEY",
    "ANTHROPIC_API_KEY",
    "GROQ_API_KEY",
    "OPENROUTER_API_KEY",
    "GOOGLE_GENERATIVE_AI_API_KEY",
  ].filter((k) => process.env[k]);
  if (apiKeys.length > 0) return { source: `inherited:${apiKeys[0]}`, env: {} };
  throw new Error(
    "no provider configured: pass --provider-env <s1.json>, --deterministic, or export ELIZA_CHAT_VIA_CLI / an API key",
  );
}

/**
 * Fold in the env vars the CLI route needs end-to-end. A bare provider-env file
 * ({ELIZA_CHAT_VIA_CLI, ELIZA_CLI_CODEX_MODEL}) omits ELIZA_PLANNER_NATIVE_TOOLS,
 * without which the free-text CLI cannot serve the planner (text-planner mode).
 */
function withCliRunEnv(providerEnv) {
  const backend = (providerEnv.ELIZA_CHAT_VIA_CLI ?? "").trim().toLowerCase();
  if (!CLI_BACKENDS.has(backend)) return { ...providerEnv };
  return {
    ELIZA_PLANNER_NATIVE_TOOLS: "0",
    ELIZA_TRAJECTORY_RECORDING: "1",
    ...providerEnv,
  };
}

function slug(s) {
  return s.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
}

/** Convert RecordedTrajectory JSON under <runDir>/trajectories → eliza_native_v1 JSONL. */
function nativeExport(runDir, outPath) {
  const script =
    `import { exportScenarioNativeJsonl } from ${JSON.stringify(`file://${NATIVE_EXPORT_TS}`)};` +
    `const rows = exportScenarioNativeJsonl(${JSON.stringify(runDir)}, ${JSON.stringify(outPath)});` +
    `process.stdout.write(\`NATIVE_ROWS \${rows}\\n\`);`;
  const res = spawnSync("bun", ["--conditions", "eliza-source", "-e", script], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 240000,
    env: process.env,
  });
  const m = /NATIVE_ROWS (\d+)/.exec(res.stdout || "");
  return m
    ? Number(m[1])
    : existsSync(outPath)
      ? readFileSync(outPath, "utf8")
          .split("\n")
          .filter((l) => l.trim()).length
      : 0;
}

// ── Benchmark family ─────────────────────────────────────────────────────────

function runBenchmarkItem(scenarioId, runEnv) {
  const itemDir = path.join(
    HARVEST_ROOT,
    "benchmark",
    BENCHMARK_SUITE,
    slug(scenarioId),
  );
  const trajDir = path.join(itemDir, "run", "trajectories");
  mkdirSync(trajDir, { recursive: true });
  const resultPath = path.join(itemDir, "result.json");
  const args = [
    "--conditions",
    "eliza-source",
    "--tsconfig-override",
    TSCONFIG,
    BENCH_TS,
    "--real-llm",
    `--scenarios=${scenarioId}`,
    "--iterations=1",
    "--warmup=0",
    `--output=${resultPath}`,
  ];
  const res = spawnSync("bun", args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: ITEM_TIMEOUT_MS,
    env: {
      ...process.env,
      ...runEnv,
      LOG_LEVEL: "info",
      ELIZA_TRAJECTORY_DIR: trajDir,
    },
  });
  writeFileSync(path.join(itemDir, "stdout.log"), res.stdout || "");
  writeFileSync(path.join(itemDir, "stderr.log"), res.stderr || "");

  const nativePath = path.join(itemDir, "native.jsonl");
  const rows = nativeExport(path.join(itemDir, "run"), nativePath);

  let status = "error";
  if (existsSync(resultPath)) {
    try {
      const result = JSON.parse(readFileSync(resultPath, "utf8"));
      const ran = result.scenarios?.[scenarioId];
      status = ran && rows > 0 ? "passed" : ran ? "no-trajectory" : "error";
    } catch {
      status = "error";
    }
  }
  const verdict = {
    family: "benchmark",
    suite: BENCHMARK_SUITE,
    item: scenarioId,
    provider: runEnv.ELIZA_CHAT_VIA_CLI
      ? `cli:${runEnv.ELIZA_CHAT_VIA_CLI}`
      : "api-key",
    model: runEnv.ELIZA_CLI_CODEX_MODEL ?? null,
    status,
    rows,
    exitCode: res.status,
    trajectoryFormat: "eliza_native_v1",
    resultPath: existsSync(resultPath) ? "result.json" : null,
    nativePath: existsSync(nativePath) ? "native.jsonl" : null,
  };
  writeVerdict(itemDir, verdict);
  return verdict;
}

// ── E2E family ───────────────────────────────────────────────────────────────

function runE2eItem(laneRel, runEnv) {
  // These lanes run through the package's own vitest config (which mirrors the
  // workspace `exports` so @elizaos/* resolves to source with dist absent), via
  // the shared run-vitest.mjs wrapper (resolves an external Node — the codex
  // bundled Node cannot run Vitest). The harvestable set is app-core-only.
  const pkgDir = path.join(REPO_ROOT, laneRel.split("/").slice(0, 2).join("/"));
  const runVitest = path.join(REPO_ROOT, "packages/scripts/run-vitest.mjs");
  const itemDir = path.join(HARVEST_ROOT, "e2e", slug(laneRel));
  const trajDir = path.join(itemDir, "run", "trajectories");
  mkdirSync(trajDir, { recursive: true });
  const laneAbs = path.join(REPO_ROOT, laneRel);
  const res = spawnSync(
    "node",
    [
      runVitest,
      "run",
      // The default config excludes *.live.e2e.test.ts wholesale; this harvest
      // config surfaces the test/live-agent lanes (inherits the default @elizaos
      // source aliases). See packages/app-core/vitest.harvest-live-agent.config.ts.
      "--config",
      "vitest.harvest-live-agent.config.ts",
      laneAbs,
      "--reporter=verbose",
    ],
    {
      cwd: pkgDir,
      encoding: "utf8",
      timeout: ITEM_TIMEOUT_MS,
      env: {
        ...process.env,
        ...runEnv,
        ELIZA_LIVE_TEST: "1",
        // The default vitest.config.ts excludes live-agent e2e lanes unless this
        // is set (packages/app-core/vitest.config.ts `includeLiveE2e`).
        ELIZA_INCLUDE_LIVE_E2E: "1",
        ELIZA_SAVE_TRAJECTORIES: "1",
        ELIZA_TRAJECTORY_DIR: trajDir,
        // Harvest wants gpt-5.5 only: blank ambient keys so the cli branch in the
        // app-core selectLiveProvider is chosen unambiguously.
        CEREBRAS_API_KEY: "",
        OPENAI_API_KEY: "",
      },
    },
  );
  writeFileSync(path.join(itemDir, "stdout.log"), res.stdout || "");
  writeFileSync(path.join(itemDir, "stderr.log"), res.stderr || "");

  const nativePath = path.join(itemDir, "native.jsonl");
  const rows = nativeExport(path.join(itemDir, "run"), nativePath);

  const out = `${res.stdout || ""}\n${res.stderr || ""}`;
  // The live-agent lanes eagerly import first-party plugins; in a dist-less
  // worktree Vite cannot resolve their entries (build the workspace first —
  // the nightly "real" lane does). Distinguish that environmental precondition
  // from a genuine test failure or a clean provider-gated skip.
  const buildBlocked = /Failed to resolve entry for package/i.test(out);
  const skipped =
    /No LLM provider|test\.skip|set ELIZA_LIVE_TEST/i.test(out) && rows === 0;
  const status = buildBlocked
    ? "blocked-workspace-build"
    : res.status === 0 && rows > 0
      ? "passed"
      : res.status === 0 && skipped
        ? "skipped-no-provider"
        : res.status === 0
          ? "passed-no-trajectory"
          : "failed";
  const notes = {
    "blocked-workspace-build":
      "live-agent lanes eagerly import first-party plugins; a dist-less worktree cannot resolve them. Run `bun run build` first (nightly real lane precondition). See BENCHMARK_E2E_README.md.",
    "skipped-no-provider":
      "e2e provider selector did not select a provider — see BENCHMARK_E2E_README.md.",
  };
  const verdict = {
    family: "e2e",
    lane: laneRel,
    provider: runEnv.ELIZA_CHAT_VIA_CLI
      ? `cli:${runEnv.ELIZA_CHAT_VIA_CLI}`
      : "api-key",
    model: runEnv.ELIZA_CLI_CODEX_MODEL ?? null,
    status,
    rows,
    exitCode: res.status,
    trajectoryFormat: "eliza_native_v1",
    note: notes[status],
  };
  writeVerdict(itemDir, verdict);
  return verdict;
}

/**
 * Write the per-item verdict. The canonical eliza_native_v1 manifest
 * (native.manifest.json) is written by the scenario-runner native-export itself,
 * so the driver does not duplicate it.
 */
function writeVerdict(itemDir, verdict) {
  writeFileSync(
    path.join(itemDir, "verdict.json"),
    JSON.stringify(verdict, null, 2),
  );
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main() {
  const provider = loadProviderEnv();
  const runEnv = withCliRunEnv(provider.env);
  mkdirSync(HARVEST_ROOT, { recursive: true });

  let corpus;
  if (FAMILY === "benchmark") {
    corpus = BENCHMARK_SCENARIOS.filter(
      (id) => !ITEM_FILTER || id === ITEM_FILTER,
    ).map((id) => ({ id }));
  } else if (FAMILY === "e2e") {
    corpus = E2E_HARVESTABLE_LANES.filter(
      (lane) => !LANE_FILTER || lane.includes(LANE_FILTER),
    ).map((lane) => ({ lane }));
  } else {
    throw new Error(`unknown --family ${FAMILY} (expected benchmark|e2e)`);
  }

  const summary = {
    startedAt: new Date().toISOString(),
    family: FAMILY,
    harvestRoot: HARVEST_ROOT,
    providerSource: provider.source,
    providerEnvKeys: Object.keys(runEnv),
    totalDiscovered: corpus.length,
    shard: `${SHARD_I}/${SHARD_N}`,
    dryRun: DRY_RUN,
    limit: LIMIT,
    items: [],
  };

  let ran = 0;
  for (let gi = 0; gi < corpus.length; gi += 1) {
    if (SHARD_N > 1 && gi % SHARD_N !== SHARD_I) continue;
    if (LIMIT && ran >= LIMIT) break;
    const item = corpus[gi];
    const id = item.id ?? item.lane;
    const itemDir =
      FAMILY === "benchmark"
        ? path.join(HARVEST_ROOT, "benchmark", BENCHMARK_SUITE, slug(id))
        : path.join(HARVEST_ROOT, "e2e", slug(id));
    if (RESUME && existsSync(path.join(itemDir, "verdict.json"))) {
      console.log(`[resume] skip (already harvested) ${FAMILY} :: ${id}`);
      continue;
    }
    ran += 1;
    if (DRY_RUN || DETERMINISTIC) {
      console.log(`[dry-run] would harvest ${FAMILY} :: ${id}`);
      summary.items.push({ item: id, gi, planned: true });
      continue;
    }
    console.log(`[harvest #${gi}] ${FAMILY} :: ${id}`);
    const verdict =
      FAMILY === "benchmark"
        ? runBenchmarkItem(id, runEnv)
        : runE2eItem(id, runEnv);
    summary.items.push(verdict);
    console.log(
      `[harvest]   → status=${verdict.status} rows=${verdict.rows} exit=${verdict.exitCode}`,
    );
  }

  summary.finishedAt = new Date().toISOString();
  summary.count = summary.items.length;
  const summaryPath = path.join(
    HARVEST_ROOT,
    `harvest-${FAMILY}-summary-${DRY_RUN || DETERMINISTIC ? "dryrun" : "run"}-${Date.now()}.json`,
  );
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  console.log(`\nsummary → ${summaryPath}`);
  console.log(
    `family=${FAMILY} items=${summary.count} provider=${provider.source}`,
  );
}

main();
