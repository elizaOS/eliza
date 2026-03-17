/**
 * Benchmark Module
 *
 * Tools for evaluating agent performance through simulation.
 */

// Multi-archetype matchup benchmarking
export type {
  ArchetypeVsResult,
  MatchupAgent,
  MatchupAgentResult,
  MatchupBenchmarkConfig,
  MatchupBenchmarkResult,
} from "./ArchetypeMatchupBenchmark";
export {
  ArchetypeMatchupBenchmark,
  runQuickMatchupBenchmark,
} from "./ArchetypeMatchupBenchmark";
export type {
  BenchmarkHistoryEntry,
  ModelComparisonData,
} from "./BenchmarkChartGenerator";
export { BenchmarkChartGenerator } from "./BenchmarkChartGenerator";
export type {
  BenchmarkConfig,
  BenchmarkGameSnapshot,
  CausalEventType,
  GroundTruth,
  HiddenNarrativeFact,
  ScheduledCausalEvent,
  VolatilityBucket,
} from "./BenchmarkDataGenerator";
export { BenchmarkDataGenerator, SeededRandom } from "./BenchmarkDataGenerator";
export { BenchmarkDataViewer } from "./BenchmarkDataViewer";
export type {
  BenchmarkHistoryQuery,
  BenchmarkResultInput,
  BenchmarkTrendData,
} from "./BenchmarkHistoryService";
export { BenchmarkHistoryService } from "./BenchmarkHistoryService";
export type {
  BenchmarkComparisonResult,
  BenchmarkRunConfig,
} from "./BenchmarkRunner";
export { BenchmarkRunner } from "./BenchmarkRunner";
export * as BenchmarkValidator from "./BenchmarkValidator";
export type { FastEvalConfig, FastEvalResult } from "./FastEvalRunner";
export { FastEvalRunner } from "./FastEvalRunner";
export { MetricsValidator } from "./MetricsValidator";
export { MetricsVisualizer } from "./MetricsVisualizer";
export type {
  AverageMetrics,
  ModelBenchmarkOptions,
  ModelBenchmarkResult,
  ModelComparisonResult,
} from "./ModelBenchmarkService";
export { ModelBenchmarkService } from "./ModelBenchmarkService";
export type { ModelConfig } from "./ModelRegistry";
export {
  getBaselineModels,
  getModelById,
  getModelByModelId,
  getModelDisplayName,
  getModelsByProvider,
  getModelsByTier,
  MODEL_REGISTRY,
  validateModelId,
} from "./ModelRegistry";
// Shared utilities
export {
  type JsonValue,
  parseSimulationMetrics,
} from "./parseSimulationMetrics";
export {
  createRulerContext,
  extractMarketOutcomesFromBenchmark,
  getHiddenEventsForTick,
  getHiddenFactsForTick,
  getTrueFacts,
  scoreActionAgainstGroundTruth,
  wasDecisionOptimal,
} from "./RulerBenchmarkIntegration";
export { SimulationA2AInterface } from "./SimulationA2AInterface";
export type {
  SimulationConfig,
  SimulationMetrics,
  SimulationResult,
} from "./SimulationEngine";
export { SimulationEngine } from "./SimulationEngine";
export type { TaskRunnerConfig, TaskRunResult } from "./TaskRunner";
export { TaskRunner } from "./TaskRunner";
