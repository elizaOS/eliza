/**
 * Action selection benchmark helper.
 *
 * Re-exports the benchmark cases, runner, and report formatter from the
 * canonical location inside eliza/packages/app-core/test/benchmarks/, and
 * adds a convenience `runActionBenchmark` wrapper that takes a runtime and
 * runs the full suite with sensible defaults.
 *
 * Usage:
 *   import { runActionBenchmark, BENCHMARK_CASES } from "../helpers/action-benchmark";
 *
 *   const report = await runActionBenchmark(runtime);
 *   console.log(report.accuracy);
 */

export {
  ACTION_BENCHMARK_CASES,
  type ActionBenchmarkCase,
} from "../../packages/app-core/test/benchmarks/action-selection-cases";

export {
  type ActionBenchmarkLatencyStats,
  type ActionBenchmarkReport,
  type ActionBenchmarkResult,
  type ActionBenchmarkRunOptions,
  type ActionBenchmarkTagStats,
  formatBenchmarkReportMarkdown,
  runActionSelectionBenchmark,
} from "../../packages/app-core/test/benchmarks/action-selection-runner";

import type { AgentRuntime } from "@elizaos/core";
import {
  ACTION_BENCHMARK_CASES,
  type ActionBenchmarkCase,
} from "../../packages/app-core/test/benchmarks/action-selection-cases";
import {
  type ActionBenchmarkReport,
  runActionSelectionBenchmark,
} from "../../packages/app-core/test/benchmarks/action-selection-runner";

// ---------------------------------------------------------------------------
// Convenience types and defaults
// ---------------------------------------------------------------------------

export interface BenchmarkCase {
  id: string;
  userMessage: string;
  expectedAction: string | null;
  tags: string[];
}

/**
 * Curated subset of benchmark cases for quick validation runs.
 * Covers the most important positive and negative scenarios.
 */
export const QUICK_BENCHMARK_CASES: BenchmarkCase[] = [
  // Negative — should NOT trigger actions
  {
    id: "greeting",
    userMessage: "Hey, good morning!",
    expectedAction: null,
    tags: ["negative", "basic"],
  },
  {
    id: "factual",
    userMessage: "What is the capital of France?",
    expectedAction: null,
    tags: ["negative", "basic"],
  },
  {
    id: "opinion",
    userMessage: "What do you think about remote work?",
    expectedAction: null,
    tags: ["negative", "basic"],
  },
  {
    id: "thanks",
    userMessage: "thanks, that was helpful",
    expectedAction: null,
    tags: ["negative", "basic"],
  },
  {
    id: "neg-email-vent",
    userMessage: "I hate email, it's such a time sink",
    expectedAction: null,
    tags: ["negative", "near-miss"],
  },
  {
    id: "neg-calendar-vent",
    userMessage: "my calendar has been crazy this quarter",
    expectedAction: null,
    tags: ["negative", "near-miss"],
  },

  // Positive — SHOULD trigger actions
  {
    id: "todo-create",
    userMessage: "Add buy groceries to my to-do list",
    expectedAction: "LIFE",
    tags: ["todos", "critical"],
  },
  {
    id: "todo-list",
    userMessage: "What's on my todo list today?",
    expectedAction: "LIFE",
    tags: ["todos", "critical"],
  },
  {
    id: "goal-set",
    userMessage: "Set a goal to save $5,000 by the end of the year",
    expectedAction: "LIFE",
    tags: ["goals", "critical"],
  },
  {
    id: "cal-schedule",
    userMessage: "Schedule a dentist appointment next Tuesday at 3pm",
    expectedAction: "CALENDAR",
    tags: ["calendar", "critical"],
  },
  {
    id: "cal-check",
    userMessage: "What's my next meeting?",
    expectedAction: "CALENDAR",
    tags: ["calendar", "critical"],
  },
  {
    id: "email-triage",
    userMessage: "Triage my gmail inbox",
    expectedAction: "TRIAGE_MESSAGES",
    tags: ["email", "critical"],
  },
  {
    id: "personality-change",
    userMessage: "Change your personality to be more casual and funny",
    expectedAction: "MODIFY_CHARACTER",
    tags: ["personality", "critical"],
  },
  {
    id: "send-telegram",
    userMessage: "Send a telegram message to Jane saying I'm running late",
    expectedAction: "SEND_DRAFT",
    tags: ["messaging", "critical"],
  },
  {
    id: "block-sites",
    userMessage: "Block twitter and reddit for the next 2 hours",
    expectedAction: "WEBSITE_BLOCK",
    tags: ["focus", "critical"],
  },
  {
    id: "habit-create",
    userMessage:
      "I want to start a daily habit of meditating for 10 minutes each morning",
    expectedAction: "LIFE",
    tags: ["habits", "critical"],
  },
];

// ---------------------------------------------------------------------------
// Convenience runner
// ---------------------------------------------------------------------------

export interface RunActionBenchmarkOptions {
  /** Use only the quick subset (16 cases) instead of the full suite. Default: false. */
  quick?: boolean;
  /** Custom cases to run instead of the built-in sets. */
  cases?: ActionBenchmarkCase[];
  /** Timeout per case in milliseconds. Default: 60_000. */
  timeoutMsPerCase?: number;
}

/**
 * Run the action selection benchmark against a live runtime.
 *
 * By default runs the full ACTION_BENCHMARK_CASES suite. Pass `quick: true`
 * for the curated 16-case subset, or provide custom `cases`.
 */
export async function runActionBenchmark(
  runtime: AgentRuntime,
  options?: RunActionBenchmarkOptions,
): Promise<ActionBenchmarkReport> {
  let cases: ActionBenchmarkCase[];

  if (options?.cases) {
    cases = options.cases;
  } else if (options?.quick) {
    // Map BenchmarkCase to ActionBenchmarkCase
    cases = QUICK_BENCHMARK_CASES.map((c) => ({
      id: c.id,
      userMessage: c.userMessage,
      expectedAction: c.expectedAction,
      tags: c.tags,
    }));
  } else {
    cases = ACTION_BENCHMARK_CASES;
  }

  return runActionSelectionBenchmark({
    runtime,
    cases,
    timeoutMsPerCase: options?.timeoutMsPerCase ?? 60_000,
  });
}
