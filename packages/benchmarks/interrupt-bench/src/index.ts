/**
 * InterruptBench public API.
 *
 * Programmatic entry points for the harness. The CLI lives in `runner.ts`.
 */

export { loadScenarios, loadScenarioById } from "./scenarios.ts";
export { runScenario, type EvaluatorMode, type EvaluatorOptions } from "./evaluator.ts";
export { buildReport, renderMarkdown, renderJson, aggregateScore } from "./report.ts";
export { scoreScenario, passTier } from "./scorer.ts";
export { buildBenchRegistry } from "./registry.ts";
export { callCerebras, isCerebrasConfigured } from "./llm-cerebras.ts";
export { createDefaultScriptedProvider, type ScriptedLlmProvider } from "./llm-scripted.ts";
export { renderConversation } from "./prompt.ts";
export type {
  Scenario,
  ScenarioResult,
  BenchmarkReport,
  TraceEvent,
  AxisScore,
} from "./types.ts";
