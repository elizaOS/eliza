import { logger } from '@elizaos/core';
import * as path from 'node:path';
import { globby } from 'globby';
import type { MigrationContext, MigratorOptions, StepResult } from '../types.js';
import { detectActualService } from './migration-utilities.js';
import { ValidationEngine } from './validation-engine.js';
import { StructuredMigrator } from './structured-migrator.js';
import { RepositoryManager } from './repository-manager.js';
import { FileOperations } from './file-operations.js';
import { EnvPrompter, type EnvVarPrompt } from '../env-prompter.js';
import * as fs from 'fs-extra';

// TODO: Import from actual claude-sdk-adapter once available
function createSessionManager() { return undefined; }
function createMigrationMetricsCollector() { return undefined; }

/**
 * Migration orchestrator handles the complete migration workflow
 * using the structured migration approach
 */
export class MigrationOrchestrator {
  private repoManager: RepositoryManager;
  private fileOps: FileOperations;
  private validationEngine: ValidationEngine;
  private structuredMigrator: StructuredMigrator;
  private envPrompter: EnvPrompter;

  constructor(private repoPath: string, private options: MigratorOptions = {}) {
    this.repoManager = new RepositoryManager();
    this.fileOps = new FileOperations(repoPath);
    this.validationEngine = new ValidationEngine(repoPath, options.skipTests);
    this.structuredMigrator = new StructuredMigrator(options);
    this.envPrompter = new EnvPrompter();
  }

  /**
   * Create migration context with enhanced service detection
   */
  async createMigrationContext(): Promise<MigrationContext> {
    // Read package.json
    const packageJsonPath = path.join(this.repoPath, 'package.json');
    const packageJson = await fs.readJson(packageJsonPath);

    // Get existing files
    const existingFiles = await globby(['**/*'], {
      cwd: this.repoPath,
      ignore: ['node_modules/**', 'dist/**', '.git/**'],
    });

    // IMPROVED: Enhanced service detection with proper validation
    let hasServiceInMainBranch = false;
    try {
      // Check main branch for service files with more accurate detection
      hasServiceInMainBranch = await detectActualService(existingFiles, this.repoPath);
      
      logger.info(`🔍 Enhanced service check: ${hasServiceInMainBranch ? 'Found valid service in main branch' : 'No service in main branch'}`);
    } catch (error) {
      logger.warn('Could not check for service, using current files only');
      // Fallback to current branch check with improved detection
      hasServiceInMainBranch = await detectActualService(existingFiles, this.repoPath);
    }

    // Analyze plugin structure
    const hasService = hasServiceInMainBranch; // ONLY true if service existed in main branch
    const hasProviders = existingFiles.some(
      (f) => f.includes('provider') || f.includes('Provider')
    );
    const hasActions = existingFiles.some((f) => f.includes('action') || f.includes('Action'));
    const hasTests = existingFiles.some(
      (f) => f.includes('__tests__') || f.includes('test.ts') || f.includes('.test.') || f.includes('src/tests/')
    );

    const pluginName = packageJson.name.replace('@elizaos/plugin-', '').replace('plugin-', '');

    return {
      repoPath: this.repoPath,
      pluginName,
      hasService,
      hasProviders,
      hasActions,
      hasTests,
      packageJson,
      existingFiles,
      changedFiles: new Set(),
      claudePrompts: new Map(),
      // NEW: Enhanced SDK context
      abortController: new AbortController(),
      sessionManager: undefined, // TODO: createSessionManager(),
      metricsCollector: undefined, // TODO: createMigrationMetricsCollector(),
    };
  }

