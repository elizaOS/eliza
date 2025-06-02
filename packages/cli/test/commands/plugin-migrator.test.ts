import { describe, it, expect } from 'vitest';
import { PluginMigrator } from '../../src/utils/upgrade/migrator';

describe('PluginMigrator', () => {
  it('should be constructable with default options', () => {
    const migrator = new PluginMigrator();
    expect(migrator).toBeDefined();
    expect(migrator).toBeInstanceOf(PluginMigrator);
  });

  it('should accept options in constructor', () => {
    const migrator = new PluginMigrator({
      skipTests: true,
      skipValidation: true,
    });
    expect(migrator).toBeDefined();
    expect(migrator).toBeInstanceOf(PluginMigrator);
  });

  it('should throw error when ANTHROPIC_API_KEY is not set', async () => {
    const originalKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    const migrator = new PluginMigrator();

    await expect(migrator.initializeAnthropic()).rejects.toThrow(
      'ANTHROPIC_API_KEY is required for migration strategy generation'
    );

    // Restore the key
    if (originalKey) {
      process.env.ANTHROPIC_API_KEY = originalKey;
    }
  });
});
