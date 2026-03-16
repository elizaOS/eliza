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