  /**
   * Log migration summary with enhanced metrics
   */
  logMigrationSummary(
    context: MigrationContext, 
    branchName: string, 
    migrationFullySuccessful: boolean,
    iterationCounts: {
      preVerification: number;
      postMigration: number;
    },
    buildSuccess: boolean,
    testSuccess: boolean
  ): void {
    logger.info('\n📝 Migration Summary:');
    logger.info(`- Repository: ${this.repoPath}`);
    logger.info(`- Branch: ${branchName}`);
    logger.info(`- Files changed: ${context.changedFiles.size}`);
    logger.info(`- Pre-verification iterations: ${iterationCounts.preVerification}`);
    logger.info(`- Post-migration iterations: ${iterationCounts.postMigration}`);
    logger.info(`- Build status: ${buildSuccess ? '✅ Passing' : '❌ Failing'}`);
    logger.info(`- Test status: ${testSuccess ? '✅ Passing' : '❌ Failing'}`);
    logger.info(`- Overall status: ${migrationFullySuccessful ? '✅ Success' : '⚠️  Completed with issues'}`);
    
    // NEW: Display SDK metrics if available
    if (context.metricsCollector) {
      const metrics = context.metricsCollector.getFullReport();
      logger.info('\n💰 Enhanced Migration Metrics:');
      logger.info(`- Total cost: $${metrics.totalCost.toFixed(4)}`);
      logger.info(`- Total duration: ${(metrics.totalDuration / 1000).toFixed(2)}s`);
      logger.info(`- Total AI turns: ${metrics.totalTurns}`);
      logger.info(`- Errors encountered: ${metrics.errorCount}`);
      logger.info(`- Sessions used: ${metrics.sessionsUsed.length}`);
      
      if (metrics.phaseMetrics.size > 0) {
        logger.info('\n📊 Phase Breakdown:');
        for (const [phase, phaseMetric] of metrics.phaseMetrics.entries()) {
          const status = phaseMetric.success ? '✅' : '❌';
          logger.info(`  ${status} ${phase}: $${phaseMetric.cost.toFixed(4)}, ${phaseMetric.turns} turns, ${phaseMetric.attempts} attempts`);
        }
      }
    }
  }

  /**
   * Show next steps based on migration result
   */
  showNextSteps(migrationFullySuccessful: boolean, branchName: string): void {
    // Only show minimal next steps since we've already done the verification
    if (migrationFullySuccessful) {
      logger.info('\n✅ Migration fully successful! Next steps:');
      logger.info(`1. Review the changes: cd ${this.repoPath} && git diff main...${branchName}`);
      logger.info('2. Create a pull request to merge the changes');
    } else {
      logger.info('\n⚠️  Migration completed with issues. Next steps:');
      logger.info(`1. cd ${this.repoPath}`);
      logger.info('2. Fix remaining issues manually');
      logger.info('3. Run: bun run build && bun run test');
      logger.info('4. Once passing, create a pull request');
    }
  }

  /**
   * Analyze repository structure for migration planning
   */
  async analyzeRepositoryStructure(): Promise<{
    complexity: number;
    recommendations: string[];
    estimatedDuration: string;
  }> {
    const files = await globby(['src/**/*.ts'], {
      cwd: this.repoPath,
      ignore: ['node_modules/**', 'dist/**']
    });

    let totalComplexity = 0;
    const recommendations: string[] = [];

    // Analyze each file
    for (const file of files) {
      const filePath = path.join(this.repoPath, file);
      const content = await fs.readFile(filePath, 'utf-8');
      
      // Count V1 patterns
      const v1Patterns = [
        /ModelClass/g,
        /elizaLogger/g,
        /runtime\.memory\./g,
        /runtime\.messageManager\./g,
        /runtime\.language\./g,
        /Promise<boolean>/g,
      ];

      let fileComplexity = content.length / 1000; // Base complexity on file size
      
      for (const pattern of v1Patterns) {
        const matches = content.match(pattern);
        if (matches) {
          fileComplexity += matches.length * 2; // Each V1 pattern adds complexity
        }
      }

      totalComplexity += fileComplexity;
    }

    // Generate recommendations
    if (totalComplexity > 50) {
      recommendations.push('High complexity migration - expect longer processing time');
    }

    if (files.some(f => f.includes('service'))) {
      recommendations.push('Service migration required - ensure V1 service is properly converted');
    }

    if (files.length > 10) {
      recommendations.push('Large plugin - consider reviewing migration results carefully');
    }

    // Estimate duration
    let estimatedMinutes = Math.ceil(totalComplexity / 10);
    if (estimatedMinutes < 5) estimatedMinutes = 5;
    if (estimatedMinutes > 30) estimatedMinutes = 30;

    const estimatedDuration = `${estimatedMinutes}-${estimatedMinutes + 5} minutes`;

    return {
      complexity: Math.round(totalComplexity),
      recommendations,
      estimatedDuration,
    };
  }

