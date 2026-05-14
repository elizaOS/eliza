/**
 * Bench orchestrator — wires modes + tasks + metrics into a single run.
 *
 * Used by both the CLI (`src/index.ts`) and the vitest sanity test
 * (`__tests__/runner.test.ts`). The runner is generic over `ModeAdapter` so
 * the test can plug in mocks for both the local engine and Anthropic.
 */
import { summarize } from "./metrics.ts";
import { listActionNames, runActionTask } from "./tasks/action.ts";
import { runPlannerTask } from "./tasks/planner.ts";
import { runShouldRespondTask } from "./tasks/should-respond.ts";
import type {
  BenchReport,
  CaseMetric,
  ModeAdapter,
  ModeName,
  TaskName,
} from "./types.ts";

export interface RunBenchOptions {
  /** Tasks to run; supports `"all"` as a shorthand. */
  tasks: TaskSelection[];
  /** Modes to run. */
  modes: ModeAdapter[];
  /** Generations per (mode, case). */
  n: number;
  /** Optional progress hook called after each (task, mode) finishes. */
  onProgress?: (event: ProgressEvent) => void;
}

export type TaskSelection =
  | "should_respond"
  | "planner"
  | "all"
  | `action:${string}`
  | "action:all";

interface ProgressEvent {
  taskId: TaskName;
  modeId: ModeName;
  cases: number;
}

/**
 * Resolve a task selection into the concrete `TaskName` list. `"all"` fans out
 * to the full set: should-respond + planner + every action-fixture group.
 */
function expandTaskSelection(selections: TaskSelection[]): TaskName[] {
  const out = new Set<TaskName>();
  for (const sel of selections) {
    if (sel === "all") {
      out.add("should_respond");
      out.add("planner");
      for (const name of listActionNames()) {
        out.add(`action:${name}` as TaskName);
      }
      continue;
    }
    if (sel === "action:all") {
      for (const name of listActionNames()) {
        out.add(`action:${name}` as TaskName);
      }
      continue;
    }
    out.add(sel as TaskName);
  }
  return Array.from(out).sort((a, b) =>
    taskSortKey(a).localeCompare(taskSortKey(b)),
  );
}

function taskSortKey(task: TaskName): string {
  if (task === "should_respond") return "0:should_respond";
  if (task === "planner") return "1:planner";
  return `2:${task}`;
}

/** Run the bench. Modes that report a skip reason are recorded but not invoked. */
export async function runBench(options: RunBenchOptions): Promise<BenchReport> {
  const tasks = expandTaskSelection(options.tasks);
  const skipped: BenchReport["skipped"] = [];
  const activeModes: ModeAdapter[] = [];
  try {
    for (const mode of options.modes) {
      const reason = await mode.available();
      if (reason) {
        skipped.push({ modeId: mode.id, reason });
        // eslint-disable-next-line no-console
        console.log(`[bench] skipping mode '${mode.id}': ${reason}`);
        continue;
      }
      activeModes.push(mode);
    }
    const cases: CaseMetric[] = [];
    for (const task of tasks) {
      for (const mode of activeModes) {
        const taskMetrics = await runOneTask({ task, mode, n: options.n });
        cases.push(...taskMetrics);
        options.onProgress?.({
          taskId: task,
          modeId: mode.id,
          cases: taskMetrics.length,
        });
      }
    }
    return {
      schemaVersion: "eliza-1-bench-v1",
      generatedAt: new Date().toISOString(),
      tasks,
      modes: activeModes.map((m) => m.id),
      skipped,
      cases,
      summaries: summarize(cases),
    };
  } finally {
    await cleanupModes(activeModes);
  }
}

async function cleanupModes(modes: ModeAdapter[]): Promise<void> {
  const results = await Promise.allSettled(
    modes.map((mode) => mode.cleanup?.()),
  );
  for (let i = 0; i < results.length; i += 1) {
    const result = results[i];
    if (result.status === "rejected") {
      const message =
        result.reason instanceof Error ? result.reason.message : String(result.reason);
      // eslint-disable-next-line no-console
      console.warn(`[bench] cleanup for mode '${modes[i]?.id}' failed: ${message}`);
    }
  }
}

async function runOneTask(args: {
  task: TaskName;
  mode: ModeAdapter;
  n: number;
}): Promise<CaseMetric[]> {
  if (args.task === "should_respond") {
    return runShouldRespondTask({ mode: args.mode, n: args.n });
  }
  if (args.task === "planner") {
    return runPlannerTask({ mode: args.mode, n: args.n });
  }
  if (args.task.startsWith("action:")) {
    const actionName = args.task.slice("action:".length);
    return runActionTask({ actionName, mode: args.mode, n: args.n });
  }
  return [];
}
