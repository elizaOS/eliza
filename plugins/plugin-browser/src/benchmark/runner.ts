/**
 * Benchmark suite runner (#9476).
 *
 * Drives every task×seed episode through a {@link BrowserBenchmarkAdapter} and
 * the chosen {@link BenchmarkPolicy}, scoring each with the task's reward
 * function (computed from real DOM reads). Returns a {@link BenchmarkSuiteReport}
 * — the shape committed as the run artifact.
 */

import {
  BrowserBenchmarkAdapter,
  createWorkspaceBenchmarkExecutor,
} from "./adapter.js";
import { type BenchmarkPolicy, OraclePolicy } from "./policy.js";
import { MINIWOB_TASKS } from "./tasks.js";
import type {
  BenchmarkEpisodeResult,
  BenchmarkSuiteReport,
  BenchmarkTask,
  BrowserCommandExecutor,
} from "./types.js";

export interface BenchmarkRunOptions {
  tasks?: readonly BenchmarkTask[];
  benchmarkName?: string;
  seeds?: readonly number[];
  policy?: BenchmarkPolicy;
  /** Fresh executor (and its disposer) per episode. */
  makeExecutor?: () => Promise<{
    executor: BrowserCommandExecutor;
    dispose: () => Promise<void>;
  }>;
  /** Injectable clock for deterministic trajectory timestamps in tests. */
  timestampSource?: () => number;
}

export async function runEpisode(
  task: BenchmarkTask,
  seed: number,
  policy: BenchmarkPolicy,
  executor: BrowserCommandExecutor,
  timestampSource?: () => number,
): Promise<BenchmarkEpisodeResult> {
  const adapter = new BrowserBenchmarkAdapter(executor, {
    maxTrajectoryLength: task.maxSteps,
    timestampSource,
  });
  const base: Omit<
    BenchmarkEpisodeResult,
    "reward" | "success" | "steps" | "trajectory"
  > = {
    taskId: task.id,
    family: task.family,
    seed,
    utterance: task.utterance(seed),
    engine: executor.engine,
    policy: policy.name,
  };

  try {
    await adapter.loadTask(task, seed);
    for (let i = 0; i < task.maxSteps && !adapter.isTerminated(); i++) {
      const observation = await adapter.getObservation();
      const action = await policy.act({
        observation,
        task,
        seed,
        history: adapter.getTrajectory(),
      });
      const result = await adapter.step(action);
      if (result.done) break;
    }
    const reward = await task.reward(adapter.rewardContext(), seed);
    return {
      ...base,
      reward,
      success: reward >= 1,
      steps: adapter.getStepCount(),
      trajectory: adapter.getTrajectory().map((s) => ({
        action: s.action,
        resultMode: s.commandResult?.mode ?? null,
        error: s.error ? `${s.error.code}: ${s.error.message}` : null,
      })),
    };
  } catch (error) {
    return {
      ...base,
      reward: 0,
      success: false,
      steps: adapter.getStepCount(),
      trajectory: adapter.getTrajectory().map((s) => ({
        action: s.action,
        resultMode: s.commandResult?.mode ?? null,
        error: s.error ? `${s.error.code}: ${s.error.message}` : null,
      })),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function runBenchmarkSuite(
  options: BenchmarkRunOptions = {},
): Promise<BenchmarkSuiteReport> {
  const tasks = options.tasks ?? MINIWOB_TASKS;
  const seeds = options.seeds ?? [0, 1, 2];
  const policy = options.policy ?? new OraclePolicy();
  const makeExecutor =
    options.makeExecutor ?? (() => createWorkspaceBenchmarkExecutor({}));

  const episodes: BenchmarkEpisodeResult[] = [];
  let engine = "unknown";

  for (const task of tasks) {
    for (const seed of seeds) {
      const { executor, dispose } = await makeExecutor();
      engine = executor.engine;
      try {
        episodes.push(
          await runEpisode(
            task,
            seed,
            policy,
            executor,
            options.timestampSource,
          ),
        );
      } finally {
        await dispose();
      }
    }
  }

  const byTaskMap = new Map<string, { solved: number; total: number }>();
  for (const ep of episodes) {
    const entry = byTaskMap.get(ep.taskId) ?? { solved: 0, total: 0 };
    entry.total += 1;
    if (ep.success) entry.solved += 1;
    byTaskMap.set(ep.taskId, entry);
  }
  const solved = episodes.filter((e) => e.success).length;

  return {
    benchmark: options.benchmarkName ?? "miniwob++",
    engine,
    policy: policy.name,
    seedsPerTask: seeds.length,
    episodes,
    summary: {
      total: episodes.length,
      solved,
      successRate: episodes.length === 0 ? 0 : solved / episodes.length,
      byTask: [...byTaskMap.entries()].map(([taskId, v]) => ({
        taskId,
        solved: v.solved,
        total: v.total,
      })),
    },
  };
}
