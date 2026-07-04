#!/usr/bin/env node
/**
 * gpt-5.5 trajectory-training pipeline — Stage 2 corpus manifest builder.
 *
 * Enumerates the ENTIRE elizaOS test/eval corpus and emits a machine-readable
 * manifest describing, per family, every item, the exact trajectory-emitting
 * run command, and where the trajectory lands. Consumed by harvest-runner.mjs.
 *
 * This does NOT run any scenario/benchmark/e2e. It only discovers + counts.
 *
 * Families:
 *   scenario   — @elizaos/scenario-runner drives a real AgentRuntime + PGLite.
 *                Emits eliza_native_v1 trajectories natively via --export-native.
 *   benchmark  — packages/benchmarks orchestrator (registry/commands.py).
 *                Emits per-benchmark result JSON today; eliza_native_v1 requires
 *                wiring the adapter runtime's trajectory recorder (see notes).
 *   e2e        — *.live.e2e.test.ts / *.real.e2e.test.ts vitest lanes that drive
 *                a real runtime. Trajectory capture requires ELIZA_SAVE_TRAJECTORIES
 *                + ELIZA_TRAJECTORY_DIR then native-export conversion (see notes).
 *
 * Usage:
 *   node scripts/training-harvest/build-manifest.mjs [--out <path>]
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listPackages } from "../../packages/scripts/lib/workspaces.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const PACKAGES = path.join(REPO_ROOT, "packages");

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/** Recursively count files matching a suffix under a dir. */
function countFiles(dir, suffix) {
  if (!existsSync(dir)) return [];
  const out = [];
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (entry.name.startsWith("_")) continue; // scenario loader skips these
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(suffix)) out.push(full);
    }
  };
  walk(dir);
  return out;
}

// Measured expansion multipliers (eliza-scenarios list --count-scenarios).
// `existing` = base scenario count, `total` = with persona/paraphrase expansion.
// Sampled live this run; embedded so the manifest is self-describing without a
// slow re-boot of the loader on every rebuild.
const MEASURED_EXPANSION = {
  "packages/test/scenarios": { existing: 707, total: 7777 },
  "plugins/plugin-personal-assistant/test/scenarios": {
    existing: 197,
    total: 2167,
  },
  "plugins/plugin-app-control/test/scenarios": { existing: 15, total: 165 },
  "plugins/plugin-health/test/scenarios": { existing: 8, total: 88 },
  "plugins/plugin-cloud-apps/test/scenarios": { existing: 1, total: 11 },
  "plugins/plugin-agent-orchestrator/test/scenarios": {
    existing: 8,
    total: 88,
  },
};

// The test-harness's canonical corpus root. It keeps scenarios directly under
// `scenarios/` (not `test/scenarios/`), so the per-package convention glob below
// does not reach it; include it explicitly. This is the scenario-runner's
// DEFAULT_SCENARIO_ROOT, a well-known path constant — not a plugin coupling.
const DEFAULT_SCENARIO_ROOT = "packages/test/scenarios";

// Every workspace package's `test/scenarios` dir that exists on disk, discovered
// through the shared workspace seam (#12332) rather than a hardcoded plugin list.
// `scenarioFamily` skips any dir with zero `.scenario.ts` files, so a package
// without scenarios contributes nothing — adding or removing a plugin with
// scenarios updates the corpus with no edit to this file.
const SCENARIO_DIRS = [
  DEFAULT_SCENARIO_ROOT,
  ...listPackages({ repoRoot: REPO_ROOT }).map((pkg) =>
    path.posix.join(pkg.dir, "test", "scenarios"),
  ),
]
  .filter((rel) => existsSync(path.join(REPO_ROOT, rel)))
  .filter((rel, index, all) => all.indexOf(rel) === index)
  .sort((a, b) => a.localeCompare(b));

const SCENARIO_CLI = "packages/scenario-runner/src/cli.ts";

