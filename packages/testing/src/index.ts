/** Runtime, provider, connector, and browser utilities for package-owned tests. */

// PGLite storage-mode policy (in-memory by default; disk via env or explicit dir)
export {
  createTestPgliteDataDir,
  isInMemoryPgliteDataDir,
  type TestPgliteStorageMode,
  testPgliteStorageMode,
} from "@elizaos/shared/utils/pglite-storage";
export { contextBenchProvider } from "./benchmark-context-provider";
// Browser API shims (Storage, Canvas, Media, console patches)
export {
  createCanvas2DContext,
  createMemoryStorage,
  hasStorageApi,
  installCanvasShims,
  installMediaElementShims,
  suppressReactTestConsoleErrors,
} from "./browser-mocks";
export {
  type InteractionAdapterConformanceOptions,
  type InteractionConformanceCaseName,
  type InteractionConformanceCheck,
  type InteractionConformanceFixture,
  type InteractionConformanceReport,
  REQUIRED_INTERACTION_CONFORMANCE_CASES,
  runInteractionAdapterConformance,
  runInteractionLeaseConformance,
} from "./computer-use-conformance";
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
} from "./deterministic-action-fixtures";
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
} from "./deterministic-model-plugin";
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
} from "./eliza-package-paths";
// HTTP test request helpers
export {
  createConversation,
  type HttpRequestOptions,
  type HttpResponse,
  postConversationMessage,
  readConversationId,
  req,
} from "./http";
// Inference provider detection and validation
export {
  detectInferenceProviders,
  type InferenceProviderDetectionResult,
  type InferenceProviderInfo,
} from "./inference-provider";
// Live LLM provider selection
export {
  availableProviderNames,
  isLiveTestEnabled,
  type LiveProviderConfig,
  type LiveProviderName,
  requireLiveProvider,
  selectLiveProvider,
} from "./live-provider";
export { createMockRuntime, MOCK_AGENT_ID } from "./mock-runtime";
export {
  createTestRuntimeWithModelProvider,
  type ModelProviderTestRuntime,
  type ModelProviderTestRuntimeOptions,
} from "./model-provider-runtime";
// Ollama model handlers (for local inference)
export {
  createOllamaModelHandlers,
  isOllamaAvailable,
  listOllamaModels,
} from "./ollama-provider";
// PGLite runtime factory for tests
export {
  createTestRuntime,
  type TestRuntimeOptions,
  type TestRuntimeResult,
} from "./pglite-runtime";
// Real runtime factory with LLM/connector support
export {
  createRealTestRuntime,
  type RealTestRuntimeOptions,
  type RealTestRuntimeResult,
} from "./real-runtime";
