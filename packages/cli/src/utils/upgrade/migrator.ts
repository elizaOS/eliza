import Anthropic from '@anthropic-ai/sdk';
import chalk from 'chalk';
import { execa } from 'execa';
import fs from 'fs-extra';
import { globby } from 'globby';
import ora from 'ora';
import path, { dirname } from 'path';
import { simpleGit, SimpleGit } from 'simple-git';
import { encoding_for_model } from 'tiktoken';
import { fileURLToPath } from 'url';
import { logger } from '@elizaos/core';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Initialize tiktoken encoder
const encoder = encoding_for_model('gpt-4');

// Configuration
const MAX_TOKENS = 20000;
const BRANCH_NAME = '1.x-claude';
const MAX_TEST_ITERATIONS = 5;
const MAX_REVISION_ITERATIONS = 3;

interface MigrationResult {
  success: boolean;
  branchName: string;
  repoPath: string;
  error?: Error;
}

interface ProductionValidationResult {
  production_ready: boolean;
  revision_instructions?: string;
}

export interface MigratorOptions {
  skipTests?: boolean;
  skipValidation?: boolean;
}

export class PluginMigrator {
  private git: SimpleGit;
  private repoPath: string | null;
  private isGitHub: boolean;
  private originalPath: string | null;
  private anthropic: Anthropic | null;
  private changedFiles: Set<string>;
  private options: MigratorOptions;

  constructor(options: MigratorOptions = {}) {
    this.git = simpleGit();
    this.repoPath = null;
    this.isGitHub = false;
    this.originalPath = null;
    this.anthropic = null;
    this.changedFiles = new Set();
    this.options = options;
  }

  async initializeAnthropic(): Promise<void> {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      logger.error('ANTHROPIC_API_KEY not found in environment.');
      throw new Error('ANTHROPIC_API_KEY is required for migration strategy generation');
    }

