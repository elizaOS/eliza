/**
 * Vitest entrypoint for the action selection benchmark.
 *
 * This is an informational benchmark — it always passes as long as the suite
 * runs to completion. The real value is the markdown report written to
 * `action-benchmark-report.md` at the repo root (and logged to stdout), which
 * CI can surface as an artifact or PR comment.
 *
 * Skips silently unless the live/benchmark lane explicitly opts in, or when no
 * live LLM provider is available.
 */

import { describe, expect, it } from "vitest";

import {
  type LiveProviderName,
  selectLiveProvider,
} from "../helpers/live-provider.ts";
import type { RealTestRuntimeResult } from "../helpers/real-runtime.ts";

const BENCHMARK_REPORT_PATH = "action-benchmark-report.md";
const BENCHMARK_TRAJECTORY_DIR = "action-benchmark-report";

const USE_MOCKED_APIS = process.env.ELIZA_BENCHMARK_USE_MOCKS === "1";
const RUN_ACTION_BENCHMARK =
  USE_MOCKED_APIS ||
  process.env.ELIZA_RUN_ACTION_BENCHMARK === "1" ||
  process.env.ELIZA_RUN_ACTION_BENCHMARK === "1";

async function createBenchmarkRuntimeFactory(): Promise<{
  createCaseRuntime: () => Promise<{
    runtime: RealTestRuntimeResult["runtime"];
    cleanup: () => Promise<void>;
  }>;
  cleanup: () => Promise<void>;
}> {
  const providerOverride = process.env.ELIZA_BENCHMARK_PROVIDER?.trim();
  const preferredProvider =
    (providerOverride as LiveProviderName | undefined) ??
    selectLiveProvider()?.name;

  if (USE_MOCKED_APIS) {
    const { createMockedTestRuntime, prepareMockedTestEnvironment } =
      await import(
        // @ts-expect-error — path is outside the package, resolved relative to repo root
        "../../../../test/mocks/helpers/mock-runtime.ts"
      );
    const previousBackgroundEnv = {
      ELIZA_DISABLE_LIFEOPS_SCHEDULER:
        process.env.ELIZA_DISABLE_LIFEOPS_SCHEDULER,
      ELIZA_DISABLE_PROACTIVE_AGENT: process.env.ELIZA_DISABLE_PROACTIVE_AGENT,
      ELIZA_TEST_COMPUTERUSE_BACKEND: process.env.ELIZA_TEST_COMPUTERUSE_BACKEND,
      COMPUTER_USE_ENABLED: process.env.COMPUTER_USE_ENABLED,
    };
    process.env.ELIZA_DISABLE_LIFEOPS_SCHEDULER = "1";
    process.env.ELIZA_DISABLE_PROACTIVE_AGENT = "1";
    process.env.ELIZA_TEST_COMPUTERUSE_BACKEND = "1";
    process.env.COMPUTER_USE_ENABLED = "1";
    const environment = await prepareMockedTestEnvironment();
    const { computerUsePlugin } = await import(
      // @ts-expect-error — workspace package resolved at runtime
      "@elizaos/plugin-computeruse"
    );
    const { browserPlugin } = await import(
      // @ts-expect-error — workspace package resolved at runtime
      "@elizaos/plugin-browser"
    );
    return {
      createCaseRuntime: async () =>
        createMockedTestRuntime({
          withLLM: true,
          plugins: [computerUsePlugin, browserPlugin].filter(Boolean),
          preferredProvider,
          sharedEnvironment: environment,
        }),
      cleanup: async () => {
        try {
          await environment.cleanup();
        } finally {
          if (previousBackgroundEnv.ELIZA_DISABLE_LIFEOPS_SCHEDULER === undefined) {
            delete process.env.ELIZA_DISABLE_LIFEOPS_SCHEDULER;
          } else {
            process.env.ELIZA_DISABLE_LIFEOPS_SCHEDULER =
              previousBackgroundEnv.ELIZA_DISABLE_LIFEOPS_SCHEDULER;
          }
          if (previousBackgroundEnv.ELIZA_DISABLE_PROACTIVE_AGENT === undefined) {
            delete process.env.ELIZA_DISABLE_PROACTIVE_AGENT;
          } else {
            process.env.ELIZA_DISABLE_PROACTIVE_AGENT =
              previousBackgroundEnv.ELIZA_DISABLE_PROACTIVE_AGENT;
          }
          if (previousBackgroundEnv.ELIZA_TEST_COMPUTERUSE_BACKEND === undefined) {
            delete process.env.ELIZA_TEST_COMPUTERUSE_BACKEND;
          } else {
            process.env.ELIZA_TEST_COMPUTERUSE_BACKEND =
              previousBackgroundEnv.ELIZA_TEST_COMPUTERUSE_BACKEND;
          }
          if (previousBackgroundEnv.COMPUTER_USE_ENABLED === undefined) {
            delete process.env.COMPUTER_USE_ENABLED;
          } else {
            process.env.COMPUTER_USE_ENABLED =
              previousBackgroundEnv.COMPUTER_USE_ENABLED;
          }
        }
      },
    };
  }

  // Load the LifeOps plugin after any mock env setup has happened so
  // client modules that read env-based mock endpoints do not capture the
  // production URLs during module evaluation.
  const { appLifeOpsPlugin } = await import(
    "@elizaos/app-lifeops"
  );
  const { computerUsePlugin } = await import(
    // @ts-expect-error — workspace package resolved at runtime
    "@elizaos/plugin-computeruse"
  );
  const { createRealTestRuntime } = await import("../helpers/real-runtime.ts");

  return {
    createCaseRuntime: async () =>
      createRealTestRuntime({
        withLLM: true,
        plugins: [appLifeOpsPlugin, computerUsePlugin],
        preferredProvider,
      }),
    cleanup: async () => {},
  };
}