  /**
   * Prepare migration environment
   */
  async prepareMigrationEnvironment(): Promise<{
    backupCreated: boolean;
    environmentReady: boolean;
    issues: string[];
  }> {
    const issues: string[] = [];
    const backupCreated = false;
    let environmentReady = true;

    // Check if repository is clean
    try {
      const gitStatus = await import('simple-git').then(git => 
        git.simpleGit(this.repoPath).status()
      );
      
      if (gitStatus.files.length > 0) {
        issues.push('Repository has uncommitted changes - consider committing first');
      }
    } catch (error) {
      issues.push('Could not check git status');
    }

    // Check disk space
    try {
      const { getAvailableDiskSpace } = await import('../utils.js');
      const diskSpace = await getAvailableDiskSpace();
      if (diskSpace < 1) {
        issues.push('Low disk space - migration may fail');
        environmentReady = false;
      }
    } catch (error) {
      issues.push('Could not check disk space');
    }

    // Check required tools
    const requiredTools = ['bun', 'git'];
    for (const tool of requiredTools) {
      try {
        const { execa } = await import('execa');
        await execa(tool, ['--version'], { stdio: 'pipe' });
      } catch (error) {
        issues.push(`Required tool missing: ${tool}`);
        environmentReady = false;
      }
    }

    return { backupCreated, environmentReady, issues };
  }

  /**
   * Validate migration prerequisites
   */
  async validatePrerequisites(): Promise<{
    valid: boolean;
    issues: string[];
    warnings: string[];
  }> {
    const issues: string[] = [];
    const warnings: string[] = [];

    // Check if ANTHROPIC_API_KEY is available
    if (!process.env.ANTHROPIC_API_KEY) {
      issues.push('ANTHROPIC_API_KEY environment variable is required');
    }

    // Check package.json structure
    const packageJsonPath = path.join(this.repoPath, 'package.json');
    if (await fs.pathExists(packageJsonPath)) {
      const packageJson = await fs.readJson(packageJsonPath);
      
      if (!packageJson.name?.includes('plugin')) {
        warnings.push('Project name does not contain "plugin" - ensure this is a plugin project');
      }

      if (!packageJson.scripts?.build) {
        warnings.push('No build script found - this may cause build validation to fail');
      }
    } else {
      issues.push('package.json not found');
    }

    return {
      valid: issues.length === 0,
      issues,
      warnings,
    };
  }

  /**
   * Enhanced environment variable collection with user prompting
   */
  async collectEnvironmentVariables(context: MigrationContext): Promise<void> {
    logger.info('🔍 Scanning for environment variable requirements...');
    
    try {
      const envVars = await this.detectEnvironmentVariables(context);
      
      logger.info('📊 Environment variable detection results:');
      logger.info(`   - Found ${envVars.length} environment variables: ${envVars.join(', ')}`);
      
      if (envVars.length === 0) {
        logger.info('✅ No additional environment variables required');
        return;
      }

      // Check if user wants to configure env vars now
      const configureNow = await EnvPrompter.askConfigureNow(envVars);
      
      if (configureNow) {
        // Create prompts and collect variables WITHOUT any logging during the process
        const envPrompts = EnvPrompter.createEnvPrompts(envVars, context.pluginName);
        const collectedVars = await this.envPrompter.promptForEnvVars(envPrompts);
        
        // NOW log the results AFTER collection is complete
        logger.info('👤 User completed environment variable configuration');
        logger.info(`📝 Collected ${Object.keys(collectedVars).length} environment variables`);
        
        // Store collected variables in context
        context.collectedEnvVars = collectedVars;
        
        // Create .env file with collected values
        if (Object.keys(collectedVars).length > 0) {
          await this.createEnvFile(context.repoPath, collectedVars);
          logger.info('✅ Environment variables configured successfully');
          logger.info(`📁 Created .env file with ${Object.keys(collectedVars).length} variables`);
        } else {
          logger.info('⏭️  No environment variables collected - user may have skipped configuration');
        }
      } else {
        logger.info('⏭️  Environment variable configuration skipped');
        logger.info('   💡 You can configure them later in the .env file');
        
        // Still create the .env.example file with placeholders
        const placeholderVars: Record<string, string> = {};
        for (const envVar of envVars) {
          placeholderVars[envVar] = `your_${envVar.toLowerCase()}_here`;
        }
        
        await this.createEnvExampleFile(context.repoPath, placeholderVars, context.pluginName);
        logger.info('📝 Created .env.example with placeholder values');
        logger.info('   💡 Copy .env.example to .env and fill in your actual values when ready');
      }
    } catch (error) {
      logger.error('❌ Error during environment variable collection:', error);
      logger.warn('⚠️  Continuing migration without environment variable configuration');
      logger.warn('   You will need to configure environment variables manually later');
    }
  }

