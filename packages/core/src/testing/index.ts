/**
 * @fileoverview elizaOS Integration Testing Infrastructure
 *
 * This module provides REAL integration testing utilities that use:
 * - Real database (PGLite by default, Postgres if configured)
 * - Real inference (Ollama by default, cloud providers if API keys are available)
 *
 * NO MOCKS. Tests must use real infrastructure to provide genuine confidence.
 *
 * @example
 * ```typescript
 * import {
 *   createIntegrationTestRuntime,
 *   withTestRuntime,
 *   requireInferenceProvider,
 * } from '@elizaos/core/testing';
 *
 * describe('My Integration Tests', () => {
 *   it('should process a message with real inference', async () => {
 *     const { runtime, cleanup, inferenceProvider } = await createIntegrationTestRuntime({
 *       databaseAdapter: myAdapter,
 *     });
 *
 *     console.log(`Using inference: ${inferenceProvider && inferenceProvider.name}`);
 *
 *     try {
 *       const memory = await runtime.createMemory({
 *         entityId: runtime.agentId,
 *         roomId: runtime.agentId,
 *         content: { text: 'Hello, world!' },
 *       }, 'messages');
 *
 *       expect(memory).toBeDefined();
 *     } finally {
 *       await cleanup();
 *     }
 *   });
 * });
 * ```
 */

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

// Ollama model handlers (for local inference)
export {
	createOllamaModelHandlers,
	isOllamaAvailable,
	listOllamaModels,
} from "./ollama-provider";

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

// Shared test utilities (env snapshots, timeouts, deferred promises)
export {
	createDeferred,
	envSnapshot,
	saveEnv,
	sleep,
	withTimeout,
} from "./shared-test-utils";

// Conditional test helpers (describeIf, itIf, testIf)
export { describeIf, itIf, testIf } from "./conditional-tests";

// Loopback port availability checker
export { canBindLoopback } from "./loopback";

// HTTP test request helpers
export {
	createConversation,
	postConversationMessage,
	readConversationId,
	req,
	type HttpRequestOptions,
	type HttpResponse,
} from "./http";

// Browser API shims (Storage, Canvas, Media, console patches)
export {
	createMemoryStorage,
	hasStorageApi,
	createCanvas2DContext,
	installCanvasShims,
	installMediaElementShims,
	suppressReactTestConsoleErrors,
} from "./browser-mocks";

// React test-renderer helpers
export { findButtonByText, flush, text, textOf } from "./react-test";

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

// Real connector helpers (Discord, Telegram, email)
export {
	createDiscordTestClient,
	type DiscordTestClient,
	sendDiscordDM,
	sendDiscordChannelMessage,
	waitForDiscordMessage,
	createTelegramTestBot,
	type TelegramTestBot,
	sendTestEmail,
} from "./real-connector";

// Live LLM provider selection
export {
	availableProviderNames,
	isLiveTestEnabled,
	type LiveProviderConfig,
	type LiveProviderName,
	requireLiveProvider,
	selectLiveProvider,
} from "./live-provider";

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
