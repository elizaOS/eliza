/**
 * Centralized timeout configurations for CLI tests
 *
 * All timeouts are in milliseconds
 */

export const TEST_TIMEOUTS = {
  // Test framework timeouts - Windows needs longer timeouts
  SUITE_TIMEOUT: process.platform === 'win32' ? 8 * 60 * 1000 : 5 * 60 * 1000, // 8/5 minutes for test suites
  INDIVIDUAL_TEST: process.platform === 'win32' ? 5 * 60 * 1000 : 3 * 60 * 1000, // 5/3 minutes for individual tests

  // Command execution timeouts (execSync) - Windows processes are slower
  QUICK_COMMAND: process.platform === 'win32' ? 45 * 1000 : 30 * 1000, // 45/30 seconds for simple commands
  STANDARD_COMMAND: process.platform === 'win32' ? 90 * 1000 : 60 * 1000, // 90/60 seconds for standard operations
  PROJECT_CREATION: process.platform === 'win32' ? 3 * 60 * 1000 : 2 * 60 * 1000, // 3/2 minutes for project creation
  NETWORK_OPERATION: process.platform === 'win32' ? 2 * 60 * 1000 : 90 * 1000, // 2 minutes/90 seconds for GitHub/network operations

  // Server and process timeouts - Windows process management is slower
  SERVER_STARTUP: process.platform === 'win32' ? 45 * 1000 : 30 * 1000, // 45/30 seconds for server startup
  PROCESS_CLEANUP: process.platform === 'win32' ? 15 * 1000 : 10 * 1000, // 15/10 seconds for process cleanup

  // Wait times (for setTimeout) - Windows needs more stabilization time
  SHORT_WAIT: process.platform === 'win32' ? 3 * 1000 : 2 * 1000, // 3/2 seconds
  MEDIUM_WAIT: process.platform === 'win32' ? 8 * 1000 : 5 * 1000, // 8/5 seconds
  LONG_WAIT: process.platform === 'win32' ? 15 * 1000 : 10 * 1000, // 15/10 seconds
} as const;

/**
 * Legacy timeout values for gradual migration
 * @deprecated Use TEST_TIMEOUTS instead
 */
export const LEGACY_TIMEOUTS = {
  DEFAULT_EXECSYNC: TEST_TIMEOUTS.STANDARD_COMMAND,
  PROJECT_SETUP: TEST_TIMEOUTS.PROJECT_CREATION,
} as const;
