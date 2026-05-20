/**
 * Benchmark Module
 *
 * Tools for evaluating agent performance through simulation.
 */

// Archetype Fit Scoring
export type {
  ActionDistribution,
  ArchetypeFitScore,
  SocialBehaviorMetrics,
  TradingBehaviorMetrics,
} from './ArchetypeFitCalculator';
export {
  ArchetypeFitCalculator,
  calculateArchetypeFit,
  findBestArchetypeMatch,
} from './ArchetypeFitCalculator';
// Multi-archetype matchup benchmarking
export type {
  ArchetypeVsResult,
  MatchupAgent,
  MatchupAgentResult,
  MatchupBenchmarkConfig,
  MatchupBenchmarkResult,
} from './ArchetypeMatchupBenchmark';
export {
  ArchetypeMatchupBenchmark,
  runQuickMatchupBenchmark,
} from './ArchetypeMatchupBenchmark';
export type {
  FeedTrustBenchmarkResult,
  FeedTrustScenario,
  TrustScenarioId,
  TrustScenarioMetadata,
} from './FeedTrustBenchmark';
export {
  FeedTrustBenchmark,
  getTrustScenarioLoader,
  isValidTrustScenarioId,
  listTrustScenarios,
  loadTrustScenario,
  TrustScenarioLoader,
  TrustScenarioValidationError,
} from './FeedTrustBenchmark';
export type {
  BenchmarkHistoryEntry,
  ModelComparisonData,
} from './BenchmarkChartGenerator';
export { BenchmarkChartGenerator } from './BenchmarkChartGenerator';
export type {
  BenchmarkConfig,
  BenchmarkGameSnapshot,
  CausalEventType,
  GroundTruth,
  HiddenNarrativeFact,
  ScheduledCausalEvent,
  VolatilityBucket,
} from './BenchmarkDataGenerator';
export { BenchmarkDataGenerator, SeededRandom } from './BenchmarkDataGenerator';
export { BenchmarkDataViewer } from './BenchmarkDataViewer';
export type {
  BenchmarkHistoryQuery,
  BenchmarkResultInput,
  BenchmarkTrendData,
} from './BenchmarkHistoryService';
export { BenchmarkHistoryService } from './BenchmarkHistoryService';
export type {
  BenchmarkComparisonResult,
  BenchmarkRunConfig,
} from './BenchmarkRunner';
export { BenchmarkRunner } from './BenchmarkRunner';
export { BenchmarkValidator } from './BenchmarkValidator';
export type { FastEvalConfig, FastEvalResult } from './FastEvalRunner';
export { FastEvalRunner } from './FastEvalRunner';
export { MetricsValidator } from './MetricsValidator';
export { MetricsVisualizer } from './MetricsVisualizer';
export type {
  AverageMetrics,
  ModelBenchmarkOptions,
  ModelBenchmarkResult,
  ModelComparisonResult,
} from './ModelBenchmarkService';
export { ModelBenchmarkService } from './ModelBenchmarkService';
export type { ModelConfig } from './ModelRegistry';
export {
  createLocalModel,
  createLocalModelFromEnv,
  getBaselineModels,
  getModelById,
  getModelByModelId,
  getModelDisplayName,
  getModelsByProvider,
  getModelsByTier,
  MODEL_REGISTRY,
  validateModelId,
} from './ModelRegistry';
// Shared utilities
export {
  type JsonValue,
  parseSimulationMetrics,
} from './parseSimulationMetrics';
export {
  createRulerContext,
  extractMarketOutcomesFromBenchmark,
  getHiddenEventsForTick,
  getHiddenFactsForTick,
  getTrueFacts,
  scoreActionAgainstGroundTruth,
  wasDecisionOptimal,
} from './RulerBenchmarkIntegration';
// Scenario Loading
export type {
  FixedBenchmarkScenario,
  ScenarioExpectedBehavior,
  ScenarioId,
  ScenarioLoaderOptions,
  ScenarioMetadata,
  ScenarioSuccessCriteria,
} from './ScenarioLoader';
export {
  getScenarioLoader,
  getScenarioSnapshot,
  isValidScenarioId,
  listScenarios,
  loadScenario,
  ScenarioLoader,
  ScenarioValidationError,
} from './ScenarioLoader';
export { SimulationA2AInterface } from './SimulationA2AInterface';
export type {
  SimulationConfig,
  SimulationMetrics,
  SimulationResult,
} from './SimulationEngine';
export { SimulationEngine } from './SimulationEngine';
// Stakeholder Reports
export type {
  AgentBenchmarkSummary,
  FullBenchmarkReport,
  ScenarioBenchmarkResult,
} from './StakeholderReport';
export { StakeholderReportGenerator } from './StakeholderReport';
export type {
  TrustBenchmarkCheck,
  TrustBenchmarkEvaluation,
  TrustBenchmarkThresholds,
  TrustEventCategory,
  TrustGroundTruth,
  TrustMetrics,
  TrustProfile,
  TrustScenarioEvent,
  TrustSeverity,
} from './trust';
export {
  calculateTrustMetrics,
  createEmptyTrustMetrics,
  evaluateTrustMetrics,
  parseTrustMetrics,
} from './trust';
export type {
  BenchmarkScenarioOptions,
  VLLMBenchmarkConfig,
  VLLMBenchmarkResult,
} from './VLLMBenchmarkRunner';
export {
  createVLLMBenchmarkRunnerFromEnv,
  VLLMBenchmarkRunner,
} from './VLLMBenchmarkRunner';
// vLLM Integration
export type {
  CompletionRequest,
  CompletionResponse,
  VLLMClientConfig,
} from './VLLMInferenceClient';
export {
  createVLLMClientFromEnv,
  VLLMInferenceClient,
} from './VLLMInferenceClient';
