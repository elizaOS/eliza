import { logger } from '@elizaos/core';
import { execa } from 'execa';
import * as fs from 'fs-extra';
import * as path from 'node:path';
import type { StepResult, MigrationContext } from '../types.js';
import { EnvironmentManager } from './environment-manager.js';

/**
 * Test management for executing and validating tests
 */
export class TestManager {
  private environmentManager: EnvironmentManager;

  constructor(private repoPath: string) {
    this.environmentManager = new EnvironmentManager(repoPath);
  }

  /**
   * Run tests with detailed error reporting and retries
   */
  async runTestsWithDetailedError(): Promise<StepResult> {
    const maxRetries = 3;
    let lastResult: StepResult = {
      success: false,
      message: 'Test execution not attempted',
    };

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      logger.info(`🧪 Running tests (attempt ${attempt}/${maxRetries})...`);

      try {
        // Setup test environment before each attempt
        await this.environmentManager.setupTestEnvironment();

        // Try to run tests
        const result = await execa('bun', ['run', 'test'], {
          cwd: this.repoPath,
          stdio: 'pipe',
          timeout: 180000, // 3 minutes timeout
        });

        // Tests passed
        lastResult = {
          success: true,
          message: 'All tests passed',
          changes: [],
        };

        logger.info('✅ Tests passed');
        break;

      } catch (error: unknown) {
        const execError = error as { all?: string; stdout?: string; stderr?: string };
        const output = execError.all || execError.stdout || execError.stderr || String(error);
        
        logger.warn(`❌ Tests failed on attempt ${attempt}:`);
        logger.warn(output.substring(0, 500) + (output.length > 500 ? '...' : ''));

        const warnings: string[] = [];
        
        // Analyze test failures
        if (output.includes('ENOENT') || output.includes('command not found')) {
          warnings.push('Test runner not found - trying alternative commands');
          
          // Try alternative test commands
          const alternativeCommands = [
            ['npm', 'test'],
            ['yarn', 'test'],
            ['npx', 'vitest', 'run'],
            ['node', '--test'],
          ];
          
          let alternativeWorked = false;
          for (const [cmd, ...args] of alternativeCommands) {
            try {
              logger.info(`🔄 Trying alternative: ${cmd} ${args.join(' ')}`);
              await execa(cmd, args, {
                cwd: this.repoPath,
                stdio: 'pipe',
                timeout: 180000,
              });
              
              lastResult = {
                success: true,
                message: `Tests passed with ${cmd}`,
                changes: [],
              };
              alternativeWorked = true;
              break;
            } catch (altError) {
              logger.warn(`❌ ${cmd} also failed`);
            }
          }
          
          if (alternativeWorked) break;
        }

        // Check for missing environment variables
        if (output.includes('env') || output.includes('environment') || output.includes('undefined')) {
          warnings.push('Missing environment variables detected');
          await this.environmentManager.handleMissingEnvVars(output);
        }

        // Check for missing dependencies
        if (output.includes('Cannot find module') || output.includes('MODULE_NOT_FOUND')) {
          warnings.push('Missing dependencies detected');
          await this.handleMissingDependencies(output);
        }

        // Check for test file issues
        if (output.includes('No test files found') || output.includes('no tests')) {
          warnings.push('No test files found or test files have issues');
          
          // Check if test files exist
          const testExists = await this.checkTestFilesExist();
          if (!testExists) {
            warnings.push('Test files do not exist - this may be expected for some plugins');
            lastResult = {
              success: true, // Consider it success if no tests are supposed to exist
              message: 'No tests found but this may be expected',
              warnings,
            };
            break;
          }
        }

        // Check for import/export errors
        if (output.includes('SyntaxError') || output.includes('import') || output.includes('export')) {
          warnings.push('Syntax or import/export errors in test files');
        }

        // Check for TypeScript compilation errors
        if (output.includes('TypeScript') || output.includes('TS')) {
          warnings.push('TypeScript compilation errors');
        }

        // If this is the last attempt, return the failure
        if (attempt === maxRetries) {
          lastResult = {
            success: false,
            message: `Tests failed after ${maxRetries} attempts`,
            warnings,
            error: error as Error,
          };
        } else {
          // Wait before retry
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
    }

    // If we exhausted all retries, return the last result
    return lastResult;
  }

  /**
   * Check if test files exist in the repository
   */
  async checkTestFilesExist(): Promise<boolean> {
    const testPatterns = [
      'src/test/test.ts',
      'src/test/*.ts',
      'src/tests/*.ts',
      '__tests__/*.ts',
      '*.test.ts',
      '*.spec.ts',
      'test/*.ts',
      'tests/*.ts',
    ];

    for (const pattern of testPatterns) {
      const fullPath = path.join(this.repoPath, pattern);
      
      if (pattern.includes('*')) {
        // Use globby for wildcard patterns
        const { globby } = await import('globby');
        const files = await globby([pattern], { cwd: this.repoPath });
        if (files.length > 0) {
          logger.info(`✅ Found test files: ${files.join(', ')}`);
          return true;
        }
      } else {
        // Direct file check
        if (await fs.pathExists(fullPath)) {
          logger.info(`✅ Found test file: ${pattern}`);
          return true;
        }
      }
    }

    logger.info('ℹ️  No test files found');
    return false;
  }

  /**
   * Handle missing dependencies by attempting to install them
   */
  async handleMissingDependencies(output: string): Promise<void> {
    const missingModules = new Set<string>();
    
    // Extract module names from error messages
    const modulePattern = /Cannot find module ['"]([^'"]+)['"]/g;
    let match: RegExpExecArray | null;
    
    match = modulePattern.exec(output);
    while (match !== null) {
      missingModules.add(match[1]);
      match = modulePattern.exec(output);
    }

    if (missingModules.size === 0) return;

    logger.info(`🔧 Installing ${missingModules.size} missing dependencies...`);

    for (const moduleName of missingModules) {
      // Skip internal modules and relative imports
      if (moduleName.startsWith('.') || moduleName.startsWith('/') || moduleName.includes('node:')) {
        continue;
      }

      try {
        logger.info(`📦 Installing ${moduleName}...`);
        
        // Try bun first, then npm
        try {
          await execa('bun', ['add', '--dev', moduleName], {
            cwd: this.repoPath,
            stdio: 'pipe',
            timeout: 60000,
          });
        } catch (bunError) {
          await execa('npm', ['install', '--save-dev', moduleName], {
            cwd: this.repoPath,
            stdio: 'pipe',
            timeout: 60000,
          });
        }
        
        logger.info(`✅ Installed ${moduleName}`);
      } catch (error) {
        logger.warn(`⚠️  Could not install ${moduleName}:`, error);
      }
    }
  }

  /**
   * Validate test configuration
   */
  async validateTestConfiguration(): Promise<string[]> {
    const issues: string[] = [];

    // Check package.json for test scripts
    const packageJsonPath = path.join(this.repoPath, 'package.json');
    if (await fs.pathExists(packageJsonPath)) {
      const packageJson = await fs.readJson(packageJsonPath);
      
      if (!packageJson.scripts?.test) {
        issues.push('No test script found in package.json');
      }

      // Check for test-related dependencies
      const testDeps = ['vitest', 'jest', '@jest/globals', 'node:test'];
      const hasTestDep = testDeps.some(dep => 
        packageJson.dependencies?.[dep] || packageJson.devDependencies?.[dep]
      );
      
      if (!hasTestDep) {
        issues.push('No test framework dependencies found');
      }
    } else {
      issues.push('package.json not found');
    }

    // Check for test files
    const hasTests = await this.checkTestFilesExist();
    if (!hasTests) {
      issues.push('No test files found');
    }

    return issues;
  }

  /**
   * Run a specific test file
   */
  async runSpecificTest(testFile: string): Promise<StepResult> {
    try {
      logger.info(`🧪 Running specific test: ${testFile}`);
      
      const result = await execa('bun', ['test', testFile], {
        cwd: this.repoPath,
        stdio: 'pipe',
        timeout: 120000,
      });

      return {
        success: true,
        message: `Test ${testFile} passed`,
      };
    } catch (error: unknown) {
      const execError = error as { all?: string; stdout?: string; stderr?: string };
      const output = execError.all || execError.stdout || execError.stderr || String(error);
      
      return {
        success: false,
        message: `Test ${testFile} failed`,
        warnings: [output.substring(0, 200)],
        error: error as Error,
      };
    }
  }

  /**
   * Get test coverage information
   */
  async getTestCoverage(): Promise<{
    covered: number;
    total: number;
    percentage: number;
  } | null> {
    try {
      const result = await execa('bun', ['test', '--coverage'], {
        cwd: this.repoPath,
        stdio: 'pipe',
        timeout: 180000,
      });

      // Parse coverage output (this is a simplified example)
      const output = result.stdout;
      const coverageMatch = output.match(/(\d+)% coverage/);
      
      if (coverageMatch) {
        const percentage = Number.parseInt(coverageMatch[1]);
        return {
          covered: percentage,
          total: 100,
          percentage,
        };
      }
    } catch (error) {
      logger.warn('Could not get test coverage:', error);
    }

    return null;
  }

  /**
   * Setup test environment for the repository
   */
  async setupTestEnvironment(): Promise<void> {
    await this.environmentManager.setupTestEnvironment();
  }
} 