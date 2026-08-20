/**
 * Behavioral coverage for the scenario-runner CLI contract. The tests load
 * real temporary scenario files through the loader, then inject the runtime
 * boundary so exit-code, filtering, skip-policy, and artifact-plumbing
 * semantics stay deterministic and cheap enough for the unit lane.
 */

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ScenarioDefinition } from "@elizaos/scenario-runner/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CliDependencies,
  CliUsageError,
  parseArgs,
  providerQualifiedRunFailure,
  resolveRunExecutionProfile,
  runCli,
} from "./cli.ts";
import {
  buildAggregate as buildAggregateReport,
  writeReport as writeReportToDisk,
  writeScenarioRunViewer as writeScenarioRunViewerToDisk,
} from "./reporter.ts";
import { scenarioLiveProviderPreflightProblems } from "./runtime-factory.ts";
import type { AggregateReport, ScenarioReport } from "./types.ts";

const ENV_KEYS = [
  "ELIZA_TRAJECTORY_DIR",
  "ELIZA_TRAJECTORY_LOGGING",
  "ELIZA_LIFEOPS_RUN_DIR",
  "ELIZA_LIFEOPS_RUN_ID",
  "ELIZA_LIFEOPS_SCENARIO_ID",
  "LIFEOPS_LIVE_JUDGE_MIN_SCORE",
  "OPENAI_API_KEY",
  "CEREBRAS_API_KEY",
  "SCENARIO_JUDGE_REQUIRE_INDEPENDENT",
  "SKIP_REASON",
] as const;
const DETERMINISTIC_PROVIDER_NAME = "deterministic-model-provider" as const;

function writeScenario(
  dir: string,
  id: string,
  overrides: Partial<ScenarioDefinition> = {},
): void {
  writeFileSync(
    path.join(dir, `${id}.scenario.ts`),
    `export default ${JSON.stringify({
      id,
      title: id,
      domain: "cli-test",
      lane: "pr-deterministic",
      turns: [],
      ...overrides,
    })};\n`,
  );
}

function scenarioReport(
  id: string,
  status: ScenarioReport["status"],
): ScenarioReport {
  return {
    id,
    title: id,
    domain: "cli-test",
    tags: [],
    status,
    ...(status === "skipped" ? { skipReason: "dependency unavailable" } : {}),
    durationMs: 1,
    turns: [],
    finalChecks: [],
    actionsCalled: [],
    failedAssertions:
      status === "failed" ? [{ label: "unit", detail: "forced failure" }] : [],
    providerName: "unit-test",
  };
}

function qualifiedScenarioReport(id: string): ScenarioReport {
  const sha256 = "a".repeat(64);
  return {
    ...scenarioReport(id, "passed"),
    executionProfile: "provider-qualified",
    judgeScore: 0.9,
    finalChecks: [
      {
        label: "provider effect",
        type: "providerEffectObserved",
        status: "passed",
        detail: "independent provider readback matched",
      },
    ],
    evidence: {
      schemaVersion: 1,
      executionProfile: "provider-qualified",
      qualification: {
        status: "qualified",
        publishable: true,
        reasons: [],
      },
      observerProvenance: [
        {
          observerId: "observer-1",
          kind: "provider-api",
          implementation: "unit-observer",
          version: "1",
          environment: "unit",
          configurationSha256: sha256,
        },
      ],
      trajectoryHashes: [
        {
          trajectoryId: "trajectory-1",
          relativePath: "trajectories/trajectory-1.json",
          sha256,
          recorder: {
            implementation: "unit-recorder",
            version: "1",
            environment: "unit",
          },
        },
      ],
      observations: [
        {
          observationId: "observation-1",
          kind: "provider-effect",
          observedAtIso: "2026-07-28T00:00:01.000Z",
          observerId: "observer-1",
          source: {
            kind: "provider-api",
            system: "unit-provider",
            environment: "unit",
            recordIdSha256: sha256,
            accountRefSha256: sha256,
          },
          payloadSha256: sha256,
          trajectoryRefs: [
            {
              trajectoryId: "trajectory-1",
              stageId: "stage-1",
              sha256,
            },
          ],
          provider: "unit-provider",
          operation: "create",
          accountRefSha256: sha256,
          requestSha256: sha256,
          responseSha256: sha256,
          providerReceiptIdSha256: sha256,
          readbackSha256: sha256,
        },
      ],
    },
  };
}

