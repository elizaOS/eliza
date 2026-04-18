/**
 * Vitest entrypoint for the action selection benchmark.
 *
 * This is an informational benchmark — it always passes as long as the suite
 * runs to completion. The real value is the markdown report written to
 * `action-benchmark-report.md` at the repo root (and logged to stdout), which
 * CI can surface as an artifact or PR comment.
 *
 * Skips silently when no live LLM provider is available.
 */

import fs from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  type LiveProviderName,
  selectLiveProvider,
} from "../helpers/live-provider.ts";
import { createRealTestRuntime } from "../helpers/real-runtime.ts";
import { ACTION_BENCHMARK_CASES } from "./action-selection-cases.ts";
import {
  formatBenchmarkReportMarkdown,
  runActionSelectionBenchmark,
} from "./action-selection-runner.ts";

const BENCHMARK_REPORT_PATH = "action-benchmark-report.md";
const BENCHMARK_TRAJECTORY_DIR = "action-benchmark-report";

const USE_MOCKED_APIS = process.env.MILADY_BENCHMARK_USE_MOCKS === "1";

async function createBenchmarkRuntimeFactory(): Promise<{
  createCaseRuntime: () => Promise<{
    runtime: Awaited<ReturnType<typeof createRealTestRuntime>>["runtime"];
    cleanup: () => Promise<void>;
  }>;
  cleanup: () => Promise<void>;
}> {
  const preferredProvider =
    (process.env.MILADY_BENCHMARK_PROVIDER?.trim() as
      | LiveProviderName
      | undefined) ??
    selectLiveProvider("anthropic")?.name ??
    selectLiveProvider("openai")?.name ??
    selectLiveProvider("google")?.name ??
    selectLiveProvider("openrouter")?.name ??
    selectLiveProvider("groq")?.name;

  // Load the LifeOps plugin so its 30+ actions are registered. Without this,
  // the action planner sees only the 4 generic core actions
  // (REPLY, IGNORE, NONE, UPDATE_ENTITY) and can't possibly route to LIFE,
  // CALENDAR_ACTION, X_READ etc. — making the benchmark meaningless.
  const { appLifeOpsPlugin } = await import(
    // @ts-ignore — workspace package resolved at runtime
    "@elizaos/app-lifeops/plugin"
  );

  if (USE_MOCKED_APIS) {
    const {
      createMockedTestRuntime,
      prepareMockedTestEnvironment,
    } = await import(
      // @ts-ignore — path is outside the package, resolved relative to repo root
      "../../../../../test/mocks/helpers/mock-runtime.ts"
    );
    const environment = await prepareMockedTestEnvironment();
    return {
      createCaseRuntime: async () =>
        createMockedTestRuntime({
          withLLM: true,
          plugins: [appLifeOpsPlugin],
          preferredProvider,
          sharedEnvironment: environment,
        }),
      cleanup: async () => {
        await environment.cleanup();
      },
    };
  }

  return {
    createCaseRuntime: async () =>
      createRealTestRuntime({
        withLLM: true,
        plugins: [appLifeOpsPlugin],
        preferredProvider,
      }),
    cleanup: async () => {},
  };
}

describe("action selection benchmark", () => {
  it(
    "runs the full benchmark suite",
    async () => {
      const provider = selectLiveProvider();
      if (!provider) {
        // Silent skip — CI should not fail when no provider key is configured.
        return;
      }

      const runtimeFactory = await createBenchmarkRuntimeFactory();

      try {
        const report = await runActionSelectionBenchmark({
          createCaseRuntime: runtimeFactory.createCaseRuntime,
          cases: ACTION_BENCHMARK_CASES,
          trajectoryDir: BENCHMARK_TRAJECTORY_DIR,
          timeoutMsPerCase: 90_000,
        });
        const md = formatBenchmarkReportMarkdown(report);
        // Log to stdout so CI log aggregators pick it up.
        // eslint-disable-next-line no-console
        console.log(md);
        await fs.writeFile(BENCHMARK_REPORT_PATH, md, "utf8");

        // Benchmark is informational — accuracy is the metric, not the
        // pass/fail criterion. Only assert the report is structurally valid.
        expect(report.total).toBe(ACTION_BENCHMARK_CASES.length);
        expect(report.accuracy).toBeGreaterThanOrEqual(0);
        expect(report.accuracy).toBeLessThanOrEqual(1);
      } finally {
        await runtimeFactory.cleanup();
      }
    },
    60 * 60 * 1000,
  );
});
