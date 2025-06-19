/**
 * Centralized timeout configurations for CLI tests
 *
 * All timeouts are in milliseconds
 */

// Detect CI environment to use shorter timeouts
const isCI = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';

export const TEST_TIMEOUTS = {
  // Test framework timeouts - Reduced for CI, Windows needs longer timeouts
  SUITE_TIMEOUT: isCI 
    ? 2 * 60 * 1000 // 2 minutes in CI
    : (process.platform === 'win32' ? 8 * 60 * 1000 : 5 * 60 * 1000), // 8/5 minutes locally
  INDIVIDUAL_TEST: isCI 
    ? 60 * 1000 // 1 minute in CI
    : (process.platform === 'win32' ? 5 * 60 * 1000 : 3 * 60 * 1000), // 5/3 minutes locally

  // Command execution timeouts (execSync) - Reduced for CI
  QUICK_COMMAND: isCI 
    ? 15 * 1000 // 15 seconds in CI
    : (process.platform === 'win32' ? 45 * 1000 : 30 * 1000), // 45/30 seconds locally
  STANDARD_COMMAND: isCI 
    ? 30 * 1000 // 30 seconds in CI
    : (process.platform === 'win32' ? 90 * 1000 : 60 * 1000), // 90/60 seconds locally
  PLUGIN_INSTALLATION: isCI 
    ? 60 * 1000 // 1 minute in CI
    : (process.platform === 'win32' ? 3 * 60 * 1000 : 2 * 60 * 1000), // 3/2 minutes locally
  PROJECT_CREATION: isCI 
    ? 60 * 1000 // 1 minute in CI
    : (process.platform === 'win32' ? 3 * 60 * 1000 : 2 * 60 * 1000), // 3/2 minutes locally
  NETWORK_OPERATION: isCI 
    ? 45 * 1000 // 45 seconds in CI
    : (process.platform === 'win32' ? 2 * 60 * 1000 : 90 * 1000), // 2 minutes/90 seconds locally

  // Server and process timeouts - Reduced for CI
  SERVER_STARTUP: isCI 
    ? 15 * 1000 // 15 seconds in CI
    : (process.platform === 'win32' ? 45 * 1000 : 30 * 1000), // 45/30 seconds locally
  PROCESS_CLEANUP: isCI 
    ? 5 * 1000 // 5 seconds in CI
    : (process.platform === 'win32' ? 15 * 1000 : 10 * 1000), // 15/10 seconds locally

  // Wait times (for setTimeout) - Significantly reduced for CI
  SHORT_WAIT: isCI 
    ? 1 * 1000 // 1 second in CI
    : (process.platform === 'win32' ? 3 * 1000 : 2 * 1000), // 3/2 seconds locally
  MEDIUM_WAIT: isCI 
    ? 2 * 1000 // 2 seconds in CI
    : (process.platform === 'win32' ? 8 * 1000 : 5 * 1000), // 8/5 seconds locally
  LONG_WAIT: isCI 
    ? 3 * 1000 // 3 seconds in CI
    : (process.platform === 'win32' ? 15 * 1000 : 10 * 1000), // 15/10 seconds locally
} as const;

/**
 * Legacy timeout values for gradual migration
 * @deprecated Use TEST_TIMEOUTS instead
 */
export const LEGACY_TIMEOUTS = {
  DEFAULT_EXECSYNC: TEST_TIMEOUTS.STANDARD_COMMAND,
  PROJECT_SETUP: TEST_TIMEOUTS.PROJECT_CREATION,
} as const;
