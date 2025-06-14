/**
 * Centralized timeout configurations for CLI tests
 *
 * All timeouts are in milliseconds
 */

export const TEST_TIMEOUTS = {
  // Test framework timeouts
  SUITE_TIMEOUT: 5 * 60 * 1000, // 5 minutes for test suites (beforeAll, etc.)
  INDIVIDUAL_TEST: 3 * 60 * 1000, // 3 minutes for individual tests

  // Command execution timeouts (execSync)
  QUICK_COMMAND: 30 * 1000, // 30 seconds for simple commands (help, list, etc.)
  STANDARD_COMMAND: 60 * 1000, // 1 minute for standard operations
  PROJECT_CREATION: 2 * 60 * 1000, // 2 minutes for project creation
  NETWORK_OPERATION: 90 * 1000, // 90 seconds for GitHub/network operations

  // Server and process timeouts
  SERVER_STARTUP: 30 * 1000, // 30 seconds for server startup
  PROCESS_CLEANUP: 10 * 1000, // 10 seconds for process cleanup

  // Wait times (for setTimeout)
  SHORT_WAIT: 2 * 1000, // 2 seconds
  MEDIUM_WAIT: 5 * 1000, // 5 seconds
  LONG_WAIT: 10 * 1000, // 10 seconds
} as const;

/**
 * Legacy timeout values for gradual migration
 * @deprecated Use TEST_TIMEOUTS instead
 */
export const LEGACY_TIMEOUTS = {
  DEFAULT_EXECSYNC: TEST_TIMEOUTS.STANDARD_COMMAND,
  PROJECT_SETUP: TEST_TIMEOUTS.PROJECT_CREATION,
} as const;