function scenarioFamily() {
  const items = [];
  for (const rel of SCENARIO_DIRS) {
    const dir = path.join(REPO_ROOT, rel);
    const files = countFiles(dir, ".scenario.ts");
    if (files.length === 0) continue;
    const expansion = MEASURED_EXPANSION[rel] ?? {
      existing: files.length,
      total: files.length * 10,
    };
    items.push({
      id: rel.replace(/[/]/g, "__"),
      dir: rel,
      scenarioFiles: files.length,
      baseScenarios: expansion.existing,
      expandedScenarios: expansion.total,
      // The driver enumerates concrete scenario ids at run time via `list`.
      discover: {
        cmd: "bun",
        args: [
          "--conditions",
          "eliza-source",
          "--tsconfig-override",
          "<TSCONFIG>",
          SCENARIO_CLI,
          "list",
          rel,
        ],
        parse: "json-lines-scenario-ids",
      },
    });
  }
  return {
    kind: "scenario",
    emitsTrajectory: "native",
    trajectoryFormat: "eliza_native_v1",
    runnerCli: SCENARIO_CLI,
    tsconfig: "tsconfig.json",
    // <ID>, <REPORT>, <RUNDIR>, <NATIVE> are substituted per item by the driver.
    runInvocationTemplate: [
      "bun",
      "--conditions",
      "eliza-source",
      "--tsconfig-override",
      "<TSCONFIG>",
      SCENARIO_CLI,
      "run",
      "<DIR>",
      "--scenario",
      "<ID>",
      "--report",
      "<REPORT>",
      "--run-dir",
      "<RUNDIR>",
      "--export-native",
      "<NATIVE>",
    ],
    trajectoryLands: {
      report:
        "<RUNDIR>/report.json (or --report path): aggregate + per-scenario status",
      perTurn:
        "<RUNDIR>/trajectories/<agentId>/<trajId>.json (RecordedTrajectory)",
      native:
        "<NATIVE>: eliza_native_v1 JSONL (rows carry scenarioStatus + judgeScore)",
      manifest: "<NATIVE>.manifest.json",
    },
    verdictSource:
      "report .scenarios[].status === 'passed' | native row.scenarioStatus",
    providerSeam:
      "ELIZA_CHAT_VIA_CLI=codex → provider 'cli', model gpt-5.5, plugin @elizaos/plugin-cli-inference, reads ~/.codex/auth.json",
    items,
  };
}

function benchmarkFamily() {
  let adapters = [];
  let rawList = "";
  try {
    rawList = execFileSync(
      "python3",
      ["-m", "benchmarks.orchestrator", "list-benchmarks"],
      { cwd: PACKAGES, encoding: "utf8", timeout: 120000 },
    );
  } catch (err) {
    // list-benchmarks exits non-zero when there are "uncovered" benchmark
    // directories, but still prints the full adapter list to stdout. Use it.
    rawList = (err && err.stdout ? String(err.stdout) : "") || "";
  }
  for (const line of rawList.split("\n")) {
    const m = line.match(/^-\s+(\S+)\s+dir=(\S+)\s+cwd=(.+)$/);
    if (m) adapters.push({ id: m[1], dir: m[2], cwd: m[3].trim() });
  }
  if (adapters.length === 0)
    adapters = [
      { error: "orchestrator list-benchmarks produced no parseable adapters" },
    ];
  return {
    kind: "benchmark",
    emitsTrajectory: "wiring-needed",
    trajectoryFormat: "eliza_native_v1 (after wiring)",
    source: "packages/benchmarks/registry/commands.py",
    listCommand:
      "python3 -m benchmarks.orchestrator list-benchmarks (cwd=packages)",
    runInvocationTemplate:
      "python3 -m benchmarks.orchestrator run --benchmarks <ID> --provider cli --model gpt-5.5 (cwd=packages)",
    resultLands:
      "packages/benchmarks/benchmark_results/** (per-benchmark JSON; locate_result() in registry/commands.py). GITIGNORED.",
    trajectoryWiring:
      "The ~25 eliza-adapter-routed benchmarks boot a real AgentRuntime (serves /api/benchmark/message). Set ELIZA_SAVE_TRAJECTORIES=1 + ELIZA_TRAJECTORY_DIR=<dir> on the adapter runtime, then run packages/scenario-runner native-export over <dir> to convert RecordedTrajectory JSON → eliza_native_v1. Non-eliza-adapter benchmarks (standard/*, python-only) do NOT boot the runtime and cannot emit native trajectories.",
    providerSeam:
      "orchestrator --provider cli maps to ELIZA_CHAT_VIA_CLI=codex for eliza-adapter benchmarks; verify per-adapter provider plumbing before Stage 2.",
    adapterCount: adapters.filter((a) => a.id).length,
    adapters,
  };
}

