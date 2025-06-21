import Anthropic from '@anthropic-ai/sdk';
import { logger } from '@elizaos/core';
import ora from 'ora';
import type {
  MigrationResult,
  MigratorOptions,
  MigrationContext,
  StepResult,
} from '../types.js';
import { MigrationStepExecutor } from '../migration-steps/step-executor.js';
import { parseIntoChunks } from '../migration-patterns/index.js';
import { BRANCH_NAME } from '../config.js';

// Import modular test generation components instead of ContextAwareTestGenerator
import { 
  PluginAnalyzer, 
  TestValidator,
  type PluginAnalysis 
} from '../test-generation/index.js';
import { 
  buildTestGenerationPrompt, 
  generateRobustTemplateVariables 
} from '../test-templates/test-template.js';
import { EnhancedClaudeSDKAdapter } from '../claude-sdk/index.js';

// Import our modular components
import { MigrationOrchestrator } from './migration-orchestrator.js';
import { ValidationEngine } from './validation-engine.js';
import { ErrorAnalyzer } from './error-analyzer.js';
import { ClaudeIntegration } from './claude-integration.js';
import { RepositoryManager } from './repository-manager.js';
import { EnvironmentManager } from './environment-manager.js';
import { FileOperations } from './file-operations.js';
import { TestManager } from './test-manager.js';

// Types for the migration components
interface PromptChunk {
  title: string;
  content: string;
  phase: string;
}

interface MigrationStep {
  name: string;
  description: string;
  phase: string;
  required?: boolean;
  skipCondition?: (context: MigrationContext) => boolean;
  execute: (context: MigrationContext) => Promise<StepResult>;
}

interface SpinnerInterface {
  text: string;
  succeed: (text: string) => void;
  fail: (text: string) => void;
  warn: (text: string) => void;
}

/**
 * Structured migrator that follows the mega prompt step by step
 * 
 * REFACTORED: Now uses modular components while preserving exact same functionality
 * Updated to use new modular test generation components instead of ContextAwareTestGenerator
 */
export class StructuredMigrator {
  private anthropic: Anthropic | null = null;
  private options: MigratorOptions;
  private context: MigrationContext | null = null;
  private stepExecutor: MigrationStepExecutor | null = null;

  // Modular components
  private migrationOrchestrator!: MigrationOrchestrator;
  private validationEngine!: ValidationEngine;
  private errorAnalyzer!: ErrorAnalyzer;
  private claudeIntegration!: ClaudeIntegration;
  private repositoryManager!: RepositoryManager;
  private environmentManager!: EnvironmentManager;
  private fileOperations!: FileOperations;
  private testManager!: TestManager;

  constructor(options: MigratorOptions = {}) {
    this.options = options;
    this.repositoryManager = new RepositoryManager();

    // Register cleanup handlers
    this.registerCleanupHandlers();
  }

  private registerCleanupHandlers(): void {
    const cleanup = async () => {
      logger.info('Cleaning up migration process...');
      const repoPath = this.repositoryManager.getRepositoryPath();
      if (repoPath) {
        const fileOps = new FileOperations(repoPath);
        await fileOps.removeLockFile();
      }
      process.exit(1);
    };

    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
    process.on('uncaughtException', async (error) => {
      logger.error('Uncaught exception:', error);
      await cleanup();
    });
  }

  async initializeAnthropic(): Promise<void> {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      logger.error('ANTHROPIC_API_KEY not found in environment.');
      throw new Error('ANTHROPIC_API_KEY is required for migration');
    }

