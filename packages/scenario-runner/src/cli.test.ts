/**
 * Behavioral coverage for the scenario-runner CLI contract. The tests load
 * real temporary scenario files through the loader, then inject the runtime
 * boundary so exit-code, filtering, skip-policy, and artifact-plumbing
 * semantics stay deterministic and cheap enough for the unit lane.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ScenarioDefinition } from "@elizaos/scenario-runner/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CliDependencies,
  CliUsageError,
  parseArgs,
  runCli,
} from "./cli.ts";
import type { AggregateReport, ScenarioReport } from "./types.ts";

const ENV_KEYS = [
  "ELIZA_TRAJECTORY_DIR",
  "ELIZA_TRAJECTORY_LOGGING",
  "ELIZA_LIFEOPS_RUN_DIR",
  "ELIZA_LIFEOPS_RUN_ID",
  "ELIZA_LIFEOPS_SCENARIO_ID",
  "LIFEOPS_LIVE_JUDGE_MIN_SCORE",
  "SKIP_REASON",
] as const;
const DETERMINISTIC_PROVIDER_NAME = "deterministic-llm-proxy" as const;

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
    skipReason: status === "skipped" ? "dependency unavailable" : undefined,
    durationMs: 1,
    turns: [],
    finalChecks: [],
    actionsCalled: [],
    failedAssertions:
      status === "failed" ? [{ label: "unit", detail: "forced failure" }] : [],
    providerName: "unit-test",
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
    scenarios: reports,
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
    shouldUseDeterministicLlmProxy: vi.fn(() => true),
    createScenarioRuntime: vi.fn(async () => ({
      runtime: {} as never,
      pgliteDir: tmpdir(),
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

  it("parses run filters and rejects invalid lanes without exiting the process", () => {
    const parsed = parseArgs([
      "run",
      tempDir,
      "--scenario",
      "alpha,beta",
      "--lane",
      "pr-deterministic",
      "nested/*.scenario.ts",
    ]);

    expect(parsed.command).toBe("run");
    expect(parsed.dir).toBe(path.resolve(tempDir));
    expect([...(parsed.filter ?? [])]).toEqual(["alpha", "beta"]);
    expect(parsed.lane).toBe("pr-deterministic");
    expect(parsed.fileGlobs).toEqual(["nested/*.scenario.ts"]);
    expect(() => parseArgs(["list", tempDir, "--lane", "bad-lane"])).toThrow(
      CliUsageError,
    );
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
      shouldUseDeterministicLlmProxy: vi.fn(() => false),
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
});
