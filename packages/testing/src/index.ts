/** Scenario authoring contracts and explicit runtime fixtures for package-owned validation. */

// PGLite storage-mode policy (in-memory by default; disk via env or explicit dir)
export {
  createTestPgliteDataDir,
  isInMemoryPgliteDataDir,
  type TestPgliteStorageMode,
  testPgliteStorageMode,
} from "@elizaos/shared/utils/pglite-storage";
export * from "../scenario-runner/schema/index.js";
export {
  CerebrasJudge,
  type CerebrasJudgeOptions,
  type CerebrasJudgeVerdict,
  extractBalancedJsonObject,
  type JudgeCallOptions,
  type JudgeResponse,
  normalizeVerdict,
  parseJudgeScore,
  tolerantJsonParse,
  verdictFromScore,
} from "../scenario-runner/src/cerebras-judge.ts";
export * from "../scenario-runner/src/scenario-assertions/action-assertions.ts";
export * from "../scenario-runner/src/scenario-assertions/action-result-assertions.ts";
export * from "../scenario-runner/src/scenario-assertions/browser-task-assertions.ts";
export * from "../scenario-runner/src/scenario-assertions/calendar-assertions.ts";
export * from "../scenario-runner/src/scenario-assertions/effect-assertions.ts";
export { contextBenchProvider } from "./benchmark-context-provider.ts";
export {
  CAPABILITY_ROUTER_PROTOCOL_FIXTURE,
  CAPABILITY_ROUTER_PROTOCOL_FIXTURE_VERSION,
} from "./capability-protocol-fixture.ts";
export {
  type InteractionAdapterConformanceOptions,
  type InteractionConformanceCaseName,
  type InteractionConformanceCheck,
  type InteractionConformanceFixture,
  type InteractionConformanceReport,
  REQUIRED_INTERACTION_CONFORMANCE_CASES,
  runInteractionAdapterConformance,
  runInteractionLeaseConformance,
} from "./computer-use-conformance.ts";
export {
  actionSlug,
  benignExternalMessageFixture,
  finalMessageUserText,
  matchesScenarioInput,
  type RuntimeWithScenarioModelFixtures,
  registerStrictActionRouteFixtures,
  type StrictActionRouteFixture,
  type StrictTerminalRouteFixture,
  stage1ResponseHandlerFixture,
  strictActionRouteFixtures,
  strictTerminalReplyFixture,
} from "./deterministic-action-fixtures.ts";
export {
  applyDeterministicModelFixtureBehavior,
  createDeterministicModelFixtureRegistry,
  createDeterministicModelPlugin,
  createPerfectResultPlugin,
  type DeterministicModelCall,
  type DeterministicModelCallDiagnostic,
  type DeterministicModelDiagnostics,
  type DeterministicModelFixture,
  type DeterministicModelFixtureBehavior,
  type DeterministicModelFixtureDiagnostic,
  type DeterministicModelFixtureMatch,
  type DeterministicModelFixtureRegistry,
  type DeterministicModelFixtureResolution,
  type DeterministicModelFixtureScope,
  type DeterministicModelPlugin,
  type DeterministicModelPluginOptions,
  type DeterministicModelResponse,
  type DeterministicSchemaMatcher,
  type DeterministicTextMatcher,
} from "./deterministic-model-plugin.ts";
// Package path resolution for monorepo tests
export {
  getAppCoreSourceRoot,
  getAutonomousSourceRoot,
  getElizaCoreEntry,
  getInstalledPackageEntry,
  getInstalledPackageRoot,
  getSharedSourceRoot,
  getUiSourceRoot,
  resolveModuleEntry,
} from "./eliza-package-paths.ts";
// HTTP test request helpers
export {
  createConversation,
  type HttpRequestOptions,
  type HttpResponse,
  postConversationMessage,
  readConversationId,
  req,
} from "./http.ts";
// Inference provider detection and validation
export {
  detectInferenceProviders,
  type InferenceProviderDetectionResult,
  type InferenceProviderInfo,
} from "./inference-provider.ts";
// Live LLM provider selection
export {
  availableProviderNames,
  isLiveTestEnabled,
  type LiveProviderConfig,
  type LiveProviderName,
  requireLiveProvider,
  selectLiveProvider,
} from "./live-provider.ts";
export { createMockRuntime, MOCK_AGENT_ID } from "./mock-runtime.ts";
export {
  createTestRuntimeWithModelProvider,
  type ModelProviderTestRuntime,
  type ModelProviderTestRuntimeOptions,
} from "./model-provider-runtime.ts";
// Ollama model handlers (for local inference)
export {
  createOllamaModelHandlers,
  isOllamaAvailable,
  listOllamaModels,
} from "./ollama-provider.ts";
// PGLite runtime factory for tests
export {
  createTestRuntime,
  type TestRuntimeOptions,
  type TestRuntimeResult,
} from "./pglite-runtime.ts";
export { postToolEvaluatorFixture } from "./post-tool-evaluator-fixture.ts";
// Real runtime factory with LLM/connector support
export {
  createRealTestRuntime,
  type RealTestRuntimeOptions,
  type RealTestRuntimeResult,
} from "./real-runtime.ts";
export {
  createSQLiteTestRuntime,
  initializeTestRuntime,
  SQLiteDatabaseAdapter,
} from "./sqlite-adapter.ts";
