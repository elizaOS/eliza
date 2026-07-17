/**
 * Pins the credentialed scenario authority's clean-checkout prerequisites,
 * source-export conditions, honest catalog ownership, and default trajectory
 * artifacts.
 */
import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listScenarioMetadata } from "../../scenario-runner/src/loader.ts";
import { main as auditScenarioCoverage } from "../check-scenario-workflow-coverage.mjs";
import { PLUGIN_ROUTE_COVERAGE } from "../e2e-coverage/manifest.ts";
import {
  createLiveScenarioPlan,
  main as runLiveScenarios,
} from "../run-live-scenarios.mjs";

const workflowPath = fileURLToPath(
  new URL("../../../.github/workflows/live-scenarios.yml", import.meta.url),
);
const agentPackagePath = fileURLToPath(
  new URL("../../agent/package.json", import.meta.url),
);
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const coverageAuditPath = fileURLToPath(
  new URL("../check-scenario-workflow-coverage.mjs", import.meta.url),
);
const workflowReadmePath = fileURLToPath(
  new URL("../../../.github/workflows/README.md", import.meta.url),
);
const defaultScenarioRoot = fileURLToPath(
  new URL("../../test/scenarios/", import.meta.url),
);

function captureLogger(): {
  logger: {
    log(message: string): void;
    warn(message: string): void;
    error(message: string): void;
  };
  messages: { log: string[]; warn: string[]; error: string[] };
} {
  const messages = {
    log: [] as string[],
    warn: [] as string[],
    error: [] as string[],
  };
  return {
    logger: {
      log: (message) => messages.log.push(message),
      warn: (message) => messages.warn.push(message),
      error: (message) => messages.error.push(message),
    },
    messages,
  };
}

function exitingChild(
  code: number | null,
  signal: string | null = null,
): EventEmitter {
  const child = new EventEmitter();
  queueMicrotask(() => child.emit("exit", code, signal));
  return child;
}

test("builds the dist-exported runtime packages before the scenario CLI starts", () => {
  const workflow = readFileSync(workflowPath, "utf8");
  const runStep = "- name: Run EA + connector live scenarios";

  expect(workflow).toMatch(
    /package_dirs=\([\s\S]*plugins\/plugin-local-inference[\s\S]*plugins\/plugin-app-control[\s\S]*plugins\/plugin-health[\s\S]*\)[\s\S]*for package_dir in "\$\{package_dirs\[@\]\}"/,
  );
  expect(workflow).toMatch(
    /package_dirs=\([\s\S]*plugins\/plugin-blocker[\s\S]*\)[\s\S]*for package_dir in "\$\{package_dirs\[@\]\}"/,
  );
  expect(workflow.indexOf("package_dirs=(")).toBeLessThan(
    workflow.indexOf(runStep),
  );
});

test("runs every live scenario root against workspace source exports", () => {
  const workflow = readFileSync(workflowPath, "utf8");
  const sourceConditionEntries = [
    ...workflow.matchAll(/NODE_OPTIONS: "--conditions=eliza-source"/g),
  ];
  expect(sourceConditionEntries).toHaveLength(3);
  expect(
    workflow.match(
      /if: \$\{\{ !cancelled\(\) && steps\.build\.outcome == 'success' && !inputs\.scenario_filter \}\}/g,
    ),
  ).toHaveLength(2);
});

test("includes the dynamically loaded app manager in the agent build graph", () => {
  const packageJson = JSON.parse(readFileSync(agentPackagePath, "utf8")) as {
    dependencies?: Record<string, string>;
  };
  expect(packageJson.dependencies?.["@elizaos/plugin-app-manager"]).toBe(
    "workspace:*",
  );
});

test("keeps retired no-op workflow entry points absent", () => {
  for (const workflow of ["gpu-bench-nightly.yml", "scenario-matrix.yml"]) {
    expect(existsSync(path.join(repoRoot, ".github/workflows", workflow))).toBe(
      false,
    );
  }

  const auditSource = readFileSync(coverageAuditPath, "utf8");
  expect(auditSource).not.toContain("ELIZA_SCENARIO_MATRIX_ENABLED");
  expect(auditSource).not.toContain("scenario-matrix.yml");

  const workflowReadme = readFileSync(workflowReadmePath, "utf8");
  expect(workflowReadme).toContain("tracked in #16449");
  expect(workflowReadme).not.toContain("packages/inference/voice-bench");
});