  /**
   * Detect environment variables from code analysis
   */
  private async detectEnvironmentVariables(context: MigrationContext): Promise<string[]> {
    const envVars = new Set<string>();
    
    try {
      // Get all TypeScript files
      const files = await globby(['src/**/*.ts'], {
        cwd: context.repoPath,
        ignore: ['node_modules/**', 'dist/**']
      });

      // Common patterns for environment variables
      const envPatterns = [
        /process\.env\.([A-Z_][A-Z0-9_]*)/g,
        /runtime\.getSetting\(['"]([A-Z_][A-Z0-9_]*)['"]\)/g,
        /getSetting\(['"]([A-Z_][A-Z0-9_]*)['"]\)/g,
        /env\.([A-Z_][A-Z0-9_]*)/g,
      ];

      for (const file of files) {
        const filePath = path.join(context.repoPath, file);
        const content = await fs.readFile(filePath, 'utf-8');
        
        for (const pattern of envPatterns) {
          let match: RegExpExecArray | null;
          pattern.lastIndex = 0; // Reset regex
          match = pattern.exec(content);
          while (match !== null) {
            const envVar = match[1];
            
            // Filter out common system env vars and test vars
            if (!this.isSystemEnvVar(envVar) && !this.isTestEnvVar(envVar)) {
              envVars.add(envVar);
            }
            match = pattern.exec(content);
          }
        }
      }

      // Always include OPENAI_API_KEY for ElizaOS core functionality
      envVars.add('OPENAI_API_KEY');

    } catch (error) {
      logger.warn('Could not detect environment variables:', error);
    }

    return Array.from(envVars).sort();
  }

  /**
   * Check if env var is a system variable
   */
  private isSystemEnvVar(envVar: string): boolean {
    const systemVars = [
      'NODE_ENV', 'PATH', 'HOME', 'USER', 'PWD', 'SHELL',
      'LANG', 'LC_ALL', 'TZ', 'TERM', 'DISPLAY',
      'npm_package_name', 'npm_package_version'
    ];
    return systemVars.includes(envVar);
  }

  /**
   * Check if env var is a test variable
   */
  private isTestEnvVar(envVar: string): boolean {
    return envVar.includes('TEST') || 
           envVar.includes('MOCK') || 
           envVar.includes('DUMMY') ||
           envVar.startsWith('VITEST_') ||
           envVar.startsWith('JEST_');
  }

  /**
   * Create .env file with collected variables
   */
  private async createEnvFile(repoPath: string, envVars: Record<string, string>): Promise<void> {
    const envPath = path.join(repoPath, '.env');
    
    let envContent = '# Environment variables for plugin\n';
    envContent += '# Generated during migration\n\n';
    
    for (const [key, value] of Object.entries(envVars)) {
      if (value.trim()) {
        envContent += `${key}=${value}\n`;
      }
    }
    
    await fs.writeFile(envPath, envContent);
    logger.info(`📝 Created .env file with ${Object.keys(envVars).length} variables`);
  }

  /**
   * Create .env.example file with placeholder values
   */
  private async createEnvExampleFile(repoPath: string, envVars: Record<string, string>, pluginName: string): Promise<void> {
    const envExamplePath = path.join(repoPath, '.env.example');
    
    let envContent = `# Environment variables for ${pluginName}\n`;
    envContent += '# Copy this file to .env and fill in your actual values\n';
    envContent += '# Generated during migration\n\n';
    
    for (const [key, value] of Object.entries(envVars)) {
      envContent += `# ${key} - Required for plugin functionality\n`;
      envContent += `${key}=${value}\n\n`;
    }
    
    await fs.writeFile(envExamplePath, envContent);
  }
} 