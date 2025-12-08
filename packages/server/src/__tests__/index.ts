/**
 * ElizaOS Server Test Infrastructure
 *
 * Central export point for all test utilities, fixtures, builders, and helpers.
 * Import everything you need from this single file.
 *
 * @example
 * ```typescript
 * import {
 *   TestServerFixture,
 *   AgentFixture,
 *   CharacterBuilder,
 *   MessageBuilder,
 *   waitForServerReady,
 * } from '../test-utils';
 * ```
 */

// ============================================================================
// Fixtures - Resource lifecycle management with auto-cleanup
// ============================================================================
export { TestServerFixture } from './fixtures/server.fixture';
export type { ServerFixtureOptions, ServerFixtureResult } from './fixtures/server.fixture';

export { DatabaseFixture } from './fixtures/database.fixture';
export type { DatabaseFixtureOptions, DatabaseFixtureResult } from './fixtures/database.fixture';

export { AgentFixture } from './fixtures/agent.fixture';
export type { AgentFixtureOptions, AgentFixtureResult } from './fixtures/agent.fixture';

export { SocketIOClientFixture } from './fixtures/socketio-client.fixture';
export type {
  SocketIOClientOptions,
  SendMessagePayload,
  JoinChannelPayload,
} from './fixtures/socketio-client.fixture';

// ============================================================================
// Builders - Type-safe test data creation with fluent API
// ============================================================================
export { CharacterBuilder } from './builders/character.builder';
export { MessageBuilder } from './builders/message.builder';
export type { MessageInput } from './builders/message.builder';
export { ChannelBuilder } from './builders/channel.builder';
export type { ChannelInput } from './builders/channel.builder';

// ============================================================================
// Helpers - Utility functions for common test operations
// ============================================================================

// Networking
export { findAvailablePort, isPortAvailable } from './helpers/networking';

// Wait utilities
export { waitForServerReady, waitFor, delay } from './helpers/wait';

// Retry utilities
export { retry } from './helpers/retry';
export type { RetryOptions, BackoffStrategy } from './helpers/retry';

// ============================================================================
// Test Utils - Environment and setup utilities
// ============================================================================
export {
  setupTestEnvironment,
  teardownTestEnvironment,
  captureEnvironment,
  restoreEnvironment,
  cleanTestEnvironment,
} from './test-utils/environment';
export type { EnvironmentSnapshot } from './test-utils/environment';

// ============================================================================
// Re-exports from @elizaos/core for convenience
// ============================================================================
export { stringToUuid, ChannelType, ModelType } from '@elizaos/core';
export type { UUID, Character, Plugin, IAgentRuntime } from '@elizaos/core';
