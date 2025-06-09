import { logger } from '@elizaos/core';
import { StructuredMigrator } from './structured-migrator.js';
import type { MigrationResult, MigratorOptions } from './types.js';
import { emoji } from '../emoji-handler';
import { spawn } from 'child_process';
import { BRANCH_NAME } from './config.js';

// Helper function to replace execa
function execCommand(command: string, args: string[], options: { cwd: string; stdio?: 'pipe' | 'inherit' }): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: options.stdio || 'pipe'
    });

    let stdout = '';
    let stderr = '';

    if (options.stdio === 'pipe' && child.stdout && child.stderr) {
      child.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });
    }

    child.on('close', (code) => {
      resolve({ stdout, stderr, exitCode: code || 0 });
    });

    child.on('error', reject);
  });
}

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
        
        // Step 1: Run final build check
        logger.info('\n🔨 Running final build check...');
        try {
          const buildResult = await execCommand('bun', ['run', 'build'], {
            cwd: result.repoPath,
            stdio: 'inherit',
          });
          
          if (buildResult.exitCode !== 0) {
            throw new Error(`Build failed with exit code ${buildResult.exitCode}`);
          }
          logger.info('✅ Final build check passed');
        } catch (error) {
          logger.error('❌ Final build check failed');
          result.success = false;
        }
        
        // Step 2: Run final test suite (unless skipTests is true)
        if (!this.options.skipTests && result.success) {
          logger.info('\n🧪 Running final test suite...');
          try {
            const testResult = await execCommand('bun', ['run', 'test'], {
              cwd: result.repoPath,
              stdio: 'inherit',
            });
            
            if (testResult.exitCode !== 0) {
              throw new Error(`Tests failed with exit code ${testResult.exitCode}`);
            }
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
            const formatCheckResult = await execCommand('bun', ['run', 'format:check'], {
              cwd: result.repoPath,
              stdio: 'pipe',
            });
            
            if (formatCheckResult.exitCode === 0) {
              logger.info('✅ Format check passed');
            } else {
              throw new Error('Format check failed');
            }
          } catch (error) {
            logger.info('⚠️  Format check failed, running formatter...');
            try {
              const formatResult = await execCommand('bun', ['run', 'format'], {
                cwd: result.repoPath,
                stdio: 'pipe',
              });
              
              if (formatResult.exitCode === 0) {
                logger.info('✅ Code formatted successfully');
              } else {
                logger.warn('⚠️  Could not run formatter');
              }
            } catch (formatError) {
              logger.warn('⚠️  Could not run formatter');
            }
          }
        }
        
        // Step 4: Show git diff summary
        if (result.success) {
          logger.info('\n📊 Git diff summary:');
          try {
            const gitStatus = await execCommand('git', ['status', '--short'], {
              cwd: result.repoPath,
              stdio: 'pipe',
            });
            if (gitStatus.stdout) {
              logger.info('Modified files:');
              logger.info(gitStatus.stdout);
            }
            
            const gitDiff = await execCommand('git', ['diff', '--stat', `main...${result.branchName}`], {
              cwd: result.repoPath,
              stdio: 'pipe',
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
        branchName: BRANCH_NAME,
        repoPath: '',
        error: error as Error,
      };
    }
  }

  /**
   * Initialize OpenAI API client  
   * @deprecated Now handled internally by StructuredMigrator
   */
  async initializeOpenAI(): Promise<void> {
    logger.warn('initializeOpenAI() is deprecated and handled internally');
  }

  /**
   * Initialize Anthropic API client
   * @deprecated Now handled internally by StructuredMigrator
   */
  async initializeAnthropic(): Promise<void> {
    logger.warn('initializeAnthropic() is deprecated and handled internally');
  }
}