describe("action selection benchmark", () => {
  it(
    "runs the full benchmark suite",
    async () => {
      if (!RUN_ACTION_BENCHMARK) {
        return;
      }

      const provider = selectLiveProvider();
      if (!provider) {
        // Silent skip — CI should not fail when no provider key is configured.
        return;
      }

      const [
        fs,
        { ACTION_BENCHMARK_CASES },
        { formatBenchmarkReportMarkdown, runActionSelectionBenchmark },
      ] = await Promise.all([
        import("node:fs/promises"),
        import("./action-selection-cases.ts"),
        import("./action-selection-runner.ts"),
      ]);
      const runtimeFactory = await createBenchmarkRuntimeFactory();

      const filterRaw = process.env.ELIZA_BENCHMARK_FILTER?.trim();
      const filterIds = filterRaw
        ? new Set(
            filterRaw
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
          )
        : null;
      const cases = filterIds
        ? ACTION_BENCHMARK_CASES.filter((c) => filterIds.has(c.id))
        : ACTION_BENCHMARK_CASES;

      try {
        const report = await runActionSelectionBenchmark({
          createCaseRuntime: runtimeFactory.createCaseRuntime,
          cases,
          trajectoryDir: BENCHMARK_TRAJECTORY_DIR,
          timeoutMsPerCase: 180_000,
        });
        const md = formatBenchmarkReportMarkdown(report);
        // Log to stdout so CI log aggregators pick it up.
        // eslint-disable-next-line no-console
        console.log(md);
        await fs.writeFile(BENCHMARK_REPORT_PATH, md, "utf8");

        // Benchmark is informational — accuracy is the metric, not the
        // pass/fail criterion. Only assert the report is structurally valid.
        expect(report.total).toBe(cases.length);
        expect(report.accuracy).toBeGreaterThanOrEqual(0);
        expect(report.accuracy).toBeLessThanOrEqual(1);
      } finally {
        await runtimeFactory.cleanup();
      }
    },
    60 * 60 * 1000,
  );
});
