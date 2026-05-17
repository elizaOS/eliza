/**
 * InterruptBench public API.
 *
 * Programmatic entry points for the harness. The CLI lives in `runner.ts`.
 */

export {
  type EvaluatorMode,
  type EvaluatorOptions,
  runScenario,
} from "./evaluator.ts";
export { callCerebras, isCerebrasConfigured } from "./llm-cerebras.ts";
export {
  createDefaultScriptedProvider,
  type ScriptedLlmProvider,
} from "./llm-scripted.ts";
export { renderConversation } from "./prompt.ts";
export { buildBenchRegistry } from "./registry.ts";
export {
  aggregateScore,
  buildReport,
  renderJson,
  renderMarkdown,
} from "./report.ts";
export { loadScenarioById, loadScenarios } from "./scenarios.ts";
export { passTier, scoreScenario } from "./scorer.ts";
export type {
  AxisScore,
  BenchmarkReport,
  Scenario,
  ScenarioResult,
  TraceEvent,
} from "./types.ts";
