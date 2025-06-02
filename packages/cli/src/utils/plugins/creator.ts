import Anthropic from '@anthropic-ai/sdk';
import { logger } from '@elizaos/core';
import { execa } from 'execa';
import * as fs from 'fs-extra';
import ora from 'ora';
import * as path from 'path';
import { dirname } from 'path';
import simpleGit, { SimpleGit } from 'simple-git';
import { fileURLToPath } from 'url';
import * as os from 'os';
import inquirer from 'inquirer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Configuration
const MAX_TOKENS = 100000;
const MAX_BUILD_ITERATIONS = 5;
const MAX_TEST_ITERATIONS = 5;
const MAX_REVISION_ITERATIONS = 3;
const CLAUDE_CODE_TIMEOUT = 15 * 60 * 1000; // 15 minutes
const MIN_DISK_SPACE_GB = 2;

interface CreationResult {
  success: boolean;
  pluginName: string;
  pluginPath: string;
  error?: Error;
}

interface PluginSpecification {
  name: string;
  description: string;
  features: string[];
  actions?: string[];
  providers?: string[];
  evaluators?: string[];
  services?: string[];
}

interface ValidationResult {
  production_ready: boolean;
  revision_instructions?: string;
}

export interface CreatorOptions {
  skipTests?: boolean;
  skipValidation?: boolean;
  skipPrompts?: boolean;
  spec?: PluginSpecification;
}

export class PluginCreator {
  private git: SimpleGit;
  private pluginPath: string | null = null;
  private anthropic: Anthropic | null = null;
  private activeClaudeProcess: any = null;
  private options: CreatorOptions;

  constructor(options: CreatorOptions = {}) {
    this.git = simpleGit();
    this.options = options;
    this.registerCleanupHandlers();
  }

