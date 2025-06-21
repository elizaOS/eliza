import { logger } from '@elizaos/core';
import { execa } from 'execa';
import * as fs from 'fs-extra';
import * as path from 'node:path';
import { globby } from 'globby';
import type { StepResult } from '../types.js';
import { TestManager } from './test-manager.js';
import { validateV2Imports, validatePackageJson, detectActualService } from './migration-utilities.js';

/**
 * Validation engine for migration process
 */
export class ValidationEngine {
  private testManager: TestManager;

  constructor(private repoPath: string, private skipTests = false) {
    this.testManager = new TestManager(repoPath);
  }

  /**
   * Validate that this is actually a V1 plugin that needs migration
   */
  async validateV1Structure(): Promise<void> {
    const packageJsonPath = path.join(this.repoPath, 'package.json');
    
    if (!(await fs.pathExists(packageJsonPath))) {
      throw new Error('No package.json found - this does not appear to be a Node.js project');
    }
    
    const packageJson = await fs.readJson(packageJsonPath);
    
    // Check if it's a plugin
    const isPlugin = packageJson.name?.includes('plugin');
    
    if (!isPlugin) {
      throw new Error('This does not appear to be a plugin project');
    }
    
    // Check if it's V1 (has old dependencies or patterns)
    const hasV1Dependencies = 
      packageJson.dependencies?.['@ai16z/eliza'] ||
      packageJson.dependencies?.['@elizaos/core']?.startsWith('0.') ||
      packageJson.devDependencies?.vitest ||
      packageJson.devDependencies?.jest;
    
    // Check for V1 file patterns
    const hasV1Files = await fs.pathExists(path.join(this.repoPath, '__tests__')) ||
                       await fs.pathExists(path.join(this.repoPath, 'vitest.config.ts')) ||
                       await fs.pathExists(path.join(this.repoPath, 'biome.json'));
    
    if (!hasV1Dependencies && !hasV1Files) {
      logger.warn('⚠️  This plugin may already be V2 compatible or not need migration');
      logger.warn('Continuing anyway, but migration may not be necessary');
    }
    
    logger.info('✅ V1 plugin structure validated');
  }

  /**
   * Run comprehensive final validation
   */
  async runFinalValidation(): Promise<StepResult> {
    logger.info('🔍 Running final validation...');

    const results = {
      build: false,
      tests: false,
      format: false,
      testDetails: null as StepResult | null,
    };

    // Check build
    try {
      await execa('bun', ['run', 'build'], {
        cwd: this.repoPath,
        stdio: 'pipe',
        timeout: 120000,
      });
      results.build = true;
      logger.info('✅ Build check passed');
    } catch (error) {
      logger.warn('❌ Build check failed');
    }

    // Check tests - ONLY if build passed
    if (!this.skipTests && results.build) {
      const testResult = await this.testManager.runTestsWithDetailedError();
      results.tests = testResult.success;
      results.testDetails = testResult;
      
      if (!testResult.success && testResult.warnings) {
        logger.warn('Test failure details:', testResult.warnings.join(', '));
      }
    } else if (this.skipTests) {
      results.tests = true; // Consider tests passed if skipped
    }

    // Check formatting
    try {
      await execa('bun', ['run', 'format:check'], {
        cwd: this.repoPath,
        stdio: 'pipe',
      });
      results.format = true;
      logger.info('✅ Format check passed');
    } catch (error) {
      logger.warn('❌ Format check failed - run "bun run format"');
    }

    const allPassed = results.build && results.tests && results.format;

    const warnings: string[] = [
      !results.build ? 'Build failed' : undefined,
      !results.tests && !this.skipTests ? 'Tests failed' : undefined,
      !results.format ? 'Formatting issues' : undefined,
    ].filter(Boolean) as string[];

    // Add detailed test warnings if available
    if (results.testDetails && !results.testDetails.success && results.testDetails.warnings) {
      warnings.push(...results.testDetails.warnings);
    }

    return {
      success: allPassed,
      message: allPassed ? 'All validation checks passed' : 'Some validation checks failed',
      warnings,
    };
  }

