/**
 * @fileoverview ElizaOS Testing Infrastructure
 *
 * This module provides both legacy mock utilities and new real runtime testing infrastructure.
 *
 * **RECOMMENDED**: Use real runtime testing for reliable, production-like validation
 * **LEGACY**: Mock utilities are deprecated due to false confidence issues
 *
 * Real runtime testing:
 * - Uses actual AgentRuntime instances
 * - Tests real functionality, not mocks
 * - Catches actual bugs that mocks miss
 * - Provides genuine confidence in code reliability
 *
 * @example Real Runtime Testing (Recommended)
 * ```typescript
 * import { createTestRuntime, runIntegrationTest } from '@elizaos/core/test-utils';
 *
 * const result = await runIntegrationTest('Test name', async (runtime) => {
 *   const response = await runtime.processMessage({
 *     content: { text: 'Hello, world!' },
 *     entityId: 'test-user',
 *     roomId: 'test-room',
 *   });
 *
 *   // Test actual functionality
 *   expect(response.content.text).toBeDefined();
 * });
 * ```
 *
 * @example Legacy Mock Testing (Deprecated)
 * ```typescript
 * import { createMockRuntime, createMockMemory } from '@elizaos/core/test-utils';
 *
 * const mockRuntime = createMockRuntime({
 *   getSetting: mock().mockReturnValue('test-value')
 * });
 * ```
 */

// ========================================
// REAL RUNTIME TESTING (RECOMMENDED)
// ========================================
export * from './realRuntime';
export * from './templates';
export * from './testDatabase';
export * from './testModels';

// ========================================
// LEGACY MOCK SYSTEM (DEPRECATED)
// ========================================
export * from './factories';
export * from './mocks/character';
export * from './mocks/database';
export * from './mocks/memory';
export * from './mocks/mockUtils';
export * from './mocks/runtime';
export * from './mocks/services';
export * from './mocks/state';
