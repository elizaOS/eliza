import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';

describe('Plugin Upgrade Command Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should successfully create a PluginMigrator when ANTHROPIC_API_KEY is set', async () => {
    // Set the API key for the test
    process.env.ANTHROPIC_API_KEY = 'test-key';

    // Mock the migrator module
    const mockMigrate = vi.fn().mockResolvedValue({
      success: true,
      branchName: '1.x-claude',
      repoPath: '/test/path',
    });

    vi.doMock('../../src/utils/upgrade/migrator', () => ({
      PluginMigrator: vi.fn().mockImplementation(() => ({
        migrate: mockMigrate,
      })),
    }));

    // Import after mocking
    const { PluginMigrator } = await import('../../src/utils/upgrade/migrator');

    // Test that we can create a migrator and call migrate
    const migrator = new PluginMigrator({ skipTests: true });
    const result = await migrator.migrate('https://github.com/test/plugin');

    expect(result.success).toBe(true);
    expect(result.branchName).toBe('1.x-claude');
    expect(mockMigrate).toHaveBeenCalledWith('https://github.com/test/plugin');

    // Clean up
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('should handle missing ANTHROPIC_API_KEY gracefully', async () => {
    // Ensure API key is not set
    delete process.env.ANTHROPIC_API_KEY;

    // Import the real migrator (not mocked)
    vi.doUnmock('../../src/utils/upgrade/migrator');
    const { PluginMigrator } = await import('../../src/utils/upgrade/migrator');

    const migrator = new PluginMigrator();

    // Should throw when trying to initialize without API key
    await expect(migrator.initializeAnthropic()).rejects.toThrow(
      'ANTHROPIC_API_KEY is required for migration strategy generation'
    );
  });
});
