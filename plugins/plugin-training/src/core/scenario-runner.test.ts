import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildScenarioRunCommand, runScenarios } from "./scenario-runner.js";

const outputDirs: string[] = [];

describe("scenario runner wrapper", () => {
  afterEach(async () => {
    await Promise.all(
      outputDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("builds scenario CLI args with run dir, native export, filter, and globs", () => {
    const args = buildScenarioRunCommand(
      {
        scenario: "deterministic-pr-smoke",
        fileGlobs: ["*.scenario.ts"],
      },
      {
        scenarioDir: "/repo/packages/scenario-runner/test/scenarios",
        outputDir: "/tmp/scenario-run",
        runId: "run-1",
        nativeJsonlPath: "/tmp/scenario-run/scenario-native.jsonl",
      },
    );

    expect(args).toEqual([
      "src/cli.ts",
      "run",
      "/repo/packages/scenario-runner/test/scenarios",
      "--run-dir",
      "/tmp/scenario-run",
      "--runId",
      "run-1",
      "--export-native",
      "/tmp/scenario-run/scenario-native.jsonl",
      "--scenario",
      "deterministic-pr-smoke",
      "*.scenario.ts",
    ]);
  });

  it("returns a dry-run command and output paths", async () => {
    const outputDir = join(tmpdir(), `scenario-runner-${Date.now()}`);
    outputDirs.push(outputDir);

    const result = await runScenarios({
      outputDir,
      runId: "training-scenarios-test",
      scenario: "deterministic-pr-smoke",
      dryRun: true,
    });

    expect(result.outputDir).toBe(outputDir);
    expect(result.workspaceRoot).toContain("eliza");
    expect(result.scenarioRunnerRoot).toBe(
      join(result.workspaceRoot, "packages", "scenario-runner"),
    );
    expect(result.runId).toBe("training-scenarios-test");
    expect(result.matrixPath).toBe(join(outputDir, "matrix.json"));
    expect(result.viewerHtmlPath).toBe(join(outputDir, "viewer", "index.html"));
    expect(result.nativeJsonlPath).toBe(
      join(outputDir, "scenario-native.jsonl"),
    );
    expect(result.nativeManifestPath).toBe(
      join(outputDir, "scenario-native.manifest.json"),
    );
    expect(result.command).toEqual(
      expect.arrayContaining([
        "src/cli.ts",
        "run",
        "--run-dir",
        outputDir,
        "--scenario",
        "deterministic-pr-smoke",
      ]),
    );
    expect(result.env).toMatchObject({ SCENARIO_USE_LLM_PROXY: "1" });
    expect(result.exitCode).toBe(0);
    const matrix = JSON.parse(await readFile(result.matrixPath, "utf8"));
    expect(matrix).toMatchObject({
      schema: "eliza_scenario_run_viewer_v1",
      runId: "training-scenarios-test",
      totalCount: 0,
      skippedCount: 1,
      dryRun: true,
    });
    await expect(readFile(result.viewerHtmlPath, "utf8")).resolves.toContain(
      "Scenario dry run",
    );
    await expect(readFile(result.nativeJsonlPath!, "utf8")).resolves.toBe("");
    const nativeManifest = JSON.parse(
      await readFile(result.nativeManifestPath!, "utf8"),
    );
    expect(nativeManifest).toMatchObject({
      schema: "eliza_scenario_native_export",
      source: {
        kind: "scenario_native_export",
        runId: "training-scenarios-test",
        scenario: "deterministic-pr-smoke",
        dryRun: true,
      },
      jsonlPath: join(outputDir, "scenario-native.jsonl"),
      manifestPath: join(outputDir, "scenario-native.manifest.json"),
      counts: {
        rows: 0,
        jsonlRows: 0,
        parsedTrajectories: 0,
      },
    });
  });
});
