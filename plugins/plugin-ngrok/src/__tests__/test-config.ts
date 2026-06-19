export const testConfig = {
  // Test execution configuration
  execution: {
    // Add delays between test suites to avoid rate limiting
    suitesDelay: 3000, // 3 seconds between test suites
    testsDelay: 1000, // 1 second between individual tests

    // Maximum retries for flaky tests
    maxRetries: 2,

    // Timeout configurations
    defaultTimeout: 30000,
    integrationTimeout: 60000,
    e2eTimeout: 90000,
  },

  // Ngrok specific configuration for tests
  ngrok: {
    // Don't use subdomains in tests (requires paid account)
    useRandomSubdomains: false,

    // Wait time after stopping tunnel before starting a new one
    stopWaitTime: 2000,

    // Rate limiting configuration
    minIntervalBetweenStarts: 3000,

    // Domain conflict retry configuration
    domainConflictRetries: 3,
    domainConflictBackoff: 2000,
  },

  // Test categorization for prioritized execution
  testPriority: {
    // Run these test suites first (critical path)
    high: ['unit/types.test.ts', 'unit/environment.test.ts', 'unit/plugin.test.ts'],

    // Run these after high priority tests
    medium: ['unit/actions.test.ts', 'mocks/NgrokServiceMock.ts'],

    // Run these last (resource intensive)
    low: [
      'integration/webhook-scenarios.test.ts',
      'e2e/real-ngrok.test.ts',
      'ngrok-integration.test.ts',
    ],
  },
};

// Helper to add delays in tests
export async function testDelay(ms: number = testConfig.execution.testsDelay): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Helper to check if we should skip ngrok tests
export function shouldSkipNgrokTests(): boolean {
  const hasAuthToken = Boolean(process.env.NGROK_AUTH_TOKEN);
  const skipTests = process.env.SKIP_NGROK_TESTS === 'true';

  if (!hasAuthToken) {
    console.log('⚠️  Skipping ngrok tests - NGROK_AUTH_TOKEN not found');
  }

  if (skipTests) {
    console.log('⚠️  Skipping ngrok tests - SKIP_NGROK_TESTS is set');
  }

  return !hasAuthToken || skipTests;
}

// Helper to get test-specific ngrok configuration
export function getTestNgrokConfig() {
  return {
    // Don't use subdomains in tests (free account limitation)
    NGROK_USE_RANDOM_SUBDOMAIN: 'false',

    // Use the auth token from environment
    NGROK_AUTH_TOKEN: process.env.NGROK_AUTH_TOKEN,

    // Don't use fixed domain in tests - let ngrok generate random URLs
    NGROK_DOMAIN: undefined,
  };
}