  private registerCleanupHandlers(): void {
    const cleanup = async () => {
      logger.info('Cleaning up plugin creation process...');

      if (this.activeClaudeProcess) {
        try {
          this.activeClaudeProcess.kill();
          logger.info('Terminated active Claude Code process');
        } catch (error) {
          logger.error('Failed to terminate Claude Code process:', error);
        }
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
      throw new Error('ANTHROPIC_API_KEY is required for plugin generation');
    }

    this.anthropic = new Anthropic({ apiKey });
  }

  async create(pluginSpec?: PluginSpecification): Promise<CreationResult> {
    const spinner = ora('Initializing plugin creator...').start();

    try {
      await this.initializeAnthropic();

      // Check disk space
      spinner.info('Checking disk space...');
      await this.checkDiskSpace();

      // Check for Claude Code
      try {
        await execa('claude', ['--version'], { stdio: 'pipe' });
      } catch {
        throw new Error(
          'Claude Code is required for plugin generation. Install with: npm install -g @anthropic-ai/claude-code'
        );
      }

      // Step 1: Collect plugin specification
      spinner.info('Collecting plugin specification...');
      const spec = pluginSpec || this.options.spec || (await this.collectPluginSpecification());
      spinner.succeed('Plugin specification collected');

      // Step 2: Create plugin from template
      spinner.info('Creating plugin from template...');
      await this.createFromTemplate(spec.name);
      spinner.succeed('Plugin structure created');

      // Step 3: Generate detailed specification
      spinner.info('Generating detailed plugin specification...');
      const detailedSpec = await this.generateDetailedSpecification(spec);
      spinner.succeed('Detailed specification generated');

      // Step 4: Create PLUGIN_SPEC.md
      spinner.info('Creating plugin specification document...');
      await this.createSpecificationDocument(spec, detailedSpec);
      spinner.succeed('Specification document created');

      // Step 5: Generate plugin code with validation loops
      spinner.info('Generating plugin code...');
      const generationSuccess = await this.runGenerationWithValidation();

      if (!generationSuccess) {
        throw new Error('Plugin generation failed after maximum iterations');
      }
      spinner.succeed('Plugin code generated and validated');

      // Step 6: Copy to current directory
      const targetPath = await this.copyToCWD();

      logger.info(`✅ Plugin successfully created!`);
      logger.info(`📁 Plugin location: ${targetPath}`);
      logger.info(`\n📌 Next steps:`);
      logger.info(`1. cd ${path.basename(targetPath)}`);
      logger.info(`2. Review the generated code`);
      logger.info(`3. Run tests: npm test`);
      logger.info(`4. Add to your ElizaOS project\n`);

      return {
        success: true,
        pluginName: spec.name,
        pluginPath: targetPath,
      };
    } catch (error) {
      spinner.fail('Plugin creation failed');
      logger.error('Error creating plugin:', error);

      return {
        success: false,
        pluginName: '',
        pluginPath: '',
        error: error as Error,
      };
    }
  }

  private async collectPluginSpecification(): Promise<PluginSpecification> {
    if (this.options.skipPrompts) {
      throw new Error('Plugin specification required when skipping prompts');
    }

    const answers = await inquirer.prompt([
      {
        type: 'input',
        name: 'name',
        message: 'Plugin name (without "plugin-" prefix):',
        validate: (input) => {
          if (!input) return 'Plugin name is required';
          if (!/^[a-z0-9-]+$/.test(input)) {
            return 'Plugin name must be lowercase with hyphens only';
          }
          return true;
        },
        filter: (input) => input.toLowerCase().replace(/\s+/g, '-'),
      },
      {
        type: 'input',
        name: 'description',
        message: 'Plugin description:',
        validate: (input) => input.length > 0 || 'Description is required',
      },
      {
        type: 'input',
        name: 'features',
        message: 'Main features (comma-separated):',
        filter: (input) =>
          input
            .split(',')
            .map((f) => f.trim())
            .filter((f) => f),
      },
      {
        type: 'checkbox',
        name: 'components',
        message: 'Which components will this plugin include?',
        choices: [
          { name: 'Actions', value: 'actions' },
          { name: 'Providers', value: 'providers' },
          { name: 'Evaluators', value: 'evaluators' },
          { name: 'Services', value: 'services' },
        ],
        default: ['actions', 'providers'],
      },
    ]);

    // Collect specific component details
    const spec: PluginSpecification = {
      name: answers.name,
      description: answers.description,
      features: answers.features,
    };

    if (answers.components.includes('actions')) {
      const actionAnswers = await inquirer.prompt([
        {
          type: 'input',
          name: 'actions',
          message: 'Action names (comma-separated):',
          filter: (input) =>
            input
              .split(',')
              .map((a) => a.trim())
              .filter((a) => a),
        },
      ]);
      spec.actions = actionAnswers.actions;
    }

    if (answers.components.includes('providers')) {
      const providerAnswers = await inquirer.prompt([
        {
          type: 'input',
          name: 'providers',
          message: 'Provider names (comma-separated):',
          filter: (input) =>
            input
              .split(',')
              .map((p) => p.trim())
              .filter((p) => p),
        },
      ]);
      spec.providers = providerAnswers.providers;
    }

    if (answers.components.includes('evaluators')) {
      const evaluatorAnswers = await inquirer.prompt([
        {
          type: 'input',
          name: 'evaluators',
          message: 'Evaluator names (comma-separated):',
          filter: (input) =>
            input
              .split(',')
              .map((e) => e.trim())
              .filter((e) => e),
        },
      ]);
      spec.evaluators = evaluatorAnswers.evaluators;
    }

    if (answers.components.includes('services')) {
      const serviceAnswers = await inquirer.prompt([
        {
          type: 'input',
          name: 'services',
          message: 'Service names (comma-separated):',
          filter: (input) =>
            input
              .split(',')
              .map((s) => s.trim())
              .filter((s) => s),
        },
      ]);
      spec.services = serviceAnswers.services;
    }

    return spec;
  }

  private async createFromTemplate(pluginName: string): Promise<void> {
    const tempDir = path.join(os.tmpdir(), `plugin-${pluginName}-${Date.now()}`);
    await fs.ensureDir(tempDir);

    this.pluginPath = path.join(tempDir, `plugin-${pluginName}`);

    // Use elizaos create command to create from template
    try {
      await execa(
        'npx',
        ['@elizaos/cli', 'create', `plugin-${pluginName}`, '-t', 'plugin-starter'],
        {
          cwd: tempDir,
          stdio: 'pipe',
        }
      );
    } catch (error) {
      // Fallback to manual creation if elizaos create fails
      logger.warn('Failed to use elizaos create, creating structure manually');
      await this.createPluginStructureManually(pluginName);
    }

    // Initialize git
    this.git = simpleGit(this.pluginPath);
    await this.git.init();
    await this.git.add('.');
    await this.git.commit('Initial commit from plugin-starter template');
  }

  private async createPluginStructureManually(pluginName: string): Promise<void> {
    await fs.ensureDir(this.pluginPath!);

    // Create basic structure
    const dirs = ['src', 'src/actions', 'src/providers', 'src/evaluators', 'src/services', 'tests'];
    for (const dir of dirs) {
      await fs.ensureDir(path.join(this.pluginPath!, dir));
    }

    // Create package.json
    const packageJson = {
      name: `@elizaos/plugin-${pluginName}`,
      version: '0.1.0',
      description: `ElizaOS ${pluginName} plugin`,
      main: 'dist/index.js',
      types: 'dist/index.d.ts',
      scripts: {
        build: 'tsup',
        dev: 'tsup --watch',
        test: 'vitest run',
        'test:watch': 'vitest',
      },
      dependencies: {
        '@elizaos/core': '^1.0.0',
      },
      devDependencies: {
        tsup: '^8.4.0',
        typescript: '^5.3.0',
        vitest: '^1.3.1',
        '@types/node': '^20.0.0',
      },
      peerDependencies: {
        '@elizaos/core': '1.x',
      },
      files: ['dist', 'README.md'],
    };

    await fs.writeJson(path.join(this.pluginPath!, 'package.json'), packageJson, { spaces: 2 });

    // Create tsconfig.json
    const tsconfig = {
      extends: '../../tsconfig.json',
      compilerOptions: {
        outDir: './dist',
        rootDir: './src',
      },
      include: ['src/**/*'],
      exclude: ['node_modules', 'dist'],
    };

    await fs.writeJson(path.join(this.pluginPath!, 'tsconfig.json'), tsconfig, { spaces: 2 });

    // Create tsup.config.ts
    const tsupConfig = `import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  external: ['@elizaos/core'],
});
`;

    await fs.writeFile(path.join(this.pluginPath!, 'tsup.config.ts'), tsupConfig);

    // Create vitest.config.ts
    const vitestConfig = `import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
  },
});
`;

    await fs.writeFile(path.join(this.pluginPath!, 'vitest.config.ts'), vitestConfig);

    // Create .gitignore
    const gitignore = `node_modules/
dist/
*.log
.env
.DS_Store
coverage/
.vitest/
`;

    await fs.writeFile(path.join(this.pluginPath!, '.gitignore'), gitignore);

    // Create README.md
    const readme = `# @elizaos/plugin-${pluginName}

ElizaOS ${pluginName} plugin

## Installation

\`\`\`bash
npm install @elizaos/plugin-${pluginName}
\`\`\`

## Usage

\`\`\`typescript
import { plugin${pluginName
      .split('-')
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
      .join('')} } from '@elizaos/plugin-${pluginName}';

// Add to your ElizaOS configuration
\`\`\`
`;

    await fs.writeFile(path.join(this.pluginPath!, 'README.md'), readme);

    // Create basic index.ts
    const indexContent = `import { Plugin } from '@elizaos/core';

export const plugin${pluginName
      .split('-')
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
      .join('')}: Plugin = {
  name: 'plugin-${pluginName}',
  version: '0.1.0',
  actions: [],
  providers: [],
  evaluators: [],
  services: [],
};

export default plugin${pluginName
      .split('-')
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
      .join('')};
`;

    await fs.writeFile(path.join(this.pluginPath!, 'src/index.ts'), indexContent);
  }

  private async generateDetailedSpecification(spec: PluginSpecification): Promise<string> {
    const prompt = `You are creating a detailed technical specification for an ElizaOS plugin.

## Plugin Overview
Name: ${spec.name}
Description: ${spec.description}
Features: ${spec.features.join(', ')}

${spec.actions ? `Actions: ${spec.actions.join(', ')}` : ''}
${spec.providers ? `Providers: ${spec.providers.join(', ')}` : ''}
${spec.evaluators ? `Evaluators: ${spec.evaluators.join(', ')}` : ''}
${spec.services ? `Services: ${spec.services.join(', ')}` : ''}

## Task
Generate a detailed technical specification that includes:

1. **Architecture Overview**: How the plugin components work together
2. **Component Specifications**: Detailed specs for each action, provider, evaluator, and service
3. **Data Flow**: How data moves through the plugin
4. **Integration Points**: How the plugin integrates with ElizaOS
5. **Implementation Details**: Specific algorithms, APIs, or techniques to use
6. **Testing Strategy**: What tests are needed
7. **Error Handling**: How errors should be handled
8. **Configuration**: Any configuration options needed

Be extremely detailed and specific. This specification will be used to generate the actual code.`;

    const message = await this.anthropic!.messages.create({
      model: 'claude-opus-4-20250514',
      max_tokens: 8192,
      temperature: 0.3,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
    });

    return message.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
  }

  private async createSpecificationDocument(
    spec: PluginSpecification,
    detailedSpec: string
  ): Promise<void> {
    const content = `# Plugin Specification: ${spec.name}

## Overview
${spec.description}

## Features
${spec.features.map((f) => `- ${f}`).join('\n')}

## Components
${spec.actions ? `### Actions\n${spec.actions.map((a) => `- ${a}`).join('\n')}` : ''}
${spec.providers ? `### Providers\n${spec.providers.map((p) => `- ${p}`).join('\n')}` : ''}
${spec.evaluators ? `### Evaluators\n${spec.evaluators.map((e) => `- ${e}`).join('\n')}` : ''}
${spec.services ? `### Services\n${spec.services.map((s) => `- ${s}`).join('\n')}` : ''}

## Detailed Technical Specification

${detailedSpec}

## Implementation Instructions

You are now going to implement this plugin following ElizaOS 1.0.0 best practices:

1. **Use TypeScript** for all code
2. **Follow the ElizaOS plugin structure** exactly
3. **Implement all components** specified above
4. **Create comprehensive tests** for each component
5. **Use proper error handling** throughout
6. **Add detailed logging** using the ElizaOS logger
7. **Follow the coding standards** from the ElizaOS repository
8. **Ensure all imports use @elizaos/core**
9. **Make the plugin production-ready** with no stubs or incomplete code

Remember:
- Services must extend the base Service class with lifecycle methods
- Actions must implement validate and handler functions
- Providers must return formatted context strings
- Evaluators run after interactions
- All components must be properly exported in index.ts
- Tests must use vitest and cover all functionality

Work systematically through each component, implementing it completely before moving to the next.
`;

    await fs.writeFile(path.join(this.pluginPath!, 'PLUGIN_SPEC.md'), content);
  }

  private async runGenerationWithValidation(): Promise<boolean> {
    // Initial code generation
    await this.runClaudeCode();

    // Build loop
    if (!(await this.runBuildLoop())) {
      return false;
    }

    // Test loop (if not skipped)
    if (!this.options.skipTests && !(await this.runTestLoop())) {
      return false;
    }

    // Production validation (if not skipped)
    if (!this.options.skipValidation && !(await this.runProductionValidationLoop())) {
      return false;
    }

    return true;
  }

  private async runBuildLoop(): Promise<boolean> {
    let buildIteration = 0;
    let buildSuccess = false;

    while (buildIteration < MAX_BUILD_ITERATIONS && !buildSuccess) {
      buildIteration++;
      logger.info(`Build iteration ${buildIteration}/${MAX_BUILD_ITERATIONS}`);

      if (buildIteration > 1) {
        const buildErrors = await this.getBuildErrors();
        await this.runClaudeCodeWithContext(buildErrors);
      }

      const buildResult = await this.runBuild();
      buildSuccess = buildResult.success;

      if (buildSuccess) {
        logger.info('✅ Build successful!');
        return true;
      } else {
        logger.warn(`Build failed. ${MAX_BUILD_ITERATIONS - buildIteration} attempts remaining.`);
      }
    }

    return buildSuccess;
  }

  private async runTestLoop(): Promise<boolean> {
    let testIteration = 0;
    let allTestsPass = false;

    while (testIteration < MAX_TEST_ITERATIONS && !allTestsPass) {
      testIteration++;
      logger.info(`Test iteration ${testIteration}/${MAX_TEST_ITERATIONS}`);

      if (testIteration > 1) {
        const testErrors = await this.getTestErrors();
        await this.runClaudeCodeWithContext(testErrors);
      }

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
        logger.info('✅ Plugin validated as production ready!');
        return true;
      } else if (validationResult.revision_instructions) {
        logger.warn('Plugin needs revisions. Applying changes...');
        await this.runClaudeCodeWithContext(validationResult.revision_instructions);

        // Re-run build and test loops
        if (
          !(await this.runBuildLoop()) ||
          (!this.options.skipTests && !(await this.runTestLoop()))
        ) {
          return false;
        }
      }
    }

    return productionReady;
  }

  private async runClaudeCode(): Promise<void> {
    const prompt = `Please read the PLUGIN_SPEC.md file in this repository and implement the complete plugin as specified. Create all components, tests, and ensure everything is production-ready with no stubs or incomplete code.`;
    await this.runClaudeCodeWithPrompt(prompt);
  }

  private async runClaudeCodeWithContext(context: string): Promise<void> {
    const prompt = `Please read the PLUGIN_SPEC.md file and fix the following issues:

${context}

Make all necessary changes to fix the issues and ensure the plugin builds and all tests pass.`;
    await this.runClaudeCodeWithPrompt(prompt);
  }

  private async runClaudeCodeWithPrompt(prompt: string): Promise<void> {
    process.chdir(this.pluginPath!);

    logger.info('🤖 Starting Claude Code execution...');
    logger.info(`📁 Working directory: ${this.pluginPath}`);

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(
          new Error(`Claude Code execution timed out after ${CLAUDE_CODE_TIMEOUT / 1000} seconds`)
        );
      }, CLAUDE_CODE_TIMEOUT);
    });

    const executePromise = (async () => {
      try {
        const claudeArgs = [
          '--print',
          '--max-turns',
          '30',
          '--verbose',
          '--model',
          'opus',
          '--dangerously-skip-permissions',
          prompt,
        ];

        logger.info(`🚀 Executing: claude ${claudeArgs.join(' ')}`);

        this.activeClaudeProcess = execa('claude', claudeArgs, {
          stdio: 'inherit',
          cwd: this.pluginPath!,
        });

        await this.activeClaudeProcess;
        this.activeClaudeProcess = null;

        logger.info('✅ Claude Code execution completed successfully');
      } catch (error: any) {
        this.activeClaudeProcess = null;

        if (error.code === 'ENOENT') {
          throw new Error(
            'Claude Code not found! Install with: npm install -g @anthropic-ai/claude-code'
          );
        }
        throw error;
      }
    })();

    try {
      await Promise.race([executePromise, timeoutPromise]);
    } catch (error) {
      if (this.activeClaudeProcess) {
        try {
          this.activeClaudeProcess.kill();
          this.activeClaudeProcess = null;
          logger.warn('🛑 Claude Code process terminated due to timeout');
        } catch (killError) {
          logger.error('Failed to kill timed-out process:', killError);
        }
      }

      logger.error('❌ Claude Code execution failed:', error);
      throw error;
    }
  }

  private async runBuild(): Promise<{ success: boolean; errors?: string }> {
    try {
      // Install dependencies first
      logger.info('Installing dependencies...');
      await execa('npm', ['install'], {
        cwd: this.pluginPath!,
        stdio: 'pipe',
        timeout: 300000,
      });

      // Run build
      logger.info('Running build...');
      await execa('npm', ['run', 'build'], {
        cwd: this.pluginPath!,
        stdio: 'pipe',
        timeout: 120000,
      });

      return { success: true };
    } catch (error: any) {
      const errorOutput = (error.stdout || '') + '\n' + (error.stderr || '');
      logger.error('Build failed:', errorOutput);
      return { success: false, errors: errorOutput };
    }
  }

  private async getBuildErrors(): Promise<string> {
    const result = await this.runBuild();
    return result.errors || 'Build failed but no specific errors captured';
  }

  private async runTests(): Promise<{ success: boolean; errors?: string }> {
    try {
      logger.info('Running tests...');
      await execa('npm', ['test'], {
        cwd: this.pluginPath!,
        stdio: 'pipe',
        timeout: 300000,
      });

      return { success: true };
    } catch (error: any) {
      const errorOutput = (error.stdout || '') + '\n' + (error.stderr || '');
      logger.error('Tests failed:', errorOutput);
      return { success: false, errors: errorOutput };
    }
  }

  private async getTestErrors(): Promise<string> {
    const result = await this.runTests();
    return result.errors || 'Tests failed but no specific errors captured';
  }

  private async validateProductionReadiness(): Promise<ValidationResult> {
    const allFiles = await this.getAllPluginFiles();

    const prompt = `You are reviewing a newly generated ElizaOS plugin for production readiness.

## Plugin Files:
${allFiles}

## Evaluation Criteria:
1. All components are fully implemented (no stubs or TODOs)
2. Comprehensive tests exist for all functionality
3. Proper error handling throughout
4. Follows ElizaOS 1.0.0 patterns and best practices
5. All imports use @elizaos/core
6. Services extend base Service class with lifecycle methods
7. Actions have proper validation and handlers
8. Documentation is complete
9. Code is clean and well-organized
10. Plugin exports are correct

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

  private async getAllPluginFiles(): Promise<string> {
    let content = '';
    const files = await fs.readdir(this.pluginPath!, { recursive: true });

    for (const file of files) {
      if (typeof file !== 'string') continue;

      const filePath = path.join(this.pluginPath!, file);
      const stat = await fs.stat(filePath);

      if (stat.isFile() && !file.includes('node_modules') && !file.includes('.git')) {
        const ext = path.extname(file);
        if (['.ts', '.js', '.json', '.md'].includes(ext)) {
          const fileContent = await fs.readFile(filePath, 'utf-8');
          content += `\n### File: ${file}\n\`\`\`${ext.slice(1)}\n${fileContent}\n\`\`\`\n`;
        }
      }
    }

    return content;
  }

  private async copyToCWD(): Promise<string> {
    const pluginName = path.basename(this.pluginPath!);
    const targetPath = path.join(process.cwd(), pluginName);

    if (await fs.pathExists(targetPath)) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupPath = `${targetPath}-backup-${timestamp}`;
      logger.info(`Backing up existing ${pluginName} to ${path.basename(backupPath)}`);
      await fs.move(targetPath, backupPath);
    }

    logger.info(`Copying plugin to ${targetPath}`);
    await fs.copy(this.pluginPath!, targetPath, {
      filter: (src) => {
        const relativePath = path.relative(this.pluginPath!, src);
        return !relativePath.includes('.git') && !relativePath.includes('node_modules');
      },
    });

    return targetPath;
  }

  private async checkDiskSpace(): Promise<void> {
    const diskSpace = await this.getAvailableDiskSpace();
    if (diskSpace < MIN_DISK_SPACE_GB) {
      throw new Error(
        `Insufficient disk space. Need at least ${MIN_DISK_SPACE_GB}GB free, but only ${diskSpace.toFixed(2)}GB available.`
      );
    }
  }

  private async getAvailableDiskSpace(): Promise<number> {
    try {
      const result = await execa('df', ['-k', os.tmpdir()]);
      const lines = result.stdout.split('\n');
      const dataLine = lines[1];
      const parts = dataLine.split(/\s+/);
      const availableKB = parseInt(parts[3]);
      return availableKB / 1024 / 1024; // Convert to GB
    } catch (error) {
      logger.warn('Could not check disk space, proceeding anyway');
      return MIN_DISK_SPACE_GB + 1;
    }
  }
}