function e2eFamily() {
  const roots = ["packages", "plugins"];
  const live = [];
  const walk = (d) => {
    if (!existsSync(d)) return;
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (
        entry.name.endsWith(".live.e2e.test.ts") ||
        entry.name.endsWith(".real.e2e.test.ts")
      )
        live.push(path.relative(REPO_ROOT, full));
    }
  };
  for (const r of roots) walk(path.join(REPO_ROOT, r));
  return {
    kind: "e2e",
    emitsTrajectory: "wiring-needed",
    trajectoryFormat: "eliza_native_v1 (after wiring)",
    runInvocationTemplate:
      "ELIZA_SAVE_TRAJECTORIES=1 ELIZA_TRAJECTORY_DIR=<dir> bun --conditions eliza-source vitest run <testFile>",
    trajectoryWiring:
      "These vitest lanes drive a real AgentRuntime via createScenarioRuntime/real-runtime helpers. The runtime's JsonFileTrajectoryRecorder writes RecordedTrajectory JSON when ELIZA_SAVE_TRAJECTORIES=1 + ELIZA_TRAJECTORY_DIR are set. Convert with scenario-runner native-export. Verdict = vitest pass/fail per file (coarser than per-scenario).",
    providerSeam:
      "Same ELIZA_CHAT_VIA_CLI=codex seam; the live-provider helper (packages/app-core/test/helpers/live-provider.ts) already recognizes CLI backends.",
    liveLaneCount: live.length,
    lanes: live.sort(),
    scriptedRealServices: [
      "packages/scenario-runner/scripts/real-llm-attachment-smoke.mjs",
      "packages/scenario-runner/scripts/real-service-audio-roundtrip.mjs",
      "packages/scenario-runner/scripts/real-service-voice-e2e.mjs",
    ],
  };
}

const manifest = {
  schema: "gpt55_harvest_manifest",
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  repoRoot: REPO_ROOT,
  goal: "Run every elizaOS scenario+benchmark+e2e through gpt-5.5 (Codex subscription), harvest correct eliza_native_v1 trajectories, GEPA-repair failures, fine-tune on Nebius.",
  provider: {
    mechanism:
      "ELIZA_CHAT_VIA_CLI CLI-subscription backend (packages/core/src/testing/live-provider.ts selectCliProvider)",
    backend: "codex",
    model: "gpt-5.5",
    modelOverrideEnv: "ELIZA_CLI_CODEX_MODEL",
    plugin: "@elizaos/plugin-cli-inference",
    credentialsPath:
      "~/.codex/auth.json (ChatGPT-OAuth; eliza never sees the token)",
    env: { ELIZA_CHAT_VIA_CLI: "codex", ELIZA_CLI_CODEX_MODEL: "gpt-5.5" },
    note: "Stage-1 leg S1 proves ONE real scenario through this seam live. The driver consumes S1's proven provider env verbatim.",
  },
  trajectoryFormat: {
    name: "eliza_native_v1",
    definedIn:
      "packages/core/src/services/trajectory-types.ts (ElizaNativeTrajectoryRow)",
    contract: "packages/training/docs/dataset/CANONICAL_RECORD.md",
    converter:
      "packages/scenario-runner/src/native-export.ts (exportScenarioNativeJsonl)",
    trainingPrep:
      "packages/training/scripts/prepare_eliza1_trajectory_dataset.py",
  },
  families: {
    scenario: scenarioFamily(),
    benchmark: benchmarkFamily(),
    e2e: e2eFamily(),
  },
};

const outPath = arg("--out", path.join(__dirname, "manifest.json"));
writeFileSync(outPath, JSON.stringify(manifest, null, 2));

const s = manifest.families.scenario;
const sBase = s.items.reduce((a, i) => a + i.baseScenarios, 0);
const sExp = s.items.reduce((a, i) => a + i.expandedScenarios, 0);
const sFiles = s.items.reduce((a, i) => a + i.scenarioFiles, 0);
process.stdout.write(
  `manifest → ${outPath}\n` +
    `scenario family: ${s.items.length} dirs, ${sFiles} files, ${sBase} base scenarios, ${sExp} expanded\n` +
    `benchmark family: ${manifest.families.benchmark.adapterCount} adapters\n` +
    `e2e family: ${manifest.families.e2e.liveLaneCount} live lanes\n`,
);
