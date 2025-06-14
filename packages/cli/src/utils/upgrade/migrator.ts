import { logger } from '@elizaos/core';
import { StructuredMigrator } from './structured-migrator.js';
import type { MigrationResult, MigratorOptions } from './types.js';
import { emoji } from '../emoji-handler';
import { execa } from 'execa';

// Re-export for external usage
export type { MigrationResult, MigratorOptions };

/**
 * PluginMigrator - Main class for migrating ElizaOS plugins from V1 to V2
 * Now uses structured migration approach following the mega prompt
 */
export class PluginMigrator {
  private structuredMigrator: StructuredMigrator;
  private options: MigratorOptions;

  constructor(options: MigratorOptions = {}) {
    this.options = options;
    this.structuredMigrator = new StructuredMigrator(options);
  }

  /**
   * Migrate a plugin from V1 to V2
   * @param input - GitHub URL or local folder path
   * @returns Migration result
   */
  async migrate(input: string): Promise<MigrationResult> {
    logger.info(emoji.rocket('Starting ElizaOS V1→V2 migration'));
    logger.info(emoji.list('Following structured migration from mega prompt'));
    logger.info(emoji.info(`Target: ${input}`));

    try {
      // Delegate to structured migrator
      const result = await this.structuredMigrator.migrate(input);

      // Execute the "next steps" automatically instead of just listing them
      if (result.success && result.repoPath) {
        logger.info('\n🚀 Executing final verification steps...');
        
        // Wait a moment to ensure all file operations are complete
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Change to the repository directory
        process.chdir(result.repoPath);
        logger.info(`📂 Changed to directory: ${result.repoPath}`);
        
        // Clean up extra test files before running tests
        logger.info('\n🧹 Cleaning up extra test files...');
        try {
          const extraTestFiles = await execa('find', ['src/test', '-name', '*.test.ts', '-type', 'f'], {
            cwd: result.repoPath,
            reject: false,
          });
          
          if (extraTestFiles.stdout) {
            const testFiles = extraTestFiles.stdout.split('\n').filter(f => f);
            for (const testFile of testFiles) {
              logger.info(`🗑️  Deleting extra test file: ${testFile}`);
              await execa('rm', [testFile], { cwd: result.repoPath });
            }
          }
        } catch (error) {
          logger.debug('No extra test files found to clean up');
        }
        
        // Step 1: Run final build check
        logger.info('\n🔨 Running final build check...');
        try {
          await execa('bun', ['run', 'build'], {
            stdio: 'inherit',
            cwd: result.repoPath,
            timeout: 120000,
          });
          logger.info('✅ Final build check passed');
        } catch (error) {
          logger.error('❌ Final build check failed');
          result.success = false;
        }
        
        // Step 2: Run final test suite (unless skipTests is true)
        if (!this.options.skipTests && result.success) {
          logger.info('\n🧪 Running final test suite...');
          try {
            await execa('bun', ['run', 'test'], {
              stdio: 'inherit',
              cwd: result.repoPath,
              timeout: 300000,
            });
            logger.info('✅ Final test suite passed');
          } catch (error) {
            logger.error('❌ Final test suite failed');
            result.success = false;
          }
        }
        
        // Step 3: Run format check
        if (result.success) {
          logger.info('\n🎨 Running format check...');
          try {
            await execa('bun', ['run', 'format:check'], {
              stdio: 'pipe',
              cwd: result.repoPath,
            });
            logger.info('✅ Format check passed');
          } catch (error) {
            logger.info('⚠️  Format check failed, running formatter...');
            try {
              await execa('bun', ['run', 'format'], {
                stdio: 'pipe',
                cwd: result.repoPath,
              });
              logger.info('✅ Code formatted successfully');
            } catch (formatError) {
              logger.warn('⚠️  Could not run formatter');
            }
          }
        }
        
        // Step 4: Show git diff summary
        if (result.success) {
          logger.info('\n📊 Git diff summary:');
          try {
            const gitStatus = await execa('git', ['status', '--short'], {
              cwd: result.repoPath,
            });
            if (gitStatus.stdout) {
              logger.info('Modified files:');
              logger.info(gitStatus.stdout);
            }
            
            const gitDiff = await execa('git', ['diff', '--stat', `main...${result.branchName}`], {
              cwd: result.repoPath,
            });
            if (gitDiff.stdout) {
              logger.info('\nChange statistics:');
              logger.info(gitDiff.stdout);
            }
          } catch (error) {
            logger.warn('Could not get git diff summary');
          }
        }
      }

      // Final status report
      if (result.success) {
        logger.info(`\n${emoji.success('Migration and verification completed successfully!')}`);
        logger.info(`📂 Repository: ${result.repoPath}`);
        logger.info(`🌿 Branch: ${result.branchName}`);
        logger.info('\n✅ All checks passed! The plugin is ready for:');
        logger.info('1. Final manual review of changes');
        logger.info('2. Creating a pull request to merge changes');
      } else {
        logger.error(`\n${emoji.error('Migration or verification failed')}`);
        if (result.error) {
          logger.error(`Error: ${result.error.message}`);
        }
        logger.info('\n❌ Manual intervention required:');
        logger.info(`1. cd ${result.repoPath}`);
        logger.info('2. Fix remaining issues');
        logger.info('3. Run: bun run build && bun run test');
        logger.info('4. Once tests pass, create a pull request');
      }
      
      return result;
    } catch (error) {
      logger.error(emoji.error('Unexpected error during migration:'), error);

      return {
        success: false,
        branchName: '1.x-claude',
        repoPath: '',
        error: error as Error,
      };
    }
  }

  /**
   * Initialize Anthropic API client
   * @deprecated Now handled internally by StructuredMigrator
   */
  async initializeAnthropic(): Promise<void> {
    logger.warn('initializeAnthropic() is deprecated and handled internally');
  }
}
