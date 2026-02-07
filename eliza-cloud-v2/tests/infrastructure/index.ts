/**
 * Test Infrastructure Exports
 */

// Local database connection (uses same DB as running server)
export {
  getConnectionString,
  verifyConnection,
  getDatabaseInfo,
} from "./local-database";

// Test data factory
export {
  createTestDataSet,
  createTestRoom,
  createAnonymousSession,
  cleanupTestData,
  type TestOrganization,
  type TestUser,
  type TestApiKey,
  type TestCharacter,
  type TestDataSet,
} from "./test-data-factory";

// Test runtime - direct access to production RuntimeFactory
export {
  // Production RuntimeFactory exports
  runtimeFactory,
  invalidateRuntime,
  invalidateByOrganization,
  isRuntimeCached,
  getRuntimeCacheStats,
  AgentMode,
  // Test internals for race condition testing
  _testing,
  // Test helpers
  createTestRuntime,
  buildUserContext,
  createTestUser,
  sendTestMessage,
  getMcpService,
  waitForMcpReady,
  // Types
  type UserContext,
  type TestRuntime,
  type TestRuntimeResult,
  type TestUserContext,
  type TestMessageResult,
  type SendTestMessageOptions,
} from "./test-runtime";

// Timing utilities
export { startTimer, endTimer, logTimings, createScopedTimer } from "./timing";

// HTTP/SSE test utilities
export {
  parseSSEStream,
  collectSSEEvents,
  parseStreamingResponse,
  createTestApiClient,
  TestApiClient,
  StreamingError,
  assertStreamingSuccess,
  assertStreamingOrder,
  getFullTextFromChunks,
  type SSEEvent,
  type StreamingMessageEvents,
  type TestApiClientOptions,
  type RequestOptions,
} from "./http-client";
