/**
 * Pins the credentialed scenario authority's clean-checkout prerequisites,
 * source-export conditions, honest catalog ownership, and default trajectory
 * artifacts.
 */
import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listScenarioMetadata } from "../../scenario-runner/src/loader.ts";
import { main as auditScenarioCoverage } from "../check-scenario-workflow-coverage.mjs";
import { PLUGIN_ROUTE_COVERAGE } from "../e2e-coverage/manifest.ts";
import {
  evaluatePrerequisites,
  gateShardOutcomes,
  loadShard,
  resolveShardMatrix,
  verifyEvidence,
  writeOutcome,
} from "../live-scenario-contract.mjs";
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

// GitHub expression literals are assembled rather than written inline so the
// `${{` sequence is not read as a JS template placeholder.
const ghExpr = (body: string): string => `$\{{ ${body} }}`;

function exitingChild(
  code: number | null,
  signal: string | null = null,
): EventEmitter {
  const child = new EventEmitter();
  queueMicrotask(() => child.emit("exit", code, signal));
  return child;
}

test("pins an authoritative, bounded shard catalog", () => {
  const manifestPath = fileURLToPath(
    new URL("../live-scenario-shards.json", import.meta.url),
  );
  const { manifest, shard } = loadShard(manifestPath, "plugin-health");
  expect(manifest.authority).toBe(".github/workflows/live-scenarios.yml");
  expect(manifest.costCeiling).toMatchObject({
    maxConcurrentShards: 4,
    maxWorkflowMinutes: 330,
  });
  // Every shard's ceiling must stay inside the 6-hour GitHub-hosted job cap,
  // which is what the serial single-job lane could never satisfy.
  for (const entry of manifest.shards as { timeoutMinutes: number }[]) {
    expect(entry.timeoutMinutes).toBeGreaterThan(0);
    expect(entry.timeoutMinutes).toBeLessThanOrEqual(330);
  }
  expect(manifest.shards.map((entry: { id: string }) => entry.id)).toEqual([
    "lifeops-connectors",
    "plugin-health",
    "app-control",
    "scenario-runner-view-chat",
  ]);
  expect(shard.artifactContract).toEqual([
    "report",
    "matrix",
    "viewer",
    "native-jsonl",
    "native-manifest",
    "privacy-attestation",
    "logs",
  ]);
  const viewChatShard = manifest.shards.find(
    (entry: { id: string }) => entry.id === "scenario-runner-view-chat",
  );
  expect(viewChatShard).toMatchObject({
    root: "packages/scenario-runner/test/scenarios",
    scenarioIds: ["live-document-delete"],
  });
});

test("emits typed prerequisite outcomes without exposing secret values", () => {
  const shard = {
    id: "sample",
    root: "sample-root",
    artifactContract: ["report"],
    requiredSecrets: ["JUDGE_KEY"],
    requiredAnySecrets: [["MODEL_A", "MODEL_B"]],
  };
  const blocked = evaluatePrerequisites(shard, { MODEL_A: "top-secret" });
  expect(blocked).toEqual({
    status: "prerequisite_unavailable",
    missing: ["JUDGE_KEY"],
    missingAny: [],
  });
  const tempRoot = mkdtempSync(path.join(tmpdir(), "scenario-preflight-"));
  try {
    const outputPath = path.join(tempRoot, "outcome.json");
    writeOutcome({
      shard,
      result: blocked,
      outputPath,
      sha: "abc",
      runId: "123",
    });
    const serialized = readFileSync(outputPath, "utf8");
    expect(serialized).toContain("prerequisite_unavailable");
    expect(serialized).not.toContain("top-secret");
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("fails evidence verification when any contracted artifact is absent", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "scenario-evidence-"));
  const shard = {
    report: "artifacts/report.json",
    runDir: "artifacts/run",
  };
  try {
    for (const relative of [
      shard.report,
      `${shard.runDir}/matrix.json`,
      `${shard.runDir}/viewer/index.html`,
      `${shard.runDir}/native.jsonl`,
      `${shard.runDir}/native.manifest.json`,
      `${shard.runDir}/native.privacy-attestation.json`,
      `${shard.runDir}/runner.log`,
    ]) {
      const target = path.join(tempRoot, relative);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, "evidence");
    }
    expect(verifyEvidence(shard, tempRoot)).toEqual({
      status: "evidence_complete",
      missing: [],
    });
    rmSync(path.join(tempRoot, shard.runDir, "native.manifest.json"));
    expect(verifyEvidence(shard, tempRoot).status).toBe("evidence_incomplete");
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("keeps shard failures non-short-circuiting and enforces one aggregate result", () => {
  const workflow = readFileSync(workflowPath, "utf8");
  expect(workflow.match(/continue-on-error: true/g)).toHaveLength(3);
  expect(workflow).toContain("fail-fast: false");
  expect(workflow).toContain(
    `matrix: ${ghExpr("fromJSON(needs.plan.outputs.matrix)")}`,
  );
  expect(workflow).toContain(
    `timeout-minutes: ${ghExpr("matrix.timeout_minutes")}`,
  );
  expect(workflow).toContain("Enforce aggregate shard result");
  expect(workflow).toContain("if-no-files-found: error");
  expect(workflow).toContain(
    `live-scenario-contract.mjs verify "${ghExpr("matrix.shard")}"`,
  );
  expect(workflow).toContain("live-scenario-contract.mjs gate");
  // Per-shard artifact names must not collide across matrix legs, or the
  // aggregate gate cannot tell which shard published which evidence.
  expect(workflow).toContain(
    `name: live-scenario-report-${ghExpr("matrix.shard")}`,
  );
});

test("exempts the live lane from the zombie janitor's age+idle reaper", () => {
  const janitor = readFileSync(
    fileURLToPath(
      new URL(
        "../../../.github/workflows/actions-zombie-janitor.yml",
        import.meta.url,
      ),
    ),
    "utf8",
  );
  expect(janitor).toContain("'Live Scenarios'");
  expect(janitor).not.toContain("ElizaOS Cuttlefish");
  expect(janitor).not.toContain("ElizaOS OpenAgent E1");
});

test("fans every requested shard out of the manifest and rejects ambiguity", () => {
  const manifest = JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../live-scenario-shards.json", import.meta.url)),
      "utf8",
    ),
  );

  const scheduled = resolveShardMatrix(manifest, { EVENT_NAME: "schedule" });
  expect(
    scheduled.include.map((entry: { shard: string }) => entry.shard),
  ).toEqual([
    "lifeops-connectors",
    "plugin-health",
    "app-control",
    "scenario-runner-view-chat",
  ]);
  const viewChat = scheduled.include.find(
    (entry: { shard: string }) => entry.shard === "scenario-runner-view-chat",
  );
  expect(viewChat).toMatchObject({
    scenario_filter: "live-document-delete",
    lane_args: "--lane live-only",
  });
  expect(
    scheduled.include.find(
      (entry: { shard: string }) => entry.shard === "lifeops-connectors",
    ),
  ).toMatchObject({ lane_args: "", root: "packages/test/scenarios" });

  const manual = resolveShardMatrix(manifest, {
    EVENT_NAME: "workflow_dispatch",
    SCENARIO_SHARD: "lifeops-connectors",
    SCENARIO_FILTER: "app-control:settings-voice-toggle",
  });
  expect(manual.include).toHaveLength(1);
  expect(manual.include[0]).toMatchObject({
    shard: "app-control",
    scenario_filter: "app-control:settings-voice-toggle",
  });

  expect(() =>
    resolveShardMatrix(manifest, {
      EVENT_NAME: "workflow_dispatch",
      SCENARIO_SHARD: "all",
      SCENARIO_FILTER: "some-scenario",
    }),
  ).toThrow("'all' is ambiguous");
  expect(() =>
    resolveShardMatrix(manifest, {
      EVENT_NAME: "workflow_dispatch",
      SCENARIO_SHARD: "not-a-shard",
    }),
  ).toThrow("unknown scenario_shard");
});