  /**
   * Validate V2 compliance across the codebase
   */
  async validateV2Compliance(): Promise<{
    success: boolean;
    issues: string[];
    warnings: string[];
  }> {
    logger.info('🔍 Validating V2 compliance...');
    
    const issues: string[] = [];
    const warnings: string[] = [];

    try {
      // Check imports
      const importIssues = await validateV2Imports(this.repoPath);
      issues.push(...importIssues);

      // Check package.json
      const packageIssues = await validatePackageJson(this.repoPath);
      issues.push(...packageIssues);

      // Check for V1 patterns in code
      const codeIssues = await this.checkForV1Patterns();
      issues.push(...codeIssues);

      // Check file structure
      const structureIssues = await this.validateV2FileStructure();
      issues.push(...structureIssues);

      // Check service implementation if exists
      const serviceIssues = await this.validateServiceImplementation();
      if (serviceIssues.length > 0) {
        warnings.push(...serviceIssues);
      }

    } catch (error) {
      logger.error('Error during V2 compliance validation:', error);
      issues.push(`Validation error: ${error}`);
    }

    const success = issues.length === 0;
    
    if (success) {
      logger.info('✅ V2 compliance validation passed');
    } else {
      logger.warn(`⚠️  Found ${issues.length} V2 compliance issues`);
    }

    return { success, issues, warnings };
  }

  /**
   * Check for remaining V1 patterns in the code
   */
  private async checkForV1Patterns(): Promise<string[]> {
    const issues: string[] = [];
    
    try {
      const sourceFiles = await globby(['src/**/*.ts'], {
        cwd: this.repoPath,
        ignore: ['node_modules/**', 'dist/**']
      });

      for (const file of sourceFiles) {
        const filePath = path.join(this.repoPath, file);
        const content = await fs.readFile(filePath, 'utf-8');

        // Check for V1 patterns
        const v1Patterns = [
          { pattern: /ModelClass/g, description: 'ModelClass should be ModelType' },
          { pattern: /elizaLogger/g, description: 'elizaLogger should be logger' },
          { pattern: /runtime\.memory\.create/g, description: 'Old memory API usage' },
          { pattern: /runtime\.messageManager\.createMemory/g, description: 'Old message manager API' },
          { pattern: /runtime\.language\.generateText/g, description: 'Old language API usage' },
          { pattern: /Promise<boolean>/g, description: 'V1 handler return type' },
          { pattern: /@ai16z\/eliza/g, description: 'V1 package import' },
        ];

        for (const { pattern, description } of v1Patterns) {
          const matches = content.match(pattern);
          if (matches) {
            issues.push(`${file}: ${description} (${matches.length} occurrences)`);
          }
        }
      }
    } catch (error) {
      logger.warn('Could not check for V1 patterns:', error);
    }

    return issues;
  }

  /**
   * Validate V2 file structure
   */
  private async validateV2FileStructure(): Promise<string[]> {
    const issues: string[] = [];

    // Check for required files
    const requiredFiles = [
      'src/index.ts',
      'package.json',
    ];

    for (const file of requiredFiles) {
      const filePath = path.join(this.repoPath, file);
      if (!(await fs.pathExists(filePath))) {
        issues.push(`Missing required file: ${file}`);
      }
    }

    // Check for V1 file patterns that should be removed
    const v1Files = [
      '__tests__',
      'vitest.config.ts',
      'biome.json',
      '.vitest',
    ];

    for (const file of v1Files) {
      const filePath = path.join(this.repoPath, file);
      if (await fs.pathExists(filePath)) {
        issues.push(`V1 file pattern should be removed: ${file}`);
      }
    }

    // Check test file structure
    const testFilePath = path.join(this.repoPath, 'src/test/test.ts');
    const hasCorrectTestFile = await fs.pathExists(testFilePath);
    
    // Check for incorrect test file patterns
    const incorrectTestPatterns = [
      'src/test/*.test.ts',
      'src/test/*.spec.ts',
      'src/**/*.test.ts',
      'src/**/*.spec.ts',
    ];

    for (const pattern of incorrectTestPatterns) {
      const files = await globby([pattern], { cwd: this.repoPath });
      if (files.length > 0) {
        issues.push(`Incorrect test file pattern found: ${files.join(', ')} (should be src/test/test.ts)`);
      }
    }

    return issues;
  }

