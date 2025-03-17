// Unit tests for registry publishing functionality
import { describe, test, expect, vi, beforeEach } from 'vitest';

// Explicitly list imported functions to mock
import { getGitHubCredentials } from '@/src/utils/github';
import {
  publishToGitHub,
  testPublishToGitHub,
  testPublishToNpm,
} from '@/src/utils/plugin-publisher';

// Mock these imports - keep it simple with explicit mocks
vi.mock('@/src/utils/github', () => ({
  getGitHubCredentials: vi.fn(),
}));

vi.mock('@/src/utils/plugin-publisher', () => ({
  publishToGitHub: vi.fn(),
  testPublishToGitHub: vi.fn(),
  testPublishToNpm: vi.fn(),
}));

// Sample package.json for tests
const samplePackageJson = {
  name: '@elizaos/test-plugin',
  version: '1.0.0',
  description: 'Test plugin for unit tests',
  maintainers: ['testuser'],
  repository: {
    url: 'https://github.com/elizaos/test-plugin',
  },
  keywords: ['elizaos', 'plugin'],
  categories: ['test'],
  platform: 'node',
  type: 'plugin',
};

describe('Registry Publishing', () => {
  // Reset mocks before each test
  beforeEach(() => {
    vi.resetAllMocks();

    // Default implementations
    getGitHubCredentials.mockResolvedValue({
      username: 'testuser',
      token: 'mock-token',
    });

    publishToGitHub.mockResolvedValue(true);
    testPublishToGitHub.mockResolvedValue(true);
    testPublishToNpm.mockResolvedValue(true);
  });

  test('should support dry run mode', async () => {
    // Execute with dry run flag
    await publishPlugin({ dryRun: true });

    // Check that publish was called with dry run mode
    expect(publishToGitHub).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ name: expect.any(String) }),
      expect.any(String),
      expect.any(String),
      true // isTest/dryRun flag
    );
  });

  test('should support test mode', async () => {
    // Execute with test flag
    await publishPlugin({ test: true, npmPublish: true });

    // Check that test functions were called
    expect(testPublishToGitHub).toHaveBeenCalled();
    expect(testPublishToNpm).toHaveBeenCalled();
  });

  test('should handle maintainer workflow', async () => {
    // Set up user as maintainer
    getGitHubCredentials.mockResolvedValue({
      username: 'testuser',
      token: 'mock-token',
    });

    // Execute publish
    await publishPlugin({ maintainer: 'testuser' });

    // Check publish was called correctly
    expect(publishToGitHub).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        maintainers: expect.arrayContaining(['testuser']),
      }),
      expect.any(String),
      'testuser',
      expect.any(Boolean)
    );
  });

  test('should handle non-maintainer workflow', async () => {
    // Set up user as non-maintainer
    getGitHubCredentials.mockResolvedValue({
      username: 'testuser',
      token: 'mock-token',
    });

    // Execute publish with different maintainer
    await publishPlugin({ maintainer: 'othermaintainer' });

    // Check publish was called with different maintainer
    expect(publishToGitHub).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        maintainers: expect.arrayContaining(['othermaintainer']),
      }),
      expect.any(String),
      'testuser',
      expect.any(Boolean)
    );
  });

  test('should support npm publishing', async () => {
    // Execute with npm publish flag and test mode to ensure testPublishToNpm is called
    const result = await publishPlugin({ npmPublish: true, test: true });

    // Verify npm testing happens and was successful
    expect(testPublishToNpm).toHaveBeenCalled();
    expect(testPublishToNpm).toHaveBeenCalledWith('mock-dir');
    expect(result.success).toBe(true);
  });

  test('should check for CLI updates', async () => {
    // Mock global fetch for CLI version check
    const originalFetch = global.fetch;

    // Create a spy on global.fetch that returns a newer version
    global.fetch = vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue({
        'dist-tags': { latest: '2.0.0' }, // newer version than current
      }),
    });

    // Custom implementation for the version check
    const mockConsoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      // Execute the checkForUpdates function directly
      await checkForCliUpdates('1.0.0'); // Current version is older

      // Verify a warning was displayed since newer version exists
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('registry.npmjs.org/@elizaos/cli')
      );
      expect(mockConsoleWarn).toHaveBeenCalledWith(expect.stringContaining('newer version'));

      // Reset mocks
      mockConsoleWarn.mockReset();
      global.fetch.mockClear();

      // Test when current version is up to date
      global.fetch = vi.fn().mockResolvedValue({
        json: vi.fn().mockResolvedValue({
          'dist-tags': { latest: '1.0.0' }, // same version
        }),
      });

      await checkForCliUpdates('1.0.0'); // Current version is same

      // Verify no warning was displayed
      expect(global.fetch).toHaveBeenCalled();
      expect(mockConsoleWarn).not.toHaveBeenCalled();
    } finally {
      // Restore original fetch and console
      global.fetch = originalFetch;
      mockConsoleWarn.mockRestore();
    }
  });

  test('should handle GitHub publishing errors', async () => {
    // Mock failure
    publishToGitHub.mockRejectedValue(new Error('GitHub API error'));

    // Execute publish which should now fail
    const result = await publishPlugin();

    // Check error was properly handled
    expect(result.success).toBe(false);
    expect(result.message).toBe('GitHub API error');
  });

  test('should handle npm publishing errors', async () => {
    // Mock failure
    testPublishToNpm.mockRejectedValue(new Error('NPM publish error'));

    // Execute publish with npm flag which should now fail
    const result = await publishPlugin({ npmPublish: true, test: true });

    // Check error was properly handled
    expect(result.success).toBe(false);
    expect(result.message).toBe('NPM publish error');
  });

  test('should handle credential errors', async () => {
    // Mock failure
    getGitHubCredentials.mockRejectedValue(new Error('Authentication failed'));

    // Execute publish which should now fail
    const result = await publishPlugin();

    // Check error was properly handled
    expect(result.success).toBe(false);
    expect(result.message).toBe('Authentication failed');
  });
});

