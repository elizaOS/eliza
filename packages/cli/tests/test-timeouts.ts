/**
 * Centralized timeout configurations for CLI tests
 *
 * All timeouts are in milliseconds
 */

// Detect CI environment to use shorter timeouts
const isCI = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';
const isMacOS = process.platform === 'darwin';
const isWindows = process.platform === 'win32';

export const TEST_TIMEOUTS = {
  // Test framework timeouts - More generous for CI stability (CI is slower than local)
  SUITE_TIMEOUT: isCI
    ? 10 * 60 * 1000 // 10 minutes in CI for all platforms (increased for Ubuntu 22.04 performance issues)
    : isWindows
      ? 8 * 60 * 1000
      : isMacOS
        ? 6 * 60 * 1000
        : 5 * 60 * 1000, // Platform-specific locally
  INDIVIDUAL_TEST: isCI
    ? 3 * 60 * 1000 // 3 minutes in CI for all platforms (increased for complex agent tests)
    : isWindows
      ? 5 * 60 * 1000
      : isMacOS
        ? 4 * 60 * 1000
        : 3 * 60 * 1000, // Platform-specific locally

  // Command execution timeouts (execSync) - Increased for CI environments
  QUICK_COMMAND: isCI
    ? isMacOS
      ? 60 * 1000
      : 45 * 1000 // 60/45 seconds in CI (increased for slower CI environments)
    : isWindows
      ? 45 * 1000
      : isMacOS
        ? 40 * 1000
        : 30 * 1000, // Platform-specific locally
  STANDARD_COMMAND: isCI
    ? isMacOS
      ? 120 * 1000
      : 90 * 1000 // 2/1.5 minutes in CI (increased for agent operations)
    : isWindows
      ? 90 * 1000
      : isMacOS
        ? 75 * 1000
        : 60 * 1000, // Platform-specific locally
  PLUGIN_INSTALLATION: isCI
    ? 150 * 1000 // 2.5 minutes in CI (increased to handle slow postinstall scripts)
    : process.platform === 'win32'
      ? 3 * 60 * 1000
      : 3 * 60 * 1000, // 3 minutes locally (mac/linux)
  PROJECT_CREATION: isCI
    ? 150 * 1000 // 2.5 minutes in CI (increased for slower CI environments)
    : process.platform === 'win32'
      ? 3 * 60 * 1000
      : 2 * 60 * 1000, // 3/2 minutes locally
  NETWORK_OPERATION: isCI
    ? 45 * 1000 // 45 seconds in CI
    : process.platform === 'win32'
      ? 2 * 60 * 1000
      : 90 * 1000, // 2 minutes/90 seconds locally

  // Server and process timeouts - Agent startup is complex and needs more time in CI
  SERVER_STARTUP: isCI
    ? isMacOS
      ? 180 * 1000
      : isWindows
        ? 180 * 1000
        : 150 * 1000 // 3 minutes (macOS/Windows) / 2.5 minutes (others) in CI - increased for startup
    : isWindows
      ? 45 * 1000
      : isMacOS
        ? 40 * 1000
        : 30 * 1000, // Platform-specific locally
  PROCESS_CLEANUP: isCI
    ? isMacOS
      ? 8 * 1000
      : isWindows
        ? 8 * 1000
        : 5 * 1000 // 8s (macOS/Windows) / 5s (others) in CI
    : isWindows
      ? 15 * 1000
      : isMacOS
        ? 12 * 1000
        : 10 * 1000, // Platform-specific locally

  // Wait times (for setTimeout) - Simplified for CI stability
  SHORT_WAIT: isCI
    ? isWindows
      ? 3 * 1000 // 3 seconds on Windows CI to allow port release
      : 1 * 1000 // 1 second on other CI platforms
    : isWindows
      ? 3 * 1000
      : isMacOS
        ? 3 * 1000
        : 2 * 1000, // Platform-specific locally
  MEDIUM_WAIT: isCI
    ? isWindows
      ? 5 * 1000 // 5 seconds on Windows CI
      : 2 * 1000 // 2 seconds on other CI platforms
    : isWindows
      ? 8 * 1000
      : isMacOS
        ? 7 * 1000
        : 5 * 1000, // Platform-specific locally
  LONG_WAIT: isCI
    ? isWindows
      ? 8 * 1000 // 8 seconds on Windows CI
      : 3 * 1000 // 3 seconds on other CI platforms
    : isWindows
      ? 15 * 1000
      : isMacOS
        ? 12 * 1000
        : 10 * 1000, // Platform-specific locally
} as const;

/**
 * Legacy timeout values for gradual migration
 * @deprecated Use TEST_TIMEOUTS instead
 */
export const LEGACY_TIMEOUTS = {
  DEFAULT_EXECSYNC: TEST_TIMEOUTS.STANDARD_COMMAND,
  PROJECT_SETUP: TEST_TIMEOUTS.PROJECT_CREATION,
} as const;