    this.anthropic = new Anthropic({ apiKey });
  }

  async migrate(input: string): Promise<MigrationResult> {
    const spinner = ora(`Starting structured migration for ${input}...`).start();
    let originalBranch: string | undefined;

    try {
      await this.initializeAnthropic();

      // Step 1: Handle input (clone if GitHub URL, validate if folder)
      spinner.text = `Setting up repository for ${input}...`;
      await this.repositoryManager.handleInput(input);
      spinner.succeed(`Repository setup complete for ${input}`);

      // Initialize all components with repository path
      const repoPath = this.repositoryManager.getRepositoryPath();
      if (!repoPath) {
        throw new Error('Repository path not set');
      }

      this.initializeComponents(repoPath);

      // Check disk space
      spinner.text = 'Checking disk space...';
      await this.environmentManager.checkDiskSpace();

      // Check for Claude Code SDK availability
      const { isClaudeSDKAvailable, validateClaudeSDKEnvironment } = await import('../claude-sdk/index.js');
      
      if (!(await isClaudeSDKAvailable())) {
        throw new Error(
          'Claude Code SDK is required for migration. Install with: bun add @anthropic-ai/claude-code'
        );
      }
      
      try {
        validateClaudeSDKEnvironment();
        logger.info('✅ Claude Code SDK detected and configured');
      } catch (envError) {
        const errorMessage = envError instanceof Error ? envError.message : String(envError);
        throw new Error(`Claude SDK environment error: ${errorMessage}`);
      }

      // NEW: Pre-migration validation
      spinner.text = 'Validating V1 plugin structure...';
      await this.validationEngine.validateV1Structure();
      spinner.succeed('V1 plugin structure validated');

      // Create lock file to prevent concurrent migrations
      await this.fileOperations.createLockFile();

      // Security warning
      logger.warn('⚠️  SECURITY WARNING: This command will execute code from the repository.');
      logger.warn('Only run this on trusted repositories you own or have reviewed.');

      // Save current branch for recovery
      originalBranch = await this.repositoryManager.getCurrentBranch();
      logger.info(`Current branch: ${originalBranch}`);

      // Create/checkout migration branch
      spinner.text = `Creating branch ${BRANCH_NAME}...`;
      await this.repositoryManager.createBranch();
      spinner.succeed(`Branch ${BRANCH_NAME} created`);

      // Analyze repository and create migration context
      spinner.text = 'Analyzing repository structure...';
      const migrationContext = await this.migrationOrchestrator.createMigrationContext();
      this.context = migrationContext;
      this.stepExecutor = new MigrationStepExecutor(migrationContext);
      spinner.succeed('Repository analyzed');

      // Step 2: FIX ALL IMPORTS FIRST - Prevent type issues from occurring
      spinner.text = 'Standardizing all imports to V2 patterns...';
      await this.claudeIntegration.fixAllImportsWithClaude(migrationContext);
      spinner.succeed('All imports standardized to V2 patterns');

      // Load mega prompt chunks
      const promptChunks = parseIntoChunks();
      logger.info(`📋 Loaded ${promptChunks.length} migration phases from mega prompt`);

      // Create migration steps
      const migrationSteps = this.stepExecutor.createMigrationSteps();
      logger.info(`📊 Created ${migrationSteps.length} migration steps`);

      // Execute migration phases
      await this.executeMigrationPhases(promptChunks, migrationSteps, migrationContext, spinner);

      // Apply Claude prompts if any were generated (for structural changes only)
      if (migrationContext.claudePrompts.size > 0) {
        spinner.text = 'Applying structural migrations...';
        await this.claudeIntegration.applyClaudePrompts(migrationContext);
        spinner.succeed('Structural migrations applied');
      }

      // NOW: Collect environment variables with user prompting (after migration is complete)
      spinner.text = 'Collecting environment variables...';
      await this.migrationOrchestrator.collectEnvironmentVariables(migrationContext);
      spinner.succeed('Environment variables collected');

      // Run iterative validation and fixing
      const iterationCounts = await this.runIterativeValidation(spinner, migrationContext);

      // Run comprehensive post-migration verification
      const verificationResults = await this.runPostMigrationVerification(spinner, migrationContext);

      // Final cleanup
      await this.executeFinalizationSteps(migrationContext);

      // Push branch
      await this.repositoryManager.pushBranch();
      
      // Log migration summary
      this.migrationOrchestrator.logMigrationSummary(
        migrationContext, 
        BRANCH_NAME, 
        verificationResults.migrationFullySuccessful,
        iterationCounts,
        verificationResults.buildSuccess,
        verificationResults.testSuccess
      );

      // Show next steps
      this.migrationOrchestrator.showNextSteps(verificationResults.migrationFullySuccessful, BRANCH_NAME);

      return {
        success: verificationResults.migrationFullySuccessful,
        branchName: BRANCH_NAME,
        repoPath: repoPath,
      };

    } catch (error) {
      spinner.fail(`Migration failed for ${input}`);
      logger.error(`Error processing ${input}:`, error);

      // Clean up lock file
      const repoPath = this.repositoryManager.getRepositoryPath();
      if (repoPath) {
        const fileOps = new FileOperations(repoPath);
        await fileOps.removeLockFile();
      }

      // Try to restore original state
      try {
        if (originalBranch) {
          logger.info(`Attempting to restore original branch: ${originalBranch}`);
          await this.repositoryManager.switchToBranch(originalBranch);
        }
      } catch (restoreError) {
        logger.error('Failed to restore original branch:', restoreError);
      }

      return {
        success: false,
        branchName: BRANCH_NAME,
        repoPath: this.repositoryManager.getRepositoryPath() || '',
        error: error as Error,
      };
    } finally {
      // Always clean up lock file
      const repoPath = this.repositoryManager.getRepositoryPath();
      if (repoPath) {
        const fileOps = new FileOperations(repoPath);
        await fileOps.removeLockFile();
      }
    }
  }

  /**
   * Initialize all modular components with repository path
   */
  private initializeComponents(repoPath: string): void {
    this.migrationOrchestrator = new MigrationOrchestrator(repoPath);
    this.validationEngine = new ValidationEngine(repoPath, this.options.skipTests);
    this.errorAnalyzer = new ErrorAnalyzer(repoPath);
    this.claudeIntegration = new ClaudeIntegration(repoPath);
    this.environmentManager = new EnvironmentManager(repoPath);
    this.fileOperations = new FileOperations(repoPath);
    this.testManager = new TestManager(repoPath);
  }

  /**
   * Execute migration phases using the existing logic
   */
  private async executeMigrationPhases(
    promptChunks: PromptChunk[], 
    migrationSteps: MigrationStep[], 
    migrationContext: MigrationContext,
    spinner: SpinnerInterface
  ): Promise<void> {
    let phaseIndex = 0;
    for (const chunk of promptChunks) {
      phaseIndex++;

      spinner.text = `Phase ${phaseIndex}/${promptChunks.length}: ${chunk.title}`;
      logger.info(`\n🔄 === ${chunk.title.toUpperCase()} ===`);
      logger.info(`📝 ${chunk.content}`);

              // Get steps for this phase
        const phaseSteps = migrationSteps.filter((step: MigrationStep) => step.phase === chunk.phase);

      if (phaseSteps.length === 0) {
        logger.info(`✅ No steps for phase: ${chunk.phase}`);
        continue;
      }

      // Execute each step in the phase
      let stepIndex = 0;
      for (const step of phaseSteps) {
        stepIndex++;

        // Check if step should be skipped
        if (step.skipCondition?.(migrationContext)) {
          logger.info(`⏭️  Skipping step: ${step.name} (condition not met)`);
          continue;
        }

        spinner.text = `${chunk.title} - Step ${stepIndex}/${phaseSteps.length}: ${step.name}`;
        logger.info(`\n🔧 Executing: ${step.name}`);
        logger.info(`📋 ${step.description}`);

        try {
          const result = await step.execute(migrationContext);

          if (result.success) {
            logger.info(`✅ ${result.message}`);
            if (result.changes && result.changes.length > 0) {
              logger.info(`📝 Changed files: ${result.changes.join(', ')}`);
            }
            if (result.warnings && result.warnings.length > 0) {
              for (const warn of result.warnings) {
                logger.warn(`⚠️  ${warn}`);
              }
            }
          } else {
            logger.error(`❌ ${result.message}`);
            if (result.error) {
              logger.error(`Error: ${result.error.message}`);
            }

            // For non-critical steps, continue
            if (!step.required) {
              logger.warn('⚠️  Continuing despite error (non-critical step)');
              continue;
            }

            throw new Error(`Critical step failed: ${step.name}`);
          }
        } catch (error) {
          logger.error(`💥 Step execution failed: ${step.name}`, error);
          if (step.required) {
            throw error;
          }
        }
      }

      spinner.succeed(`${chunk.title} completed`);
    }
  }

  /**
   * Run iterative validation and fixing loop
   */
  private async runIterativeValidation(spinner: SpinnerInterface, context: MigrationContext): Promise<{
    preVerification: number;
    postMigration: number;
  }> {
    let iterationCount = 0;
    const maxIterations = 10;
    let lastValidationResult: StepResult;

    do {
      iterationCount++;
      spinner.text = `Running validation (iteration ${iterationCount}/${maxIterations})...`;
      
      lastValidationResult = await this.validationEngine.runFinalValidation();

      if (lastValidationResult.success) {
        spinner.succeed('All validation checks passed!');
        break;
      }

      spinner.warn(`Validation failed (iteration ${iterationCount}). Attempting fixes...`);
      logger.info(`\n🔄 Iteration ${iterationCount}: Fixing validation issues`);

      // Apply fixes based on validation results
      await this.applyValidationFixes(lastValidationResult, context);

      // Check modified files after each iteration
      spinner.text = 'Checking modified files...';
      await this.fileOperations.checkModifiedFiles(context);

    } while (!lastValidationResult.success && iterationCount < maxIterations);

    if (!lastValidationResult.success) {
      spinner.warn(`Migration completed after ${maxIterations} iterations with remaining issues`);
      logger.warn('⚠️  Some validation checks still failing. Manual intervention required.');
    }

    return { preVerification: iterationCount, postMigration: 0 };
  }

  /**
   * Apply fixes based on validation results
   */
  private async applyValidationFixes(validationResult: StepResult, context: MigrationContext): Promise<void> {
    if (!validationResult.warnings) return;

    for (const warning of validationResult.warnings) {
      if (warning.includes('Build failed')) {
        await this.errorAnalyzer.analyzeBuildErrorsAndFix(context);
      }
      
      if (warning.includes('Tests failed')) {
        await this.errorAnalyzer.analyzeTestErrorsAndFix(context);
      }
      
      if (warning.includes('Formatting issues')) {
        // Run formatter
        try {
          const { execa } = await import('execa');
          await execa('bun', ['run', 'format'], {
            cwd: this.repositoryManager.getRepositoryPath() || process.cwd(),
            stdio: 'pipe'
          });
          logger.info('✅ Code formatted successfully');
        } catch (error) {
          logger.warn('⚠️  Format command failed, continuing...');
        }
      }
    }
  }

  /**
   * Run comprehensive post-migration verification using modular components
   */
  private async runPostMigrationVerification(spinner: SpinnerInterface, context: MigrationContext): Promise<{
    migrationFullySuccessful: boolean;
    buildSuccess: boolean;
    testSuccess: boolean;
  }> {
    logger.info('\n🔨 Running post-migration verification...');
    
    // Generate comprehensive tests using modular components
    logger.info('\n🧪 Generating comprehensive test suite with iterative validation...');
    
    try {
      const testResult = await this.generateTestSuitesWithModularComponents(context);
      
      if (testResult.success) {
        logger.info('✅ Test generation and validation completed successfully - all tests passing!');
      } else {
        logger.warn('⚠️  Test generation completed but some tests still failing:', testResult.message);
        if (testResult.warnings) {
          for (const warning of testResult.warnings) {
            logger.warn(`   - ${warning}`);
          }
        }
      }
      
      // Include test suites in index.ts for build validation
      await this.fileOperations.includeTestSuitesInIndex(context, this.claudeIntegration);
    } catch (error) {
      logger.warn('⚠️  Test generation error, continuing with basic validation:', error);
    }
    
    // Run verification iterations
    let buildSuccess = false;
    let testSuccess = false;
    let postMigrationIterations = 0;
    const maxPostMigrationIterations = 5;
    
    while ((!buildSuccess || !testSuccess) && postMigrationIterations < maxPostMigrationIterations) {
      postMigrationIterations++;
      logger.info(`\n🔄 Post-migration verification iteration ${postMigrationIterations}/${maxPostMigrationIterations}`);
      
      // Try to build
      if (!buildSuccess) {
        spinner.text = 'Running build verification...';
        try {
          const { execa } = await import('execa');
          await execa('bun', ['run', 'build'], {
            cwd: this.repositoryManager.getRepositoryPath() || process.cwd(),
            stdio: 'pipe',
            timeout: 120000,
          });
          buildSuccess = true;
          logger.info('✅ Build verification passed');
        } catch (error) {
          logger.warn('❌ Build verification failed');
          spinner.text = 'Fixing build issues...';
          await this.errorAnalyzer.analyzeBuildErrorsAndFix(context);
        }
      }
      
      // Try to run tests (only if build passes)
      if (buildSuccess && !testSuccess && !this.options.skipTests) {
        spinner.text = 'Running test verification...';
        const testResult = await this.testManager.runTestsWithDetailedError();
        
        if (testResult.success) {
          testSuccess = true;
          logger.info('✅ Test verification passed');
        } else {
          logger.warn('❌ Test verification failed');
          if (testResult.warnings) {
            logger.warn('Issues:', testResult.warnings.join(', '));
          }
          spinner.text = 'Fixing test issues...';
          await this.errorAnalyzer.analyzeTestErrorsAndFix(context);
        }
      } else if (this.options.skipTests) {
        testSuccess = true; // Skip test verification if tests are skipped
      }
      
      // If both pass, we're done
      if (buildSuccess && testSuccess) {
        spinner.succeed('All post-migration verifications passed!');
        break;
      }
    }
    
    const migrationFullySuccessful = buildSuccess && testSuccess;
    
    if (!migrationFullySuccessful) {
      logger.error('\n⚠️  Migration completed but verification failed:');
      if (!buildSuccess) logger.error('  - Build is still failing');
      if (!testSuccess) logger.error('  - Tests are still failing');
      logger.error('\nManual intervention required to fix remaining issues.');
    }

    return { migrationFullySuccessful, buildSuccess, testSuccess };
  }

  /**
   * Generate test suites using modular components instead of ContextAwareTestGenerator
   */
  private async generateTestSuitesWithModularComponents(context: MigrationContext): Promise<StepResult> {
    try {
      const repoPath = this.repositoryManager.getRepositoryPath();
      if (!repoPath) {
        throw new Error('Repository path not available');
      }

      // Step 1: Analyze plugin using PluginAnalyzer
      logger.info('🔍 Analyzing plugin structure...');
      const pluginAnalyzer = new PluginAnalyzer(repoPath, context.pluginName || 'unknown');
      const analysis = await pluginAnalyzer.analyzePlugin();
      
      // Step 2: Generate template variables using centralized function
      logger.info('⚙️  Generating template variables...');
      const templateVars = generateRobustTemplateVariables(analysis.name, context.packageJson);
      
      // Step 3: Build test generation prompt using centralized function
      logger.info('📝 Building test generation prompt...');
      const testGenerationPrompt = buildTestGenerationPrompt(analysis, templateVars);
      
      // Step 4: Execute prompt using Claude SDK
      logger.info('🚀 Executing test generation via Claude SDK...');
      const claudeSDKAdapter = new EnhancedClaudeSDKAdapter({ maxRetries: 3 });
      
      const sdkResult = await claudeSDKAdapter.executePrompt(testGenerationPrompt, {
        maxTurns: 30,
        model: 'claude-opus-4-20250514',
        outputFormat: 'json',
        permissionMode: 'bypassPermissions',
        systemPrompt: 'You are an expert ElizaOS test generation assistant. Generate comprehensive, working tests that follow ElizaOS V2 patterns exactly.'
      }, context);
      
      if (!sdkResult.success) {
        throw new Error(`Test generation failed: ${sdkResult.message}`);
      }
      
      // Step 5: Run iterative test validation using TestValidator
      logger.info('🔄 Running iterative test validation...');
      const testValidator = new TestValidator(context);
      
      // Fix any broken test structure
      await testValidator.fixBrokenTestStructure();
      
      // Run tests until they pass
      const validationResult = await testValidator.runTestsUntilPass();
      
      logger.info('✅ Modular test generation completed successfully');
      
      return {
        success: validationResult.success,
        message: validationResult.success 
          ? '✅ Test suites generated and all tests passing' 
          : '⚠️  Test suites generated but some tests failing',
        changes: ['src/test/test.ts', 'src/index.ts', 'src/test/utils.ts'],
        warnings: validationResult.warnings || []
      };
      
    } catch (error) {
      logger.error('❌ Modular test generation failed:', error);
      return {
        success: false,
        message: `Failed to generate test suites: ${error instanceof Error ? error.message : 'Unknown error'}`,
        error: error instanceof Error ? error : new Error('Unknown error')
      };
    }
  }

  /**
   * Execute final cleanup and finalization steps
   */
  private async executeFinalizationSteps(context: MigrationContext): Promise<void> {
    logger.info('\n🚀 Executing final verification steps...');
    
    // Switch to the plugin directory for final operations
    const repoPath = this.repositoryManager.getRepositoryPath();
    if (repoPath) {
      process.chdir(repoPath);
      logger.info(`📂 Changed to directory: ${repoPath}`);
    }
    
    // Clean up incorrect test files while preserving ElizaOS V2 patterns
    await this.fileOperations.cleanupTestFiles();
  }
} 