  /**
   * Validate service implementation if it exists
   */
  private async validateServiceImplementation(): Promise<string[]> {
    const warnings: string[] = [];

    try {
      // Get all files to check for services
      const files = await globby(['src/**/*.ts'], {
        cwd: this.repoPath,
        ignore: ['node_modules/**', 'dist/**']
      });

      const hasService = await detectActualService(files, this.repoPath);
      
      if (hasService) {
        // If service exists, validate its implementation
        const serviceFiles = files.filter(f => 
          path.basename(f) === 'service.ts' || path.basename(f) === 'Service.ts'
        );

        for (const serviceFile of serviceFiles) {
          const fullPath = path.join(this.repoPath, serviceFile);
          const content = await fs.readFile(fullPath, 'utf-8');

          // Check for V2 service patterns
          if (!content.includes('extends Service')) {
            warnings.push(`Service ${serviceFile} should extend Service class`);
          }

          if (!content.includes('static serviceType')) {
            warnings.push(`Service ${serviceFile} should have static serviceType property`);
          }

          if (!content.includes('static async start')) {
            warnings.push(`Service ${serviceFile} should have static async start method`);
          }

          if (!content.includes('async stop')) {
            warnings.push(`Service ${serviceFile} should have async stop method`);
          }
        }
      }
    } catch (error) {
      logger.warn('Could not validate service implementation:', error);
    }

    return warnings;
  }

  /**
   * Validate build system
   */
  async validateBuildSystem(): Promise<string[]> {
    const issues: string[] = [];

    // Check package.json build configuration
    const packageJsonPath = path.join(this.repoPath, 'package.json');
    if (await fs.pathExists(packageJsonPath)) {
      const packageJson = await fs.readJson(packageJsonPath);

      if (!packageJson.scripts?.build) {
        issues.push('No build script found in package.json');
      }

      if (!packageJson.type || packageJson.type !== 'module') {
        issues.push('package.json should have "type": "module"');
      }

      if (!packageJson.exports) {
        issues.push('package.json should have exports field');
      }
    }

    // Check TypeScript configuration
    const tsconfigPath = path.join(this.repoPath, 'tsconfig.json');
    if (await fs.pathExists(tsconfigPath)) {
      const tsconfig = await fs.readJson(tsconfigPath);
      
      if (tsconfig.compilerOptions?.target && !['ES2022', 'ESNext'].includes(tsconfig.compilerOptions.target)) {
        issues.push('TypeScript target should be ES2022 or ESNext');
      }

      if (tsconfig.compilerOptions?.module && !['ESNext', 'Node16', 'NodeNext'].includes(tsconfig.compilerOptions.module)) {
        issues.push('TypeScript module should be ESNext, Node16, or NodeNext');
      }
    }

    return issues;
  }

  /**
   * Run quick validation check
   */
  async runQuickValidation(): Promise<boolean> {
    try {
      // Just check if files can be parsed without running full build
      const sourceFiles = await globby(['src/**/*.ts'], {
        cwd: this.repoPath,
        ignore: ['node_modules/**', 'dist/**']
      });

      for (const file of sourceFiles) {
        const filePath = path.join(this.repoPath, file);
        const content = await fs.readFile(filePath, 'utf-8');
        
        // Basic syntax check - try to parse as TypeScript
        if (content.includes('import ') && !content.includes('from ')) {
          logger.warn(`Potential syntax issue in ${file}: import without from`);
          return false;
        }
      }

      return true;
    } catch (error) {
      logger.warn('Quick validation failed:', error);
      return false;
    }
  }
} 