/** runtime testing capability barrel. */

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
  createConversation,
  type HttpRequestOptions,
  type HttpResponse,
  postConversationMessage,
  readConversationId,
  req,
} from "./http.ts";
export {
  detectInferenceProviders,
  type InferenceProviderDetectionResult,
  type InferenceProviderInfo,
} from "./inference-provider.ts";
export {
  availableProviderNames,
  isLiveTestEnabled,
  type LiveProviderConfig,
  type LiveProviderName,
  selectLiveProvider,
} from "./live-provider.ts";
export {
  createTestRuntimeWithModelProvider,
  type ModelProviderTestRuntime,
  type ModelProviderTestRuntimeOptions,
} from "./model-provider-runtime.ts";
export {
  createOllamaModelHandlers,
  isOllamaAvailable,
  listOllamaModels,
} from "./ollama-provider.ts";
export {
  createTestRuntime,
  type TestRuntimeOptions,
  type TestRuntimeResult,
} from "./pglite-runtime.ts";
export {
  createTestPgliteDataDir,
  isInMemoryPgliteDataDir,
  type TestPgliteStorageMode,
  testPgliteStorageMode,
} from "./pglite-storage.ts";
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
export {
  createSyntheticTestRuntime,
  type SyntheticTestRuntime,
} from "./synthetic-runtime.ts";
