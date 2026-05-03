/**
 * Configuration for the benchmark testing framework
 */

export const config = {
  // ELIZA server connection
  server: {
    url: process.env.ELIZA_SERVER_URL || "ws://localhost:3000",
    reconnectAttempts: 3,
    reconnectDelay: 1000, // ms
  },

  // Test execution settings
  test: {
    defaultTimeout: 5000, // ms
    delayBetweenPrompts: 500, // ms
    warmupPrompts: 3, // Number of warmup prompts before actual testing
    runsPerPrompt: 10, // Number of times to run each prompt for statistics
  },

  // Performance thresholds (for pass/fail)
  thresholds: {
    p50: 1000, // ms
    p95: 3000, // ms
    p99: 5000, // ms
    successRate: 0.95, // 95% success rate required
  },

  // Categories to test (can be overridden via env vars)
  categories: {
    typewriter: process.env.TEST_TYPEWRITER !== "false",
    multiverseMath: process.env.TEST_MULTIVERSE_MATH !== "false",
    relationalData: process.env.TEST_RELATIONAL_DATA !== "false",
  },

  // Output settings
  output: {
    verbose: process.env.VERBOSE === "true",
    saveResults: true,
    resultsDir: "./test-results",
    format: "json" as "json" | "csv",
  },

  // Agent configuration for test session
  agent: {
    userId: "test-user-" + Date.now(),
    roomId: "test-room-" + Date.now(),
    agentId: process.env.AGENT_ID || "default",
  },
};
