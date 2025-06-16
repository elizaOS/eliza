import { handleError } from '@/src/utils';
import { logger } from '@elizaos/core';
import path from 'node:path';
import { emoji } from '@/src/utils/emoji-handler';
import { UpgradePluginOptions, MigrationResult } from '../types';

/**
 * Upgrade a plugin from version 0.x to 1.x using AI-powered migration
 */
export async function upgradePlugin(pluginPath: string, opts: UpgradePluginOptions): Promise<void> {
  try {
    // Lazy import to avoid loading dependencies until needed
    const { PluginMigrator } = await import('@/src/utils/upgrade/migrator.js');

    // Set API key if provided
    if (opts.apiKey) {
      process.env.ANTHROPIC_API_KEY = opts.apiKey;
    }

    // Check for API key
    if (!process.env.ANTHROPIC_API_KEY) {
      logger.error('ANTHROPIC_API_KEY is required for plugin upgrade.');
      console.log('\nPlease set ANTHROPIC_API_KEY environment variable or use --api-key option.');
      process.exit(1);
    }

    // Create migrator instance with options
    const migrator = new PluginMigrator({
      skipTests: opts.skipTests,
      skipValidation: opts.skipValidation,
    });

    // Run migration
    console.log(`\n${emoji.rocket(`Starting plugin upgrade for: ${pluginPath}`)}\n`);
    const result: MigrationResult = await migrator.migrate(pluginPath);

    if (result.success) {
      console.log(`\n${emoji.success('Plugin successfully upgraded!')}`);
      console.log(`   Branch: ${result.branchName}`);
      console.log(`   Location: ${result.repoPath}`);
      console.log(`\nThe upgraded plugin has been copied to your current directory.`);
      console.log(`\nNext steps:`);
      console.log(`1. cd ${path.basename(result.repoPath ?? '')}`);
      console.log(`2. Review the changes`);
      console.log(`3. Test the upgraded plugin thoroughly`);
      console.log(`4. Push to GitHub and create a pull request when ready`);
    } else {
      logger.error(`Plugin upgrade failed: ${result.error?.message}`);
      process.exit(1);
    }
  } catch (error) {
    handleError(error);
    process.exit(1);
  }
}
