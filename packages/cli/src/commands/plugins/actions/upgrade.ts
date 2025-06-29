import { handleError } from '@/src/utils';
import { logger } from '@elizaos/core';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { emoji } from '@/src/utils/emoji-handler';
import { UpgradePluginOptions } from '../types';
import { SimpleMigrationAgent } from '@/src/utils/upgrade/simple-migration-agent';
import chalk from 'chalk';
import { execa } from 'execa';

/**
 * Upgrade a plugin from version 0.x to 1.x using AI-powered migration with Claude Code SDK
 */
export async function upgradePlugin(pluginPath: string, opts: UpgradePluginOptions): Promise<void> {
  try {
    // Set API key if provided
    if (opts.apiKey) {
      process.env.ANTHROPIC_API_KEY = opts.apiKey;
    }

    // Check for API key
    if (!process.env.ANTHROPIC_API_KEY) {
      logger.error('ANTHROPIC_API_KEY is required for plugin upgrade.');
      console.log('\nPlease set ANTHROPIC_API_KEY environment variable or use --api-key option.');
      console.log('Get your API key from: https://console.anthropic.com/');
      process.exit(1);
    }

    // Validate API key format
    if (!process.env.ANTHROPIC_API_KEY.startsWith('sk-ant-')) {
      logger.error('Invalid ANTHROPIC_API_KEY format.');
      console.log('\nThe API key should start with "sk-ant-"');
      console.log('Get your API key from: https://console.anthropic.com/');
      process.exit(1);
    }

    // Test SDK import before proceeding (silent unless debug)
    try {
      await import('@anthropic-ai/claude-code');
      if (opts.debug) {
        console.log('✓ Claude Code SDK ready');
      }
    } catch (importError) {
      console.log(chalk.red('✗ Claude Code SDK not available'));
      console.log(chalk.red(`Error: ${importError instanceof Error ? importError.message : String(importError)}`));
      console.log('\nInstall the SDK: bun add @anthropic-ai/claude-code');
      process.exit(1);
    }

    // Resolve plugin path
    const resolvedPath = path.resolve(pluginPath);
    const workingDir = path.join(process.cwd(), 'temp-migration', path.basename(resolvedPath));

    // Show clean setup progress
    console.log(chalk.cyan('🔧 Setting up migration environment...'));
    
    // Use simple cp command to copy the entire directory
    await execa('rm', ['-rf', workingDir], { reject: false });
    await execa('mkdir', ['-p', path.dirname(workingDir)]);
    await execa('cp', ['-r', resolvedPath, workingDir]);

    // Copy migration guides to the working directory
    let projectRoot = process.cwd();
    while (projectRoot !== '/' && !existsSync(path.join(projectRoot, 'packages/docs'))) {
      projectRoot = path.dirname(projectRoot);
    }
    const guidesSource = path.join(projectRoot, 'packages/docs/docs/plugins/migration/claude-code');
    const guidesTarget = path.join(workingDir, 'migration-guides');

    await execa('mkdir', ['-p', guidesTarget]);
    await execa('cp', ['-r', guidesSource + '/.', guidesTarget]);

    console.log(chalk.green('✅ Environment ready'));

    // Show clean introduction
    console.log(chalk.bold('\n🚀 ElizaOS Plugin Migration (0.x → 1.x)'));
    console.log(chalk.gray('────────────────────────────────────────'));
    console.log('• Automated analysis and migration');
    console.log('• Comprehensive testing and validation');
    console.log('• Zero-downtime 1.x compatibility');
    
    if (opts.debug) {
      console.log(chalk.gray(`\nPlugin: ${resolvedPath}`));
      console.log(chalk.gray(`Working directory: ${workingDir}`));
    }

    // Confirm before proceeding
    if (!opts.skipConfirmation) {
      console.log(chalk.yellow('\n⚠️  This will modify files in the plugin directory.'));
      console.log(chalk.yellow('Ensure your changes are committed first.\n'));
      console.log('Starting in 3 seconds... (Press Ctrl+C to cancel)');
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }

    // Create simple migration agent using the working directory
    const agent = new SimpleMigrationAgent(workingDir, {
      verbose: opts.verbose || opts.debug,
    });

    // Set up event listeners for progress
    let messageCount = 0;
    agent.on('progress', (count) => {
      messageCount = count;
    });

    // Run migration
    const result = await agent.migrate();

    // Show clean results
    if (result.success) {
      console.log(chalk.green('\n🎉 Migration completed successfully!'));
      console.log(chalk.gray('────────────────────────────────────'));
      console.log(`📁 Location: ${chalk.cyan(path.basename(result.repoPath))}`);
      console.log(`⏱️  Duration: ${chalk.yellow(Math.round(result.duration / 1000) + 's')}`);
      console.log(`🤖 AI Operations: ${chalk.blue(result.messageCount)}`);

      console.log(chalk.bold('\n📋 Next Steps:'));
      console.log(`${chalk.gray('1.')} cd ${chalk.cyan(path.basename(result.repoPath))}`);
      console.log(`${chalk.gray('2.')} git checkout 1.x ${chalk.gray('# Review the migrated code')}`);
      console.log(`${chalk.gray('3.')} bun test ${chalk.gray('# Verify all tests pass')}`);
      console.log(`${chalk.gray('4.')} bun run build ${chalk.gray('# Verify the build')}`);
      console.log(`${chalk.gray('5.')} Test in a real project`);
      console.log(`${chalk.gray('6.')} Merge to main and publish 🚀\n`);
    } else {
      console.log(chalk.red('\n❌ Migration failed'));
      console.log(chalk.gray('──────────────────────'));
      
      if (result.error) {
        const errorMsg = result.error.message || String(result.error);
        console.log(chalk.red(`💥 ${errorMsg}`));
        
        if (opts.debug || opts.verbose) {
          console.log(chalk.gray('\nDetailed error:'));
          console.log(chalk.gray(result.error.stack || result.error.message));
        }
      }

      console.log(chalk.yellow('\n🔧 Quick fixes:'));
      console.log('• Check plugin structure follows ElizaOS standards');
      console.log('• Verify ANTHROPIC_API_KEY is valid');
      console.log('• Try with --debug for detailed output');
      console.log('• Ensure all dependencies are installed\n');

      process.exit(1);
    }
  } catch (error) {
    console.log('\n' + chalk.red('✗ Plugin upgrade failed!'));

    if (opts.debug || opts.verbose) {
      console.log('\n' + chalk.bold('Detailed Error Information:'));
      console.log(chalk.red(error instanceof Error ? error.stack : String(error)));
    } else {
      console.log(chalk.red(`\nError: ${error instanceof Error ? error.message : String(error)}`));
    }

    console.log('\n' + chalk.yellow('Troubleshooting Tips:'));
    console.log('1. Check that your plugin follows standard ElizaOS structure');
    console.log('2. Ensure all dependencies are installed');
    console.log('3. Try running with --verbose or --debug for more details');
    console.log('4. Verify your ANTHROPIC_API_KEY is valid');

    handleError(error);
    process.exit(1);
  }
}