function aggregateReport(
  reports: ScenarioReport[],
  providerName: string | null,
  startedAtIso: string,
  completedAtIso: string,
  runId: string,
): AggregateReport {
  const totals = reports.reduce(
    (acc, report) => {
      acc[report.status] += 1;
      return acc;
    },
    { passed: 0, failed: 0, skipped: 0 },
  );
  return {
    runId,
    startedAtIso,
    completedAtIso,
    providerName,
    executionProfile: null,
    scenarios: reports,
    // CLI fixtures carry no evidence blocks, so every scenario is honestly
    // unreported — mirrors what aggregateEvidence derives for them.
    evidenceSummary: {
      reportedScenarioCount: 0,
      unreportedScenarioCount: reports.length,
      qualificationCounts: {
        qualified: 0,
        unqualified: 0,
        ineligible: 0,
      },
      publishableScenarioCount: 0,
      observationCounts: {
        "durable-approval": 0,
        "durable-draft": 0,
        "provider-effect": 0,
        "provider-no-effect": 0,
        "scheduled-task": 0,
      },
    },
    totals: {
      ...totals,
      costUsd: 0,
      finalChecksSkipped: 0,
    },
    totalCount: reports.length,
    passedCount: totals.passed,
    failedCount: totals.failed,
    skippedCount: totals.skipped,
    totalCostUsd: 0,
  };
}

function createDependencies(
  resolveStatus: (id: string) => ScenarioReport["status"],
  overrides: Partial<CliDependencies> = {},
): CliDependencies {
  return {
    availableProviderNames: vi.fn(() => ["unit-test"]),
    shouldUseDeterministicModel: vi.fn(() => true),
    scenarioLiveProviderPreflightProblems: vi.fn(() => []),
    createScenarioRuntime: vi.fn(async () => ({
      runtime: {} as never,
      pgliteDir: tmpdir(),
      executionProfile: "simulated" as const,
      registeredPluginPackages: [],
      providerName: DETERMINISTIC_PROVIDER_NAME,
      providerConfig: {
        name: DETERMINISTIC_PROVIDER_NAME,
        env: {},
        pluginPackage: null,
      },
      cleanup: vi.fn(async () => undefined),
    })),
    runScenario: vi.fn(async (scenario) =>
      scenarioReport(scenario.id, resolveStatus(scenario.id)),
    ),
    buildAggregate: vi.fn(aggregateReport),
    printStdoutSummary: vi.fn(),
    writeReport: vi.fn(),
    writeReportBundle: vi.fn(),
    writeScenarioRunViewer: vi.fn(),
    exportScenarioNativeJsonl: vi.fn(),
    ...overrides,
  };
}

