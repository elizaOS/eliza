/**
 * Covers the action-benchmark runner's command/env assembly and report parsing
 * on a temp filesystem — deterministic, no model is spawned.
 */

import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertLocalBenchmarkModelAvailable,
  buildActionBenchmarkCommand,
  buildActionBenchmarkEnv,
  runActionBenchmark,
} from "./action-benchmark-runner.js";

describe("action benchmark runner", () => {
  it("builds the app-core action benchmark command", () => {
    expect(buildActionBenchmarkCommand()).toEqual([
      "x",
      "vitest",
      "run",
      "--config",
      "../test/vitest/real.config.ts",
      "test/benchmarks/action-selection.real.test.ts",
      "--exclude",
      ".git/**",
      "--exclude",
      ".eliza/**",
    ]);
  });

  it("builds benchmark env with mocked execution and trajectory capture by default", () => {
    const env = buildActionBenchmarkEnv(
      {
        dryRun: true,
        filter: "message-route",
        runsPerCase: 2,
        provider: "local-llama-cpp",
        runtimeModel: "eliza-1-2b-trained",
        baseUrl: "http://localhost:11434/v1",
      },
      {
        reportMarkdownPath: "/tmp/action.md",
        reportJsonPath: "/tmp/action.json",
        trajectoryDir: "/tmp/trajectories",
      },
    );

    expect(env).toMatchObject({
      ELIZA_RUN_ACTION_BENCHMARK: "1",
      ELIZA_BENCHMARK_USE_MOCKS: "1",
      ELIZA_DUMP_TRAJECTORIES: "1",
      ELIZA_TRAJECTORY_MARKDOWN: "1",
      ELIZA_BENCHMARK_FILTER: "message-route",
      ELIZA_BENCHMARK_RUNS_PER_CASE: "2",
      ELIZA_ACTION_BENCHMARK_REPORT_PATH: "/tmp/action.md",
      ELIZA_ACTION_BENCHMARK_REPORT_JSON_PATH: "/tmp/action.json",
      ELIZA_ACTION_BENCHMARK_TRAJECTORY_DIR: "/tmp/trajectories",
      ELIZA_BENCHMARK_PROVIDER: "local-llama-cpp",
      LOCAL_LLAMA_CPP_API_KEY: "local",
      ELIZA_LIVE_TEST_SMALL_MODEL: "eliza-1-2b-trained",
      ELIZA_LIVE_TEST_LARGE_MODEL: "eliza-1-2b-trained",
      ELIZA_LIVE_TEST_LOCAL_LLAMA_CPP_BASE_URL: "http://localhost:11434/v1",
    });
  });

  it("does not mock live benchmark execution unless explicitly requested", () => {
    const env = buildActionBenchmarkEnv(
      {
        dryRun: false,
        provider: "local-llama-cpp",
        runtimeModel: "eliza-1-2b-trained",
      },
      {
        reportMarkdownPath: "/tmp/action.md",
        reportJsonPath: "/tmp/action.json",
        trajectoryDir: "/tmp/trajectories",
      },
    );

    expect(env.ELIZA_BENCHMARK_USE_MOCKS).toBeUndefined();
    expect(env.ELIZA_LIVE_TEST_LARGE_MODEL).toBe("eliza-1-2b-trained");
  });

  it("requires requested local benchmark models to be served before live runs", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: [
            { id: "gemma2:2b" },
            { id: "llama3.2:3b" },
            { id: "eliza-1-2b:latest" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    try {
      await expect(
        assertLocalBenchmarkModelAvailable({
          provider: "local-llama-cpp",
          runtimeModel: "eliza-1-2b-trained",
          baseUrl: "http://localhost:11434/v1/",
          dryRun: false,
        }),
      ).rejects.toThrow(
        'local action benchmark model "eliza-1-2b-trained" is not available',
      );
      await expect(
        assertLocalBenchmarkModelAvailable({
          provider: "local-llama-cpp",
          runtimeModel: "gemma2:2b",
          baseUrl: "http://localhost:11434/v1/",
          dryRun: false,
        }),
      ).resolves.toBeUndefined();
      await expect(
        assertLocalBenchmarkModelAvailable({
          provider: "local-llama-cpp",
          runtimeModel: "eliza-1-2b",
          baseUrl: "http://localhost:11434/v1/",
          dryRun: false,
        }),
      ).resolves.toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns output locations without spawning in dry-run mode", async () => {
    const outputDir = join(tmpdir(), `action-benchmark-${Date.now()}`);
    const result = await runActionBenchmark({
      workspaceRoot: "/repo",
      outputDir,
      dryRun: true,
      useMocks: true,
      modelId: "eliza-1-2b-trained",
      variant: "trained",
      tier: "2b",
      benchmark: "eliza_harness_action_selection",
      datasetVersion: "eliza-native-v1",
      codeCommit: "abc123",
    });

    expect(result.command.slice(1)).toEqual([
      "x",
      "vitest",
      "run",
      "--config",
      "../test/vitest/real.config.ts",
      "test/benchmarks/action-selection.real.test.ts",
      "--exclude",
      ".git/**",
      "--exclude",
      ".eliza/**",
    ]);
    expect(result.outputDir).toBe(outputDir);
    expect(result.reportJsonPath).toBe(
      join(outputDir, "action-benchmark-report.json"),
    );
    expect(result.trajectoryDir).toBe(join(outputDir, "trajectories"));
    expect(result.stdout).toContain("DRY RUN");
    expect(result.matrixSource).toMatchObject({
      path: join(outputDir, "action-benchmark-report.json"),
      modelId: "eliza-1-2b-trained",
      variant: "trained",
      tier: "2b",
      benchmark: "eliza_harness_action_selection",
      useMocks: true,
    });
    const report = JSON.parse(await readFile(result.reportJsonPath, "utf8"));
    expect(report).toMatchObject({
      schema: "eliza_action_selection_benchmark_report",
      source: {
        modelId: "eliza-1-2b-trained",
        variant: "trained",
        tier: "2b",
        benchmark: "eliza_harness_action_selection",
        datasetVersion: "eliza-native-v1",
        codeCommit: "abc123",
        useMocks: true,
      },
      summary: { total: 1, passed: 0, failed: 1, accuracy: 0 },
      failureModes: { dry_run: 1 },
      results: [
        expect.objectContaining({
          caseId: "dry-run-2b-trained-action-selection",
          prompt: "Can you check my calendar?",
          expectedAction: "CHECK_RUNTIME",
          actualAction: null,
          pass: false,
          dryRun: true,
          trajectoryPath: join(
            outputDir,
            "trajectories",
            "dry-run-2b-trained-action-selection.json",
          ),
        }),
      ],
      dryRun: true,
    });
    await expect(
      readFile(
        join(
          outputDir,
          "trajectories",
          "dry-run-2b-trained-action-selection.json",
        ),
        "utf8",
      ),
    ).resolves.toContain("eliza_action_benchmark_dry_run_trajectory");
    await expect(
      readFile(result.reportMarkdownPath, "utf8"),
    ).resolves.toContain("Dry Run");
    await rm(outputDir, { recursive: true, force: true });
  });

  it("discovers the workspace root when omitted", async () => {
    const outputDir = join(
      tmpdir(),
      `action-benchmark-discovery-${Date.now()}`,
    );
    const result = await runActionBenchmark({
      outputDir,
      dryRun: true,
      modelId: "eliza-1-2b-base",
      variant: "base",
    });

    // Verify discovery found the real workspace root structurally, not by
    // assuming the checkout dir is named "eliza" (false in a /tmp worktree,
    // a fork, or any renamed CI checkout).
    expect(existsSync(join(result.workspaceRoot, "packages", "app-core"))).toBe(
      true,
    );
    expect(result.appCoreRoot).toBe(
      join(result.workspaceRoot, "packages", "app-core"),
    );
    expect(result.command[0]).toBeTruthy();
    await rm(outputDir, { recursive: true, force: true });
  });
});