    this.anthropic = new Anthropic({ apiKey });
  }

  async migrate(input: string): Promise<MigrationResult> {
    const spinner = ora(`Processing ${input}`);

    try {
      spinner.start();

      if (!this.anthropic) await this.initializeAnthropic();

      // Step 1: Handle input
      spinner.text = `Analyzing input for ${input}...`;
      await this.handleInput(input);
      spinner.succeed(`Input validated for ${input}`);

      // Track initial git state to identify changed files later
      const initialCommit = await this.git.revparse(['HEAD']);

      // Check if CLAUDE.md already exists
      const claudeMdPath = path.join(this.repoPath!, 'CLAUDE.md');
      let skipGeneration = false;

      if (await fs.pathExists(claudeMdPath)) {
        spinner.info(`CLAUDE.md already exists. Skipping generation.`);
        skipGeneration = true;
      }

      if (!skipGeneration) {
        // Step 2: Analyze repository
        spinner.text = `Analyzing repository structure...`;
        const context = await this.analyzeRepository();
        spinner.succeed(`Repository analyzed`);

        // Step 3: Generate migration strategy
        spinner.text = `Generating migration strategy...`;
        const specificStrategy = await this.generateMigrationStrategy(context);
        spinner.succeed(`Migration strategy generated`);

        // Step 4: Create CLAUDE.md
        spinner.text = `Creating migration instructions...`;
        await this.createMigrationInstructions(specificStrategy);
        spinner.succeed(`Migration instructions created`);
      }

      // Step 5: Create branch
      spinner.text = `Creating branch ${BRANCH_NAME}...`;
      await this.createBranch();
      spinner.succeed(`Branch ${BRANCH_NAME} created`);

      // Step 6: Run migration with test loop
      if (!this.options.skipTests) {
        spinner.text = `Running migration with test validation...`;
        const migrationSuccess = await this.runMigrationWithTestLoop();

        if (!migrationSuccess) {
          throw new Error('Migration failed after maximum test iterations');
        }
      } else {
        // Just run Claude Code once without test validation
        spinner.text = `Running migration (tests skipped)...`;
        await this.runClaudeCode();
        spinner.succeed(`Migration applied (test validation skipped)`);
      }

      // Step 7: Track changed files
      await this.trackChangedFiles(initialCommit);

      // Step 8: Production validation loop
      if (!this.options.skipValidation) {
        spinner.text = `Validating migration for production readiness...`;
        const validationSuccess = await this.runProductionValidationLoop();

        if (!validationSuccess) {
          throw new Error('Migration not production ready after maximum revision iterations');
        }
      } else {
        spinner.info(`Production validation skipped`);
      }

      // Step 9: Push branch
      spinner.text = `Pushing branch ${BRANCH_NAME} to origin...`;
      await this.git.push('origin', BRANCH_NAME, { '--set-upstream': null });
      spinner.succeed(`Branch ${BRANCH_NAME} pushed`);

      logger.info(`✅ Migration complete for ${input}!`);

      return {
        success: true,
        branchName: BRANCH_NAME,
        repoPath: this.repoPath!,
      };
    } catch (error) {
      spinner.fail(`Migration failed for ${input}`);
      logger.error(`Error processing ${input}:`, error);

      return {
        success: false,
        branchName: BRANCH_NAME,
        repoPath: this.repoPath || '',
        error: error as Error,
      };
    }
  }

  private async runMigrationWithTestLoop(): Promise<boolean> {
    let testIteration = 0;
    let allTestsPass = false;

    while (testIteration < MAX_TEST_ITERATIONS && !allTestsPass) {
      testIteration++;
      logger.info(`Test iteration ${testIteration}/${MAX_TEST_ITERATIONS}`);

      // Run Claude Code
      if (testIteration === 1) {
        await this.runClaudeCode();
      } else {
        // Re-run with test failure context
        const testErrors = await this.getTestErrors();
        await this.runClaudeCodeWithContext(testErrors);
      }

      // Run tests
      const testResult = await this.runTests();
      allTestsPass = testResult.success;

      if (allTestsPass) {
        logger.info('✅ All tests passing!');
        return true;
      } else {
        logger.warn(`Tests failed. ${MAX_TEST_ITERATIONS - testIteration} attempts remaining.`);
      }
    }

    return allTestsPass;
  }

  private async runProductionValidationLoop(): Promise<boolean> {
    let revisionIteration = 0;
    let productionReady = false;

    while (revisionIteration < MAX_REVISION_ITERATIONS && !productionReady) {
      revisionIteration++;
      logger.info(
        `Production validation iteration ${revisionIteration}/${MAX_REVISION_ITERATIONS}`
      );

      const validationResult = await this.validateProductionReadiness();
      productionReady = validationResult.production_ready;

      if (productionReady) {
        logger.info('✅ Migration validated as production ready!');
        return true;
      } else if (validationResult.revision_instructions) {
        logger.warn('Migration needs revisions. Applying changes...');

        // Apply revisions
        await this.runClaudeCodeWithContext(validationResult.revision_instructions);

        // Re-run test loop
        const testSuccess = await this.runMigrationWithTestLoop();
        if (!testSuccess) {
          return false;
        }
      }
    }

    return productionReady;
  }

  private async runTests(): Promise<{ success: boolean; errors?: string }> {
    try {
      // First ensure dependencies are installed
      await execa('npm', ['install'], {
        cwd: this.repoPath!,
        stdio: 'pipe',
      });

      // Then run elizaos test
      await execa('npx', ['elizaos', 'test'], {
        cwd: this.repoPath!,
        stdio: 'pipe',
      });
      return { success: true };
    } catch (error: any) {
      const errorOutput = error.stdout + '\n' + error.stderr;
      return { success: false, errors: errorOutput };
    }
  }

  private async getTestErrors(): Promise<string> {
    try {
      // Run tests again to capture fresh output
      const result = await this.runTests();
      return result.errors || 'Tests failed but no specific errors captured';
    } catch (error) {
      return `Failed to capture test errors: ${error}`;
    }
  }

  private async trackChangedFiles(initialCommit: string): Promise<void> {
    const diff = await this.git.diff(['--name-only', initialCommit, 'HEAD']);
    const files = diff.split('\n').filter((f) => f.trim());
    files.forEach((file) => this.changedFiles.add(file));
  }

  private async validateProductionReadiness(): Promise<ProductionValidationResult> {
    const changedFilesContent = await this.getChangedFilesContent();

    const prompt = `You are reviewing a migration from Eliza 0.x to 1.x. Please evaluate if this migration is production-ready.

## Changed Files:
${changedFilesContent}

## Evaluation Criteria:
1. All imports are correctly updated
2. All types are properly migrated (Account → Entity, userId → entityId, etc.)
3. Services extend the base Service class with lifecycle methods
4. Event system is properly implemented
5. Memory operations use the new API
6. Model usage is converted to runtime.useModel
7. Templates are migrated to XML format
8. Comprehensive tests exist and cover the main functionality
9. No stubs or incomplete code remains
10. Error handling is robust

## Response Format:
Respond with a JSON object:
{
  "production_ready": boolean,
  "revision_instructions": "Detailed instructions for what needs to be fixed (only if not production ready)"
}`;

    const message = await this.anthropic!.messages.create({
      model: 'claude-opus-4-20250514',
      max_tokens: 8192,
      temperature: 0,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
    });

    try {
      const responseText = message.content
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('');
      // Extract JSON from the response
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
      throw new Error('No JSON found in response');
    } catch (error) {
      logger.error('Failed to parse validation response:', error);
      return {
        production_ready: false,
        revision_instructions: 'Failed to parse validation response. Please review manually.',
      };
    }
  }

  private async getChangedFilesContent(): Promise<string> {
    let content = '';
    let totalTokens = 0;

    for (const file of this.changedFiles) {
      const filePath = path.join(this.repoPath!, file);
      if (await fs.pathExists(filePath)) {
        const fileContent = await fs.readFile(filePath, 'utf-8');
        const fileTokens = encoder.encode(fileContent).length;

        if (totalTokens + fileTokens > MAX_TOKENS) break;

        content += `\n### File: ${file}\n\`\`\`typescript\n${fileContent}\n\`\`\`\n`;
        totalTokens += fileTokens;
      }
    }

    return content;
  }

  private async runClaudeCodeWithContext(context: string): Promise<void> {
    const prompt = `Please read the CLAUDE.md file and apply the migration. Additionally, address the following:

${context}

Make all necessary changes to fix the issues and ensure the migration is complete and correct.`;

    await this.runClaudeCodeWithPrompt(prompt);
  }

  private async runClaudeCodeWithPrompt(prompt: string): Promise<void> {
    process.chdir(this.repoPath!);

    try {
      await execa(
        'claude',
        [
          '--print',
          '--max-turns',
          '30',
          '--verbose',
          '--model',
          'opus',
          '--dangerously-skip-permissions',
          prompt,
        ],
        {
          stdio: 'inherit',
          cwd: this.repoPath!,
        }
      );
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        throw new Error(
          'Claude Code not found! Install with: npm install -g @anthropic-ai/claude-code'
        );
      }
      throw error;
    }
  }

  // Include all the other methods from the original updater.ts
  // (handleInput, analyzeRepository, generateMigrationStrategy, createMigrationInstructions,
  // createBranch, runClaudeCode, etc.)

  private async handleInput(input: string): Promise<void> {
    if (input.startsWith('https://github.com/')) {
      this.isGitHub = true;
      this.originalPath = input;
      const repoName = input.split('/').slice(-2).join('/').replace('.git', '');
      const repoFolder = repoName.split('/')[1] || repoName;
      this.repoPath = path.join(process.cwd(), 'cloned_repos', repoFolder);
      await fs.ensureDir(path.dirname(this.repoPath));

      if (await fs.pathExists(this.repoPath)) {
        this.git = simpleGit(this.repoPath);
        try {
          await this.git.fetch();
        } catch (fetchError) {
          await fs.remove(this.repoPath);
          await simpleGit().clone(input, this.repoPath);
          this.git = simpleGit(this.repoPath);
        }
      } else {
        await simpleGit().clone(input, this.repoPath);
        this.git = simpleGit(this.repoPath);
      }

      const branches = await this.git.branch();
      if (branches.all.includes('remotes/origin/0.x') || branches.all.includes('0.x')) {
        if (branches.current !== '0.x') await this.git.checkout('0.x');
      } else if (branches.all.includes('remotes/origin/main') || branches.all.includes('main')) {
        if (branches.current !== 'main') await this.git.checkout('main');
      }
    } else {
      this.repoPath = path.resolve(input);
      if (!(await fs.pathExists(this.repoPath))) {
        throw new Error(`Folder not found: ${this.repoPath}`);
      }
      this.git = simpleGit(this.repoPath);
    }
  }

  private async analyzeRepository(): Promise<string> {
    const files = {
      readme: null as string | null,
      packageJson: null as string | null,
      index: null as { path: string; content: string } | null,
      sourceFiles: [] as Array<{ path: string; content: string }>,
    };

    const readmePath = path.join(this.repoPath!, 'README.md');
    if (await fs.pathExists(readmePath)) {
      files.readme = await fs.readFile(readmePath, 'utf-8');
    }

    const packagePath = path.join(this.repoPath!, 'package.json');
    if (await fs.pathExists(packagePath)) {
      files.packageJson = await fs.readFile(packagePath, 'utf-8');
    }

    const indexPaths = ['index.ts', 'src/index.ts', 'index.js', 'src/index.js'];
    for (const indexPath of indexPaths) {
      const fullPath = path.join(this.repoPath!, indexPath);
      if (await fs.pathExists(fullPath)) {
        files.index = {
          path: indexPath,
          content: await fs.readFile(fullPath, 'utf-8'),
        };
        break;
      }
    }

    const sourceFiles = await globby(['**/*.ts', '**/*.js'], {
      cwd: this.repoPath!,
      ignore: [
        'node_modules/**',
        'dist/**',
        'build/**',
        '*.test.*',
        '*.spec.*',
        'coverage/**',
        'cloned_repos/**',
      ],
    });

    let totalTokens = 0;
    const readmeTokens = files.readme ? encoder.encode(files.readme).length : 0;
    const packageTokens = files.packageJson ? encoder.encode(files.packageJson).length : 0;
    const indexTokens = files.index ? encoder.encode(files.index.content).length : 0;

    totalTokens = readmeTokens + packageTokens + indexTokens;

    const sortedFiles = sourceFiles.sort((a, b) => {
      const depthA = a.split('/').length;
      const depthB = b.split('/').length;
      if (depthA !== depthB) return depthA - depthB;
      return a.localeCompare(b);
    });

    for (const file of sortedFiles) {
      if (file === files.index?.path) continue;
      const filePath = path.join(this.repoPath!, file);
      const content = await fs.readFile(filePath, 'utf-8');
      const fileTokens = encoder.encode(content).length;
      if (totalTokens + fileTokens > MAX_TOKENS) break;
      files.sourceFiles.push({ path: file, content });
      totalTokens += fileTokens;
    }

    let context = '';
    if (files.readme) context += '# README.md\n\n' + files.readme + '\n\n';
    if (files.packageJson)
      context += '# package.json\n\n```json\n' + files.packageJson + '\n```\n\n';
    if (files.index)
      context += `# ${files.index.path}\n\n\`\`\`typescript\n${files.index.content}\n\`\`\`\n\n`;
    for (const file of files.sourceFiles) {
      context += `# ${file.path}\n\n\`\`\`typescript\n${file.content}\n\`\`\`\n\n`;
    }

    return context;
  }

  private async generateMigrationStrategy(context: string): Promise<string> {
    const prompt = `You are migrating an Eliza plugin from version 0.x to 1.x. Analyze the provided codebase and generate a SPECIFIC, DETAILED migration strategy.

## Key Migration Requirements:

1. **Import Updates**: All @elizaos imports must use new paths (elizaLogger → logger, etc.)
2. **Type Migrations**: Account → Entity, userId → entityId, room → world
3. **Service Architecture**: Services must extend base Service class with lifecycle methods
4. **Event System**: Implement proper event emission and handling
5. **Memory Operations**: Update to use new API with table names
6. **Model Usage**: Convert generateText to runtime.useModel
7. **Templates**: Migrate from JSON to XML format
8. **Testing**: Create comprehensive unit and integration tests

## Repository Context:

${context}

## Task:

Generate a SPECIFIC migration strategy for THIS plugin. Your response should include:

1. **Exact File Changes**: List each file that needs to be modified with specific changes
2. **Import Mappings**: Exact old import → new import for this codebase
3. **Type Updates**: List every type that needs updating with old → new
4. **Service Migrations**: Identify services and exactly how to migrate them
5. **Memory Operation Updates**: Find all memory operations and show exact changes
6. **Model Usage Updates**: Find all model calls and show exact replacements
7. **Test Files to Create**: List specific test files with what they should test
8. **Package.json Updates**: Exact scripts and dependencies to add/update

Be extremely specific. Use actual file names, function names, and line references from the codebase.
Format your response as a clear, actionable migration plan.`;

    const message = await this.anthropic!.messages.create({
      model: 'claude-opus-4-20250514',
      max_tokens: 8192,
      temperature: 0,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
    });

    return message.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
  }

  private async createMigrationInstructions(specificStrategy: string): Promise<void> {
    const baseClaude = await fs.readFile(path.join(__dirname, './CLAUDE.md'), 'utf-8');

    const combinedInstructions =
      baseClaude +
      `

## SPECIFIC MIGRATION STRATEGY FOR THIS PLUGIN

${specificStrategy}

## MIGRATION EXECUTION INSTRUCTIONS

You are now going to apply the above migration strategy to this codebase. Follow these steps:

1. **Apply All File Changes**: Go through each file listed in the strategy and apply the exact changes specified
2. **Create Test Files**: Create all the test files mentioned in the strategy with comprehensive test coverage
3. **Update package.json**: Add all scripts and dependencies as specified
4. **Run Tests**: After making changes, run the tests to ensure everything works
5. **Fix Any Issues**: If tests fail, debug and fix the issues
6. **Format Code**: Run prettier to format all code

Work systematically through the strategy. Make all changes, create all tests, and ensure everything is working before finishing.

The goal is a fully migrated, tested, and working 1.x plugin.
`;

    const outputPath = path.join(this.repoPath!, 'CLAUDE.md');
    await fs.writeFile(outputPath, combinedInstructions);
  }

  private async createBranch(): Promise<void> {
    const branches = await this.git.branch();
    const currentBranch = branches.current;

    if (
      branches.all.includes(BRANCH_NAME) ||
      branches.all.includes(`remotes/origin/${BRANCH_NAME}`)
    ) {
      if (currentBranch !== BRANCH_NAME) {
        try {
          await this.git.checkout(BRANCH_NAME);
        } catch (e) {
          await this.git.fetch('origin', BRANCH_NAME).catch(() => {});
          await this.git.deleteLocalBranch(BRANCH_NAME, true).catch(() => {});
          await this.git.checkoutBranch(BRANCH_NAME, `origin/${BRANCH_NAME}`).catch(async () => {
            await this.git.checkout(currentBranch);
            await this.git.checkoutLocalBranch(BRANCH_NAME);
          });
        }
      }
    } else {
      await this.git.checkoutLocalBranch(BRANCH_NAME);
    }
  }

  private async runClaudeCode(): Promise<void> {
    const migrationPrompt = `Please read the CLAUDE.md file in this repository and execute all the migration steps described there. Apply all changes systematically, create all tests, and ensure everything works.`;
    await this.runClaudeCodeWithPrompt(migrationPrompt);
  }
}
