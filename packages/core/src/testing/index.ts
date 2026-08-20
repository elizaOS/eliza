/** Runtime, provider, connector, and browser utilities for package-owned tests. */

export {
	ADVERSARIAL_KIND_DESCRIPTIONS,
	ADVERSARIAL_KINDS,
	type AdversarialFixtureSpec,
	type AdversarialKind,
	adversarialActionRouteFixtures,
	adversarialPlannerFixture,
} from "./adversarial-model-fixtures";
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
// Conditional test helpers (describeIf, itIf, testIf)
export { describeIf, itIf, testIf } from "./conditional-tests";
export {
	actionSlug,
	benignExternalMessageFixture,
	finalMessageUserText,
	matchesScenarioInput,
	type RuntimeWithScenarioModelFixtures,
	registerStrictActionRouteFixtures,
	type StrictActionRouteFixture,
	type StrictMultiToolRouteFixture,
	type StrictTerminalRouteFixture,
	stage1ResponseHandlerFixture,
	strictActionRouteFixtures,
	strictClarificationFixture,
	strictEvaluatorFixture,
	strictMultiToolRouteFixtures,
	strictScheduledRenderFixture,
	strictTerminalReplyFixture,
} from "./deterministic-action-fixtures";
export {
	applyDeterministicModelFixtureBehavior,
	createDeterministicModelFixtureRegistry,
	createDeterministicModelPlugin,
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
	getInstalledPackageNamedExport,
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
	hasInferenceProvider,
	type InferenceProviderDetectionResult,
	type InferenceProviderInfo,
	requireInferenceProvider,
} from "./inference-provider";
// Integration runtime creation
export {
	createIntegrationTestRuntime,
	DEFAULT_TEST_CHARACTER,
	type IntegrationTestConfig,
	type IntegrationTestResult,
	withTestRuntime,
} from "./integration-runtime";
// Live LLM provider selection
export {
	availableProviderNames,
	CLI_SUBSCRIPTION_SENTINEL_API_KEY,
	cliBackendCredentialsPath,
	isLiveTestEnabled,
	type LiveProviderConfig,
	type LiveProviderName,
	requireLiveProvider,
	selectLiveProvider,
} from "./live-provider";
// Loopback port availability checker
export { canBindLoopback } from "./loopback";
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
// PGLite storage-mode policy (in-memory by default; disk via env or explicit dir)
export {
	createTestPgliteDataDir,
	isInMemoryPgliteDataDir,
	type TestPgliteStorageMode,
	testPgliteStorageMode,
} from "./pglite-storage";
// React test-renderer helpers
export { findButtonByText, flush, text, textOf } from "./react-test";
// Real connector helpers (Discord, Telegram)
export {
	createDiscordTestClient,
	createTelegramTestBot,
	type DiscordTestClient,
	sendDiscordChannelMessage,
	sendDiscordDM,
	type TelegramTestBot,
	waitForDiscordMessage,
} from "./real-connector";
// Real runtime factory with LLM/connector support
export {
	createRealTestRuntime,
	type RealTestRuntimeOptions,
	type RealTestRuntimeResult,
} from "./real-runtime";
// Shared test utilities (env snapshots, timeouts, deferred promises)
export {
	createDeferred,
	envSnapshot,
	saveEnv,
	sleep,
	withTimeout,
} from "./shared-test-utils";
// Test helper utilities (pure functions, no mocks)
export {
	createTestCharacter,
	createTestMemory,
	expectRejection,
	generateTestId,
	measureTime,
	retry,
	testDataGenerators,
	waitFor,
} from "./test-helpers";