test("reports uncovered live-only scenarios as explicit deferrals", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "scenario-coverage-"));
  const reportDir = path.join(tempRoot, "report");
  try {
    expect(auditScenarioCoverage(["--report-dir", reportDir])).toBe(0);
    const summary = JSON.parse(
      readFileSync(path.join(reportDir, "workflow-coverage.json"), "utf8"),
    ) as {
      deferredLiveOnlyDefaultCount: number;
      deferredDefaultReasons: Record<string, string>;
      missingDefaultIds: string[];
    };
    expect(summary.missingDefaultIds).toEqual([]);
    expect(summary.deferredLiveOnlyDefaultCount).toBeGreaterThan(0);
    expect(Object.values(summary.deferredDefaultReasons)).toContainEqual(
      expect.stringContaining("#16448"),
    );
    expect(PLUGIN_ROUTE_COVERAGE["plugin-personal-assistant"]).toMatchObject({
      status: "exempt",
      reason: expect.stringContaining("live-scenarios.yml"),
    });
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}, 30_000);

test("discovers the orchestrator live evidence in the scheduled catalog", async () => {
  const metadata = await listScenarioMetadata(
    defaultScenarioRoot,
    undefined,
    undefined,
    false,
    "live-only",
  );
  const orchestratorEvidence = metadata.filter((entry) =>
    [
      "orchestrator.grilling-happy-path",
      "orchestrator.origin-routing-live",
    ].includes(entry.id),
  );

  expect(orchestratorEvidence.map((entry) => entry.id).sort()).toEqual([
    "orchestrator.grilling-happy-path",
    "orchestrator.origin-routing-live",
  ]);
}, 15_000);

test("builds the native trajectory export into the child invocation by default", () => {
  const plan = createLiveScenarioPlan({
    repoRoot: "/repo",
    env: {
      ELIZA_LIVE_TEST: "1",
      REPORT_PATH: "/evidence/report.json",
      RUN_DIR: "/evidence/run",
      SCENARIO_FILTER: "orchestrator.origin-routing-live",
    },
    argv: ["--list"],
    existsSync: () => true,
    mkdirSync: () => undefined,
  });

  expect(plan.args).toContain("--export-native");
  expect(plan.args).toContain("/evidence/run/native.jsonl");
  expect(plan.args.slice(-3)).toEqual([
    "--list",
    "--scenario",
    "orchestrator.origin-routing-live",
  ]);
  expect(plan.childEnv.LIFEOPS_LIVE_JUDGE_MIN_SCORE).toBe("0.8");
});

test("fails configuration before spawn when an intentional skip has no reason", async () => {
  const { logger, messages } = captureLogger();
  const exitCode = await runLiveScenarios({
    repoRoot: "/repo",
    env: { ELIZA_LIVE_TEST: "1", SCENARIO_SKIP: "connector.*" },
    argv: [],
    existsSync: () => true,
    mkdirSync: () => undefined,
    logger,
  });

  expect(exitCode).toBe(2);
  expect(messages.error.join("\n")).toContain("requires SKIP_REASON");
});

test("preserves enforced failures and makes explicitly non-blocking runs green", async () => {
  const enforced = captureLogger();
  const common = {
    repoRoot: "/repo",
    argv: [],
    existsSync: () => true,
    mkdirSync: () => undefined,
  };
  const enforcedCode = await runLiveScenarios({
    ...common,
    env: {
      ELIZA_LIVE_TEST: "1",
      CEREBRAS_API_KEY: "judge-key",
      SKIP_REASON: "scoped exact-head evidence run",
    },
    logger: enforced.logger,
    spawnImpl: () => exitingChild(7),
  });
  expect(enforcedCode).toBe(7);
  expect(enforced.messages.log.join("\n")).toContain("judge=independent");

  const nonBlocking = captureLogger();
  const nonBlockingCode = await runLiveScenarios({
    ...common,
    env: {
      ELIZA_LIVE_TEST: "1",
      SCENARIO_ENFORCE_GATE: "0",
    },
    logger: nonBlocking.logger,
    spawnImpl: () => exitingChild(7),
  });
  expect(nonBlockingCode).toBe(0);
  expect(nonBlocking.messages.warn.join("\n")).toContain("non-blocking");
});

test("maps a signalled child and a spawn error to observable failures", async () => {
  const common = {
    repoRoot: "/repo",
    env: { ELIZA_LIVE_TEST: "1" },
    argv: [],
    existsSync: () => true,
    mkdirSync: () => undefined,
  };
  const signalled = captureLogger();
  expect(
    await runLiveScenarios({
      ...common,
      logger: signalled.logger,
      spawnImpl: () => exitingChild(null, "SIGTERM"),
    }),
  ).toBe(1);
  expect(signalled.messages.error.join("\n")).toContain("SIGTERM");

  const spawnFailure = captureLogger();
  expect(
    await runLiveScenarios({
      ...common,
      logger: spawnFailure.logger,
      spawnImpl: () => {
        throw new Error("spawn unavailable");
      },
    }),
  ).toBe(1);
  expect(spawnFailure.messages.error.join("\n")).toContain("spawn unavailable");
});