describe("scenario-runner CLI", () => {
  let tempDir: string;
  let stdout = "";
  let stderr = "";
  let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>>;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "scenario-runner-cli-"));
    stdout = "";
    stderr = "";
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdout += String(chunk);
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr += String(chunk);
      return true;
    });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    vi.restoreAllMocks();
  });

  it("parses run filters and provider selection, rejecting invalid values", () => {
    const parsed = parseArgs([
      "run",
      tempDir,
      "--scenario",
      "alpha,beta",
      "--lane",
      "pr-deterministic",
      "--provider",
      "cli",
      "nested/*.scenario.ts",
    ]);

    expect(parsed.command).toBe("run");
    expect(parsed.dir).toBe(path.resolve(tempDir));
    expect([...(parsed.filter ?? [])]).toEqual(["alpha", "beta"]);
    expect(parsed.lane).toBe("pr-deterministic");
    expect(parsed.provider).toBe("cli");
    expect(parsed.fileGlobs).toEqual(["nested/*.scenario.ts"]);
    expect(() => parseArgs(["list", tempDir, "--lane", "bad-lane"])).toThrow(
      CliUsageError,
    );
    expect(() =>
      parseArgs(["run", tempDir, "--provider", "not-a-provider"]),
    ).toThrow(CliUsageError);
  });

  it("passes the requested live provider to runtime construction", async () => {
    writeScenario(tempDir, "provider-selected", { lane: "live-only" });
    const createScenarioRuntime = vi.fn(
      createDependencies(() => "passed").createScenarioRuntime,
    );
    const dependencies = createDependencies(() => "passed", {
      availableProviderNames: vi.fn(() => ["anthropic"]),
      shouldUseDeterministicModel: vi.fn(() => false),
      createScenarioRuntime,
    });

    await expect(
      runCli(["run", tempDir, "--provider", "anthropic"], dependencies),
    ).resolves.toBe(0);
    expect(createScenarioRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ preferredProvider: "anthropic" }),
    );
  });

  it("fails before runtime construction when a requested provider is unavailable or deterministic mode is enabled", async () => {
    writeScenario(tempDir, "provider-preflight", { lane: "live-only" });
    const createScenarioRuntime = vi.fn();

    await expect(
      runCli(
        ["run", tempDir, "--provider", "anthropic"],
        createDependencies(() => "passed", {
          availableProviderNames: vi.fn(() => ["openai"]),
          shouldUseDeterministicModel: vi.fn(() => false),
          createScenarioRuntime,
        }),
      ),
    ).resolves.toBe(2);
    expect(stderr).toContain("requested provider anthropic is unavailable");
    expect(createScenarioRuntime).not.toHaveBeenCalled();

    stderr = "";
    await expect(
      runCli(
        ["run", tempDir, "--provider", "openai"],
        createDependencies(() => "passed", {
          availableProviderNames: vi.fn(() => ["openai"]),
          shouldUseDeterministicModel: vi.fn(() => true),
          createScenarioRuntime,
        }),
      ),
    ).resolves.toBe(2);
    expect(stderr).toContain(
      "cannot be combined with deterministic model mode",
    );
    expect(createScenarioRuntime).not.toHaveBeenCalled();
  });

  it.each([
    [undefined, "missing"],
    ["   ", "blank"],
  ] as const)(
    "fails before runtime construction when the requested provider credential is %s",
    async (openaiKey) => {
      writeScenario(tempDir, "provider-exact-key", { lane: "live-only" });
      const createScenarioRuntime = vi.fn();
      process.env.CEREBRAS_API_KEY = "judge-key";
      process.env.SCENARIO_JUDGE_REQUIRE_INDEPENDENT = "1";
      if (openaiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = openaiKey;

      await expect(
        runCli(
          ["run", tempDir, "--provider", "openai"],
          createDependencies(() => "passed", {
            availableProviderNames: vi.fn(() => ["openai"]),
            shouldUseDeterministicModel: vi.fn(() => false),
            scenarioLiveProviderPreflightProblems,
            createScenarioRuntime,
          }),
        ),
      ).resolves.toBe(2);
      expect(stderr).toContain("--provider openai requires OPENAI_API_KEY");
      expect(createScenarioRuntime).not.toHaveBeenCalled();
    },
  );

  it("fails before runtime construction when acting and judge identities match", async () => {
    writeScenario(tempDir, "provider-independent-judge", {
      lane: "live-only",
    });
    const createScenarioRuntime = vi.fn();

    await expect(
      runCli(
        ["run", tempDir, "--provider", "openai"],
        createDependencies(() => "passed", {
          availableProviderNames: vi.fn(() => ["openai"]),
          shouldUseDeterministicModel: vi.fn(() => false),
          scenarioLiveProviderPreflightProblems: vi.fn(() => [
            "acting provider cerebras cannot also be the independent judge provider",
          ]),
          createScenarioRuntime,
        }),
      ),
    ).resolves.toBe(2);
    expect(stderr).toContain("cannot also be the independent judge provider");
    expect(createScenarioRuntime).not.toHaveBeenCalled();
  });

  it("forwards declared plugins to a simulated scenario runtime", async () => {
    writeScenario(tempDir, "maps-live", {
      lane: "live-only",
      requires: {
        plugins: ["@elizaos/plugin-maps"],
        services: ["activity_tracker"],
        workers: ["PROACTIVE_AGENT", "LIFEOPS_SCHEDULER"],
      },
    });
    const createScenarioRuntime = vi.fn(async () => ({
      runtime: {} as never,
      pgliteDir: tmpdir(),
      executionProfile: "simulated" as const,
      registeredPluginPackages: ["@elizaos/plugin-maps"],
      providerName: DETERMINISTIC_PROVIDER_NAME,
      providerConfig: {
        name: DETERMINISTIC_PROVIDER_NAME,
        env: {},
        pluginPackage: null,
      },
      cleanup: vi.fn(async () => undefined),
    }));
    const dependencies = createDependencies(() => "passed", {
      createScenarioRuntime,
    });

    await expect(
      runCli(["run", tempDir, "--lane", "live-only"], dependencies),
    ).resolves.toBe(0);
    expect(createScenarioRuntime).toHaveBeenCalledWith({
      executionProfile: "simulated",
      requiredPlugins: ["@elizaos/plugin-maps"],
      requiredServices: ["activity_tracker"],
      backgroundWorkers: ["PROACTIVE_AGENT", "LIFEOPS_SCHEDULER"],
    });
  });

  it("rejects mixed or multi-scenario provider-qualified runs before runtime creation", async () => {
    expect(() =>
      resolveRunExecutionProfile([
        {
          id: "simulated",
          title: "simulated",
          domain: "cli-test",
          turns: [],
        },
        {
          id: "qualified",
          title: "qualified",
          domain: "cli-test",
          lane: "live-only",
          executionProfile: "provider-qualified",
          turns: [],
        },
      ]),
    ).toThrow(/cannot mix simulated and provider-qualified/);

    writeScenario(tempDir, "qualified-one", {
      lane: "live-only",
      executionProfile: "provider-qualified",
    });
    writeScenario(tempDir, "qualified-two", {
      lane: "live-only",
      executionProfile: "provider-qualified",
    });
    const createScenarioRuntime = vi.fn();
    const dependencies = createDependencies(() => "passed", {
      createScenarioRuntime,
    });

    await expect(runCli(["run", tempDir], dependencies)).resolves.toBe(2);
    expect(stderr).toContain("exactly one scenario per process");
    expect(createScenarioRuntime).not.toHaveBeenCalled();
  });

  it("wires a single provider-qualified scenario but refuses caller-fabricated qualification", async () => {
    writeScenario(tempDir, "qualified-one", {
      lane: "live-only",
      executionProfile: "provider-qualified",
      requires: { plugins: ["@elizaos/plugin-personal-assistant"] },
    });
    const runDir = path.join(tempDir, "qualified-run");
    const nativePath = path.join(tempDir, "fabricated-qualified.jsonl");
    const reportPath = path.join(tempDir, "fabricated-qualified-report.json");
    const cleanup = vi.fn(async () => undefined);
    const persistedWrites: AggregateReport[] = [];
    const createScenarioRuntime = vi.fn(async () => ({
      runtime: {} as never,
      pgliteDir: tmpdir(),
      executionProfile: "provider-qualified" as const,
      registeredPluginPackages: ["@elizaos/plugin-personal-assistant"],
      providerName: "openai" as const,
      providerConfig: {
        name: "openai" as const,
        apiKey: "unit-test-key",
        baseUrl: "https://api.openai.example/v1",
        smallModel: "unit-small",
        largeModel: "unit-large",
        env: {},
        pluginPackage: "@elizaos/plugin-openai",
      },
      cleanup,
    }));
    const dependencies = createDependencies(() => "passed", {
      shouldUseDeterministicModel: vi.fn(() => false),
      createScenarioRuntime,
      runScenario: vi.fn(async (scenario) =>
        qualifiedScenarioReport(scenario.id),
      ),
      buildAggregate: buildAggregateReport,
      writeReport: vi.fn((report, filePath) => {
        persistedWrites.push(structuredClone(report));
        writeReportToDisk(report, filePath);
      }),
    });

    await expect(
      runCli(
        [
          "run",
          tempDir,
          "--run-dir",
          runDir,
          "--export-native",
          nativePath,
          "--report",
          reportPath,
        ],
        dependencies,
      ),
    ).resolves.toBe(1);
    expect(createScenarioRuntime).toHaveBeenCalledWith({
      executionProfile: "provider-qualified",
      requiredPlugins: ["@elizaos/plugin-personal-assistant"],
      requiredServices: [],
      backgroundWorkers: [],
    });
    expect(dependencies.runScenario).toHaveBeenCalledWith(
      expect.objectContaining({ id: "qualified-one" }),
      expect.anything(),
      expect.objectContaining({
        executionProfile: "provider-qualified",
        runDir,
      }),
    );
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(dependencies.exportScenarioNativeJsonl).not.toHaveBeenCalled();
    expect(stderr).toContain("no external controller decision");
    expect(persistedWrites.length).toBeGreaterThan(0);
    expect(
      persistedWrites.every(
        (report) => report.evidenceSummary.publishableScenarioCount === 0,
      ),
    ).toBe(true);
    expect(JSON.stringify(persistedWrites)).not.toContain('"publishable":true');
    const persisted = JSON.parse(
      readFileSync(reportPath, "utf8"),
    ) as AggregateReport;
    expect(persisted.evidenceSummary).toMatchObject({
      publishableScenarioCount: 0,
      qualificationCounts: {
        qualified: 0,
        unqualified: 1,
        ineligible: 0,
      },
    });
    expect(persisted.scenarios[0]?.evidence?.qualification).toEqual({
      status: "unqualified",
      publishable: false,
      reasons: ["external-controller-decision:missing"],
    });
  });

  it("rejects serializer substitution before report or viewer persistence", async () => {
    writeScenario(tempDir, "qualified-serializer", {
      lane: "live-only",
      executionProfile: "provider-qualified",
    });
    const runDir = path.join(tempDir, "qualified-serializer-run");
    const reportPath = path.join(tempDir, "qualified-serializer-report.json");
    const forged = qualifiedScenarioReport("qualified-serializer");
    const forgedSerialization = structuredClone(forged);
    Object.defineProperty(forged, "toJSON", {
      enumerable: true,
      value: () => forgedSerialization,
    });
    const writeReport = vi.fn(writeReportToDisk);
    const writeScenarioRunViewer = vi.fn(writeScenarioRunViewerToDisk);
    const dependencies = createDependencies(() => "passed", {
      shouldUseDeterministicModel: vi.fn(() => false),
      createScenarioRuntime: vi.fn(async () => ({
        runtime: {} as never,
        pgliteDir: tmpdir(),
        executionProfile: "provider-qualified" as const,
        registeredPluginPackages: [],
        providerName: "openai" as const,
        providerConfig: {
          name: "openai" as const,
          apiKey: "unit-test-key",
          baseUrl: "https://api.openai.example/v1",
          smallModel: "unit-small",
          largeModel: "unit-large",
          env: {},
          pluginPackage: "@elizaos/plugin-openai",
        },
        cleanup: vi.fn(async () => undefined),
      })),
      runScenario: vi.fn(async () => forged),
      buildAggregate: buildAggregateReport,
      writeReport,
      writeScenarioRunViewer,
    });

    await expect(
      runCli(
        ["run", tempDir, "--run-dir", runDir, "--report", reportPath],
        dependencies,
      ),
    ).rejects.toThrow(/scenarioReport\.toJSON.*executable or non-JSON data/);
    expect(writeReport).not.toHaveBeenCalled();
    expect(writeScenarioRunViewer).not.toHaveBeenCalled();
    expect(existsSync(reportPath)).toBe(false);
    expect(existsSync(path.join(runDir, "viewer", "data.js"))).toBe(false);
  });

  it("fails and withholds native export when a provider run merely passes without qualification", async () => {
    writeScenario(tempDir, "unqualified", {
      lane: "live-only",
      executionProfile: "provider-qualified",
    });
    const runDir = path.join(tempDir, "unqualified-run");
    const nativePath = path.join(tempDir, "unqualified.jsonl");
    const dependencies = createDependencies(() => "passed", {
      shouldUseDeterministicModel: vi.fn(() => false),
      createScenarioRuntime: vi.fn(async () => ({
        runtime: {} as never,
        pgliteDir: tmpdir(),
        executionProfile: "provider-qualified" as const,
        registeredPluginPackages: [],
        providerName: "openai" as const,
        providerConfig: {
          name: "openai" as const,
          apiKey: "unit-test-key",
          baseUrl: "https://api.openai.example/v1",
          smallModel: "unit-small",
          largeModel: "unit-large",
          env: {},
          pluginPackage: "@elizaos/plugin-openai",
        },
        cleanup: vi.fn(async () => undefined),
      })),
    });

    await expect(
      runCli(
        ["run", tempDir, "--run-dir", runDir, "--export-native", nativePath],
        dependencies,
      ),
    ).resolves.toBe(1);
    expect(stderr).toContain("no external controller decision");
    expect(dependencies.exportScenarioNativeJsonl).not.toHaveBeenCalled();
    expect(
      providerQualifiedRunFailure([scenarioReport("unqualified", "passed")]),
    ).toContain("no external controller decision");
  });

  it("requires retained trajectories before constructing a provider-qualified runtime", async () => {
    writeScenario(tempDir, "qualified-no-artifacts", {
      lane: "live-only",
      executionProfile: "provider-qualified",
    });
    const createScenarioRuntime = vi.fn();
    const dependencies = createDependencies(() => "passed", {
      createScenarioRuntime,
    });

    await expect(runCli(["run", tempDir], dependencies)).resolves.toBe(2);
    expect(stderr).toContain("requires --run-dir or --export-native");
    expect(createScenarioRuntime).not.toHaveBeenCalled();
  });

  it("lists only scenarios in the requested lane", async () => {
    writeScenario(tempDir, "cli-pr", { lane: "pr-deterministic" });
    writeScenario(tempDir, "cli-live", { lane: "live-only" });

    const code = await runCli(["list", tempDir, "--lane", "live-only"]);

    expect(code).toBe(0);
    expect(stdout.trim()).toBe("cli-live");
  });

  it("returns exit 0 for passing scenarios and exit 1 for failed scenarios", async () => {
    writeScenario(tempDir, "cli-pass");
    writeScenario(tempDir, "cli-fail");
    const dependencies = createDependencies((id) =>
      id === "cli-fail" ? "failed" : "passed",
    );

    await expect(
      runCli(["run", tempDir, "--scenario", "cli-pass"], dependencies),
    ).resolves.toBe(0);
    await expect(
      runCli(["run", tempDir, "--scenario", "cli-fail"], dependencies),
    ).resolves.toBe(1);
    expect(dependencies.runScenario).toHaveBeenCalledTimes(2);
  });

  it("returns exit 2 when a scenario skips without SKIP_REASON", async () => {
    writeScenario(tempDir, "cli-skip");
    const dependencies = createDependencies(() => "skipped");

    const code = await runCli(["run", tempDir], dependencies);

    expect(code).toBe(2);
    expect(stderr).toContain("skipped without SKIP_REASON");
  });

  it("allows skipped scenarios when SKIP_REASON documents the skip", async () => {
    process.env.SKIP_REASON = "unit test intentionally skips";
    writeScenario(tempDir, "cli-skip");
    const dependencies = createDependencies(() => "skipped");

    const code = await runCli(["run", tempDir], dependencies);

    expect(code).toBe(0);
    expect(stderr).not.toContain("skipped without SKIP_REASON");
  });

  it("fails loudly before runtime creation when no provider or proxy is available", async () => {
    writeScenario(tempDir, "cli-provider-required");
    const createScenarioRuntime = vi.fn();
    const dependencies = createDependencies(() => "passed", {
      availableProviderNames: vi.fn(() => []),
      shouldUseDeterministicModel: vi.fn(() => false),
      createScenarioRuntime,
    });

    const code = await runCli(["run", tempDir], dependencies);

    expect(code).toBe(2);
    expect(stderr).toContain("no LLM provider API key set");
    expect(createScenarioRuntime).not.toHaveBeenCalled();
  });

  it("threads run-dir, run id, and native export paths through the run", async () => {
    writeScenario(tempDir, "cli-artifacts");
    const runDir = path.join(tempDir, "run");
    const nativePath = path.join(tempDir, "native.jsonl");
    const dependencies = createDependencies(() => "passed");

    const code = await runCli(
      [
        "run",
        tempDir,
        "--run-dir",
        runDir,
        "--runId",
        "run-fixed",
        "--export-native",
        nativePath,
      ],
      dependencies,
    );

    expect(code).toBe(0);
    expect(process.env.ELIZA_TRAJECTORY_LOGGING).toBe("1");
    expect(process.env.ELIZA_TRAJECTORY_DIR).toBe(
      path.join(runDir, "trajectories"),
    );
    expect(process.env.ELIZA_LIFEOPS_RUN_ID).toBe("run-fixed");
    expect(process.env.ELIZA_LIFEOPS_RUN_DIR).toBe(runDir);
    expect(process.env.ELIZA_LIFEOPS_SCENARIO_ID).toBe("cli-artifacts");
    expect(dependencies.exportScenarioNativeJsonl).toHaveBeenCalledWith(
      runDir,
      nativePath,
      expect.any(Map),
      expect.any(Map),
      expect.any(Map),
    );
    expect(dependencies.writeScenarioRunViewer).toHaveBeenCalledWith(
      expect.objectContaining({
        artifactPaths: expect.objectContaining({
          runDir,
          nativeJsonl: nativePath,
        }),
      }),
      runDir,
      { nativeJsonlPath: nativePath },
    );
  });

  it("refreshes aggregate evidence after every completed scenario and keeps the final report equivalent to the last checkpoint", async () => {
    writeScenario(tempDir, "cli-first");
    writeScenario(tempDir, "cli-second");
    const runDir = path.join(tempDir, "run");
    const reportPath = path.join(tempDir, "report.json");
    const dependencies = createDependencies(() => "passed");

    const code = await runCli(
      [
        "run",
        tempDir,
        "--run-dir",
        runDir,
        "--runId",
        "checkpoint-run",
        "--report",
        reportPath,
      ],
      dependencies,
    );

    expect(code).toBe(0);
    const reportWrites = vi
      .mocked(dependencies.writeReport)
      .mock.calls.filter(([, filePath]) => filePath === reportPath)
      .map(([report]) => report);
    expect(
      reportWrites.map((report) => report.scenarios.map((s) => s.id)),
    ).toEqual([
      ["cli-first"],
      ["cli-first", "cli-second"],
      ["cli-first", "cli-second"],
    ]);
    expect(reportWrites.at(-1)).toEqual(reportWrites.at(-2));
    // Expensive derived artifacts are rebuilt once at deterministic finalization,
    // not by every incremental checkpoint.
    expect(dependencies.writeScenarioRunViewer).toHaveBeenCalledTimes(1);
    expect(dependencies.exportScenarioNativeJsonl).toHaveBeenCalledTimes(0);
  });

  it("stops after a graceful interrupt only after checkpointing the completed scenario", async () => {
    writeScenario(tempDir, "cli-alpha-signal");
    writeScenario(tempDir, "cli-beta-after-signal");
    const runDir = path.join(tempDir, "run");
    const reportPath = path.join(tempDir, "report.json");
    const dependencies = createDependencies(() => "passed", {
      runScenario: vi.fn(async (scenario) => {
        const report = scenarioReport(scenario.id, "passed");
        process.emit("SIGTERM", "SIGTERM");
        return report;
      }),
      writeReport: writeReportToDisk,
    });

    const code = await runCli(
      [
        "run",
        tempDir,
        "--run-dir",
        runDir,
        "--runId",
        "interrupted-run",
        "--report",
        reportPath,
      ],
      dependencies,
    );

    expect(code).toBe(1);
    expect(dependencies.runScenario).toHaveBeenCalledTimes(1);
    const recoveredReport = JSON.parse(
      readFileSync(reportPath, "utf8"),
    ) as AggregateReport;
    expect(recoveredReport.scenarios.map((s) => s.id)).toEqual([
      "cli-alpha-signal",
    ]);
    const recoveredRunMatrix = JSON.parse(
      readFileSync(path.join(runDir, "matrix.json"), "utf8"),
    ) as AggregateReport;
    expect(recoveredRunMatrix).toEqual(recoveredReport);
    expect(stderr).toContain("checkpoint evidence reflects exactly");
  });

  it("redacts sensitive keyed values before writing checkpoint reports", async () => {
    writeScenario(tempDir, "cli-secret");
    const reportPath = path.join(tempDir, "report.json");
    const dependencies = createDependencies(() => "passed", {
      runScenario: vi.fn(async (scenario) => ({
        ...scenarioReport(scenario.id, "passed"),
        turns: [
          {
            name: "api",
            kind: "api",
            responseText: "ok",
            responseBody: { token: "secret-token-value" },
            actionsCalled: [],
            durationMs: 1,
            failedAssertions: [],
          },
        ],
        actionsCalled: [
          {
            name: "SECRET_ACTION",
            result: {
              data: { authorization: "Bearer secret-token-value" },
              success: true,
            },
          } as never,
        ],
      })),
    });

    const code = await runCli(
      ["run", tempDir, "--report", reportPath],
      dependencies,
    );

    expect(code).toBe(0);
    const persisted = vi
      .mocked(dependencies.writeReport)
      .mock.calls.at(-1)?.[0];
    expect(JSON.stringify(persisted)).not.toContain("secret-token-value");
    expect(JSON.stringify(persisted)).toContain("[REDACTED]");
  });
});