// End-to-end test stub for the CLI command
describe('Registry Publishing E2E', () => {
  test('should handle full publishing workflow', async () => {
    // Reset mocks
    vi.resetAllMocks();

    // Mock successful responses
    getGitHubCredentials.mockResolvedValue({
      username: 'testuser',
      token: 'mock-token',
    });
    publishToGitHub.mockResolvedValue(true);

    // Execute the full workflow
    const result = await publishPlugin();

    // Verify it was successful
    expect(result.success).toBe(true);
    expect(publishToGitHub).toHaveBeenCalled();
    expect(result.message).toBe('Published successfully');
  });
});

/**
 * Helper function to simulate publishing a plugin
 */
async function publishPlugin(options = {}) {
  try {
    // Get options with defaults
    const { dryRun = false, test = false, npmPublish = false, maintainer = 'testuser' } = options;

    // Get credentials
    const credentials = await getGitHubCredentials();

    // Create package.json with specified maintainer
    const packageJson = {
      ...samplePackageJson,
      maintainers: [maintainer],
    };

    // Execute based on mode
    if (test) {
      // Test mode
      const npmResult = npmPublish ? await testPublishToNpm('mock-dir') : true;
      const githubResult = await testPublishToGitHub('mock-dir', packageJson, credentials.username);

      return {
        success: npmResult && githubResult,
        message: 'Test completed',
      };
    }

    // Normal or dry run mode
    const githubResult = await publishToGitHub(
      'mock-dir',
      packageJson,
      '1.0.0', // CLI version
      credentials.username,
      dryRun
    );

    return {
      success: githubResult,
      message: dryRun ? 'Dry run completed' : 'Published successfully',
    };
  } catch (error) {
    return {
      success: false,
      message: error.message || 'Unknown error',
    };
  }
}

/**
 * Simulates CLI version checking logic
 * @param {string} currentVersion - Current CLI version
 */
async function checkForCliUpdates(currentVersion) {
  try {
    const response = await fetch('https://registry.npmjs.org/@elizaos/cli');
    const data = await response.json();

    // Get latest version
    const latestVersion = data['dist-tags']?.latest;

    // Compare versions
    if (latestVersion && latestVersion !== currentVersion) {
      console.warn(
        `[WARNING] There is a newer version of @elizaos/cli available: ${latestVersion}`
      );
      return true; // Update available
    }

    return false; // No update needed
  } catch (error) {
    // Silently fail version check - shouldn't block publishing
    return false;
  }
}
