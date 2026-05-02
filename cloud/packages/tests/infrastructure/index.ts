/**
 * Test Infrastructure Exports
 */

// Test runtime - direct access to production RuntimeFactory
export { AgentMode } from "../../lib/eliza/agent-mode-types";
// HTTP/SSE test utilities
export {
  assertStreamingOrder,
  assertStreamingSuccess,
  collectSSEEvents,
  createTestApiClient,
  getFullTextFromChunks,
  parseSSEStream,
  parseStreamingResponse,
  type RequestOptions,
  type SSEEvent,
  StreamingError,
  type StreamingMessageEvents,
  TestApiClient,
  type TestApiClientOptions,
} from "./http-client";
// Local database connection (uses same DB as running server)
export {
  getConnectionString,
  getDatabaseInfo,
  hasDatabaseUrl,
  verifyConnection,
} from "./local-database";
export { hasRuntimeModelCredentials } from "./runtime-model-access";
// Test data factory
export {
  cleanupAgentTasks,
  cleanupTestData,
  createAnonymousSession,
  createTestDataSet,
  createTestRoom,
  type TestApiKey,
  type TestCharacter,
  type TestDataSet,
  type TestOrganization,
  type TestUser,
} from "./test-data-factory";
export {
  // Test internals for race condition testing
  _testing,
  buildUserContext,
  // Test helpers
  createTestRuntime,
  createTestUser,
  getMcpService,
  getRuntimeCacheStats,
  invalidateByOrganization,
  invalidateRuntime,
  isRuntimeCached,
  // Production RuntimeFactory exports
  runtimeFactory,
  type SendTestMessageOptions,
  sendTestMessage,
  type TestMessageResult,
  type TestRuntime,
  type TestRuntimeResult,
  type TestUserContext,
  // Types
  type UserContext,
  waitForMcpReady,
} from "./test-runtime";
// Timing utilities
export { createScopedTimer, endTimer, logTimings, startTimer } from "./timing";