test("reads a missing or failed shard outcome as a lane failure", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "scenario-gate-"));
  try {
    // Nested exactly as the download lays the shard's run directory out, to
    // pin that the gate finds the record by content and not by path depth.
    const write = (shard: string, status: string) => {
      const dir = path.join(
        tempRoot,
        `live-scenario-report-${shard}`,
        "scenario-runs",
        shard,
      );
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, "shard-outcome.json"),
        JSON.stringify({ shard, status }),
      );
    };
    write("plugin-health", "success");
    expect(gateShardOutcomes(["plugin-health"], tempRoot)).toEqual({
      status: "pass",
      failures: [],
    });
    // A shard reaped mid-run uploads nothing; that must not read as silence.
    expect(
      gateShardOutcomes(["plugin-health", "app-control"], tempRoot).failures,
    ).toEqual(["app-control=no-outcome-artifact"]);
    write("app-control", "failure");
    expect(
      gateShardOutcomes(["plugin-health", "app-control"], tempRoot).failures,
    ).toEqual(["app-control=failure"]);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("builds the dist-exported runtime packages before the scenario CLI starts", () => {
  const workflow = readFileSync(workflowPath, "utf8");
  const runStep = "- name: Run live scenarios";

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
  // One matrix leg, one source-conditions declaration: the per-shard roots now
  // come from the manifest instead of four hand-copied run steps.
  const sourceConditionEntries = [
    ...workflow.matchAll(/NODE_OPTIONS: "--conditions=eliza-source"/g),
  ];
  expect(sourceConditionEntries).toHaveLength(1);
  expect(workflow).toContain(`SCENARIO_ROOT: ${ghExpr("matrix.root")}`);
  expect(workflow).toContain(`SCENARIO_SHARD: ${ghExpr("matrix.shard")}`);
  expect(workflow).toContain(
    `SCENARIO_FILTER: ${ghExpr("matrix.scenario_filter")}`,
  );
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
  // The GPU/scenario retirement must stay owned by #16449. #16537 reworded the
  // guide from "tracked in #16449" to "must not close #16449" while keeping the
  // same tracking issue; assert the issue reference survives regardless of the
  // surrounding phrasing so a future reword can't silently drop the owner.
  expect(workflowReadme).toContain("#16449");
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
    // Plain reads, not toMatchObject with an asymmetric matcher: bun's
    // toMatchObject writes expect.stringContaining(...) INTO the received
    // object, and PLUGIN_ROUTE_COVERAGE is shared module state — the corrupted
    // entry then fails e2e-coverage.test.ts's written-reason gate later in the
    // same sweep process.
    const paEntry = PLUGIN_ROUTE_COVERAGE["plugin-personal-assistant"];
    expect(paEntry?.status).toBe("exempt");
    if (paEntry?.status !== "exempt") throw new Error("unreachable");
    expect(paEntry.reason).toContain("live-scenarios.yml");
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

test("accepts a backward-compatible shard-prefixed manual filter", () => {
  const plan = createLiveScenarioPlan({
    repoRoot: "/repo",
    env: {
      ELIZA_LIVE_TEST: "1",
      SCENARIO_SHARD: "app-control",
      SCENARIO_FILTER: "app-control:settings-voice-toggle",
    },
    argv: [],
    existsSync: () => true,
    mkdirSync: () => undefined,
  });

  expect(plan.args.slice(-2)).toEqual(["--scenario", "settings-voice-toggle"]);
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
