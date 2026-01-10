import Anthropic from '@anthropic-ai/sdk';
import { IAgentRuntime, logger, Service } from '@elizaos/core';
import { exec, spawn, execSync } from 'child_process';
import fs from 'fs-extra';
import path from 'path';
import { promisify } from 'util';
import { v4 as uuidv4 } from 'uuid';

const execAsync = promisify(exec);

// Define our service type constant
// We can't extend ServiceTypeRegistry due to core satisfies constraint
export const PLUGIN_CREATION_SERVICE_TYPE = 'plugin_creation' as const;

// Claude model configuration
export const ClaudeModel = {
  SONNET_3_5: 'claude-3-5-sonnet-20241022',
  OPUS_3: 'claude-3-opus-20240229',
} as const;

export type ClaudeModel = typeof ClaudeModel[keyof typeof ClaudeModel];

export interface PluginSpecification {
  name: string;
  description: string;
  version?: string;
  actions?: Array<{
    name: string;
    description: string;
    parameters?: Record<string, any>;
  }>;
  providers?: Array<{
    name: string;
    description: string;
    dataStructure?: Record<string, any>;
  }>;
  services?: Array<{
    name: string;
    description: string;
    methods?: string[];
  }>;
  evaluators?: Array<{
    name: string;
    description: string;
    triggers?: string[];
  }>;
  dependencies?: Record<string, string>;
  environmentVariables?: Array<{
    name: string;
    description: string;
    required: boolean;
    sensitive: boolean;
  }>;
}

export interface PluginCreationJob {
  id: string;
  specification: PluginSpecification;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  currentPhase: string;
  progress: number;
  logs: string[];
  error?: string;
  result?: string;
  outputPath: string;
  startedAt: Date;
  completedAt?: Date;
  currentIteration: number;
  maxIterations: number;
  testResults?: {
    passed: number;
    failed: number;
    duration: number;
  };
  validationScore?: number;
  childProcess?: any;
  errors: Array<{
    iteration: number;
    phase: string;
    error: string;
    timestamp: Date;
  }>;
  modelUsed?: ClaudeModel;
}

export class PluginCreationService extends Service {
  static serviceType: 'plugin_creation' = 'plugin_creation';
  private jobs: Map<string, PluginCreationJob> = new Map();
  private anthropic: Anthropic | null = null;
  private selectedModel: ClaudeModel = ClaudeModel.OPUS_3;
  private createdPlugins: Set<string> = new Set();

  public readonly capabilityDescription: string =
    'Plugin creation service with AI-powered code generation';

  constructor(runtime?: IAgentRuntime) {
    super(runtime);
  }

  async stop(): Promise<void> {
    // Cleanup any running jobs
    for (const job of this.jobs.values()) {
      if (job.status === 'running' || job.status === 'pending') {
        job.status = 'cancelled';
        job.completedAt = new Date();
        this.logToJob(job.id, 'Service stopped, job cancelled');
      }
    }
  }

  static async start(runtime: IAgentRuntime): Promise<PluginCreationService> {
    const service = new PluginCreationService(runtime);
    await service.initialize(runtime);
    return service;
  }

  async initialize(runtime: IAgentRuntime): Promise<void> {
    this.runtime = runtime;
    const apiKey = runtime.getSetting('ANTHROPIC_API_KEY');
    if (apiKey) {
      this.anthropic = new Anthropic({ apiKey });
    }

    // Get model preference from settings
    const modelSetting = runtime.getSetting('CLAUDE_MODEL');
    if (modelSetting && Object.values(ClaudeModel).includes(modelSetting as ClaudeModel)) {
      this.selectedModel = modelSetting as ClaudeModel;
    }
  }

  public setModel(model: ClaudeModel): void {
    this.selectedModel = model;
    logger.info(`Claude model set to: ${model}`);
  }

  public getCreatedPlugins(): string[] {
    return Array.from(this.createdPlugins);
  }

  public isPluginCreated(name: string): boolean {
    return this.createdPlugins.has(name);
  }

  public async createPlugin(
    specification: PluginSpecification,
    apiKey?: string,
    options?: { useTemplate?: boolean; model?: ClaudeModel }
  ): Promise<string> {
    // Check if plugin already exists
    if (this.createdPlugins.has(specification.name)) {
      throw new Error(`Plugin ${specification.name} has already been created in this session`);
    }

    // Validate plugin name to prevent path traversal
    if (!this.isValidPluginName(specification.name)) {
      throw new Error('Invalid plugin name. Must follow format: @scope/plugin-name');
    }

    // Rate limiting check
    if (!this.checkRateLimit()) {
      throw new Error('Rate limit exceeded. Please wait before creating another plugin.');
    }

    // Resource limit check
    if (this.jobs.size >= 10) {
      throw new Error(
        'Maximum number of concurrent jobs reached. Please wait for existing jobs to complete.'
      );
    }

    // Initialize Anthropic if API key is provided
    if (apiKey) {
      this.anthropic = new Anthropic({ apiKey });
    }

    // Use provided model or default
    const model = options?.model || this.selectedModel;

    const jobId = uuidv4();
    const sanitizedName = this.sanitizePluginName(specification.name);
    const outputPath = path.join(this.getDataDir(), 'plugins', jobId, sanitizedName);

    // Ensure output path is within data directory
    const resolvedPath = path.resolve(outputPath);
    const dataDir = path.resolve(this.getDataDir());
    if (!resolvedPath.startsWith(dataDir)) {
      throw new Error('Invalid output path');
    }

    const job: PluginCreationJob = {
      id: jobId,
      specification,
      status: 'pending',
      currentPhase: 'initializing',
      progress: 0,
      logs: [],
      outputPath: resolvedPath,
      startedAt: new Date(),
      currentIteration: 0,
      maxIterations: 5,
      errors: [],
      modelUsed: model,
    };

    this.jobs.set(jobId, job);
    this.createdPlugins.add(specification.name);

    // Set timeout for job
    setTimeout(
      () => {
        const jobStatus = this.jobs.get(jobId);
        if (jobStatus && (jobStatus.status === 'pending' || jobStatus.status === 'running')) {
          jobStatus.status = 'failed';
          jobStatus.error = 'Job timed out after 30 minutes';
          jobStatus.completedAt = new Date();
          this.logToJob(jobId, 'Job timed out');
        }
      },
      30 * 60 * 1000
    ); // 30 minutes timeout

    // Start creation process in background
    this.runCreationProcess(job, options?.useTemplate ?? true).catch((error) => {
      job.status = 'failed';
      job.error = error.message;
      job.completedAt = new Date();
      this.logToJob(jobId, `Job failed: ${error.message}`);
    });

    // In tests without API key, keep job as pending
    if (!this.anthropic && !apiKey) {
      job.status = 'pending';
    }

    return jobId;
  }

  public getAllJobs(): PluginCreationJob[] {
    return Array.from(this.jobs.values());
  }

  public getJobStatus(jobId: string): PluginCreationJob | null {
    return this.jobs.get(jobId) || null;
  }

  public cancelJob(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (job && (job.status === 'pending' || job.status === 'running')) {
      job.status = 'cancelled';
      job.completedAt = new Date();
      this.logToJob(jobId, 'Job cancelled by user');

      // Kill child process if exists
      if (job.childProcess && !job.childProcess.killed) {
        job.childProcess.kill('SIGTERM');
      }
    }
  }

  private logToJob(jobId: string, message: string): void {
    const job = this.jobs.get(jobId);
    if (job) {
      job.logs.push(`[${new Date().toISOString()}] ${message}`);
      logger.info(`[Job ${jobId}] ${message}`);
    }
  }

  private getDataDir(): string {
    // Use a fallback if runtime is not initialized
    if (this.runtime && typeof this.runtime.getSetting === 'function') {
      const dataDir = this.runtime.getSetting('PLUGIN_DATA_DIR');
      if (dataDir) return dataDir;
    }
    return path.join(process.cwd(), 'data');
  }

  private async runCreationProcess(
    job: PluginCreationJob,
    useTemplate: boolean = true
  ): Promise<void> {
    try {
      // Setup workspace
      await this.setupPluginWorkspace(job, useTemplate);

      // Run creation loop
      let success = false;
      while (job.currentIteration < job.maxIterations && !success) {
        job.currentIteration++;
        job.currentPhase = `iteration ${job.currentIteration}/${job.maxIterations}`;
        job.progress = (job.currentIteration / job.maxIterations) * 100;
        this.logToJob(job.id, `Starting iteration ${job.currentIteration}`);

        success = await this.runSingleIteration(job);

        if (!success && job.currentIteration < job.maxIterations) {
          // Prepare for next iteration
          job.status = 'running';
          await this.prepareNextIteration(job);
        }
      }

      if (success) {
        job.status = 'completed';
        job.completedAt = new Date();
        this.logToJob(job.id, 'Job completed successfully');
      } else {
        job.status = 'failed';
        job.completedAt = new Date();
        this.logToJob(job.id, 'Job failed after maximum iterations');
      }
    } catch (error) {
      job.status = 'failed';
      job.error = error.message;
      job.completedAt = new Date();
      this.logToJob(job.id, `Unexpected error: ${error.message}`);
    }
  }

  private async runSingleIteration(job: PluginCreationJob): Promise<boolean> {
    try {
      // Phase 1: Generate/update code
      job.currentPhase = 'generating';
      await this.generatePluginCode(job);

      // Phase 2: Build
      job.currentPhase = 'building';
      const buildSuccess = await this.buildPlugin(job);
      if (!buildSuccess) {
        job.errors.push({
          iteration: job.currentIteration,
          phase: 'building',
          error: job.error || 'Build failed',
          timestamp: new Date(),
        });
        return false;
      }

      // Phase 3: Lint
      job.currentPhase = 'linting';
      const lintSuccess = await this.lintPlugin(job);
      if (!lintSuccess) {
        job.errors.push({
          iteration: job.currentIteration,
          phase: 'linting',
          error: job.error || 'Lint failed',
          timestamp: new Date(),
        });
        return false;
      }

      // Phase 4: Test
      job.currentPhase = 'testing';
      const testSuccess = await this.testPlugin(job);
      if (!testSuccess) {
        job.errors.push({
          iteration: job.currentIteration,
          phase: 'testing',
          error: job.error || 'Tests failed',
          timestamp: new Date(),
        });
        return false;
      }

      // Phase 5: Validate
      job.currentPhase = 'validating';
      const validationSuccess = await this.validatePlugin(job);
      if (!validationSuccess) {
        job.errors.push({
          iteration: job.currentIteration,
          phase: 'validating',
          error: job.error || 'Validation failed',
          timestamp: new Date(),
        });
        return false;
      }

      return true;
    } catch (error) {
      job.error = error.message;
      job.completedAt = new Date();
      job.errors.push({
        iteration: job.currentIteration,
        phase: job.currentPhase,
        error: error.message,
        timestamp: new Date(),
      });
      this.logToJob(job.id, `Error in iteration: ${error.message}`);
      return false;
    }
  }

  private async setupPluginWorkspace(
    job: PluginCreationJob,
    useTemplate: boolean = true
  ): Promise<void> {
    await fs.ensureDir(job.outputPath);

    if (useTemplate) {
      // Copy plugin-starter template
      // Try multiple paths to find the template
      const possiblePaths = [
        path.join(__dirname, '../../src/resources/templates/plugin-starter'),
        path.join(__dirname, '../resources/templates/plugin-starter'),
        path.join(process.cwd(), 'src/resources/templates/plugin-starter'),
        path.join(process.cwd(), 'resources/templates/plugin-starter'),
      ];

      let templatePath: string | null = null;
      for (const p of possiblePaths) {
        if (await fs.pathExists(p)) {
          templatePath = p;
          break;
        }
      }

      if (templatePath) {
        this.logToJob(job.id, 'Using plugin-starter template');
        await fs.copy(templatePath, job.outputPath, {
          filter: (src) => {
            // Skip certain files/directories
            const basename = path.basename(src);
            return !['node_modules', '.git', 'dist', '.turbo'].includes(basename);
          },
        });

        // Update package.json with plugin info
        const packageJsonPath = path.join(job.outputPath, 'package.json');
        const packageJson = await fs.readJson(packageJsonPath);

        packageJson.name = job.specification.name;
        packageJson.version = job.specification.version || '1.0.0';
        packageJson.description = job.specification.description;

        // Merge dependencies
        if (job.specification.dependencies) {
          packageJson.dependencies = {
            ...packageJson.dependencies,
            ...job.specification.dependencies,
          };
        }

        // Add environment variables to elizaos config
        if (job.specification.environmentVariables) {
          packageJson.elizaos = {
            ...packageJson.elizaos,
            environmentVariables: job.specification.environmentVariables,
          };
        }

        await fs.writeJson(packageJsonPath, packageJson, { spaces: 2 });
      } else {
        this.logToJob(job.id, 'Template not found, using fallback setup');
        await this.setupPluginWorkspaceFallback(job);
      }
    } else {
      await this.setupPluginWorkspaceFallback(job);
    }
  }

  private async setupPluginWorkspaceFallback(job: PluginCreationJob): Promise<void> {
    // Original setup code as fallback
    // Create package.json
    const packageJson = {
      name: job.specification.name,
      version: job.specification.version,
      description: job.specification.description,
      main: 'dist/index.js',
      types: 'dist/index.d.ts',
      scripts: {
        build: 'tsc',
        test: 'vitest run',
        lint: 'eslint src/**/*.ts',
        dev: 'tsc --watch',
      },
      dependencies: {
        '@elizaos/core': '^1.0.0',
        ...job.specification.dependencies,
      },
      devDependencies: {
        '@types/node': '^20.0.0',
        typescript: '^5.0.0',
        vitest: '^1.0.0',
        eslint: '^8.0.0',
        '@typescript-eslint/parser': '^6.0.0',
        '@typescript-eslint/eslint-plugin': '^6.0.0',
      },
      elizaos: {
        environmentVariables: job.specification.environmentVariables || [],
      },
    };

    await fs.writeJson(path.join(job.outputPath, 'package.json'), packageJson, {
      spaces: 2,
    });

    // Create tsconfig.json
    const tsConfig = {
      compilerOptions: {
        target: 'ES2022',
        module: 'commonjs',
        lib: ['ES2022'],
        outDir: './dist',
        rootDir: './src',
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        forceConsistentCasingInFileNames: true,
        declaration: true,
        declarationMap: true,
        sourceMap: true,
        resolveJsonModule: true,
      },
      include: ['src/**/*'],
      exclude: ['node_modules', 'dist', '**/*.test.ts'],
    };

    await fs.writeJson(path.join(job.outputPath, 'tsconfig.json'), tsConfig, {
      spaces: 2,
    });

    // Create src directory
    await fs.ensureDir(path.join(job.outputPath, 'src'));
    await fs.ensureDir(path.join(job.outputPath, 'src', '__tests__'));

    // Create .eslintrc
    const eslintConfig = {
      parser: '@typescript-eslint/parser',
      extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
      env: {
        node: true,
        es2022: true,
      },
      rules: {
        '@typescript-eslint/no-explicit-any': 'warn',
        '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      },
    };

    await fs.writeJson(path.join(job.outputPath, '.eslintrc.json'), eslintConfig, { spaces: 2 });

    // Create vitest.config.ts
    const vitestConfig = `
import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        coverage: {
            reporter: ['text', 'json', 'html']
        }
    }
});
`;

    await fs.writeFile(path.join(job.outputPath, 'vitest.config.ts'), vitestConfig.trim());
  }

  private async generatePluginCode(job: PluginCreationJob): Promise<void> {
    if (!this.anthropic) {
      throw new Error('AI code generation not available without ANTHROPIC_API_KEY');
    }

    const isFirstIteration = job.currentIteration === 1;
    const previousErrors = job.errors.filter((e) => e.iteration === job.currentIteration - 1);

    let prompt = '';

    if (isFirstIteration) {
      prompt = this.generateInitialPrompt(job.specification);
    } else {
      prompt = this.generateIterationPrompt(job, previousErrors);
    }

    const message = await this.anthropic.messages.create({
      model: job.modelUsed || this.selectedModel,
      max_tokens: 8192,
      temperature: 0,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
    });

    // Extract code from response
    const responseText = message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');

    // Parse and write files
    await this.writeGeneratedCode(job, responseText);
  }

  private generateInitialPrompt(spec: PluginSpecification): string {
    return `You are creating an ElizaOS plugin with the following specification:

Name: ${spec.name}
Description: ${spec.description}
Version: ${spec.version}

${
  spec.actions
    ? `Actions:
${spec.actions.map((a) => `- ${a.name}: ${a.description}`).join('\n')}`
    : ''
}

${
  spec.providers
    ? `Providers:
${spec.providers.map((p) => `- ${p.name}: ${p.description}`).join('\n')}`
    : ''
}

${
  spec.services
    ? `Services:
${spec.services.map((s) => `- ${s.name}: ${s.description}`).join('\n')}`
    : ''
}

${
  spec.evaluators
    ? `Evaluators:
${spec.evaluators.map((e) => `- ${e.name}: ${e.description}`).join('\n')}`
    : ''
}

Create a complete ElizaOS plugin implementation following these requirements:

1. Create src/index.ts that exports the plugin object
2. Implement all specified components (actions, providers, services, evaluators)
3. Follow ElizaOS plugin structure and conventions
4. Include proper TypeScript types
5. Add comprehensive error handling
6. Create unit tests for each component in src/__tests__/
7. Ensure all imports use @elizaos/core
8. No stubs or incomplete implementations
9. All code must be production-ready

Provide the complete implementation with file paths clearly marked.`;
  }

  private generateIterationPrompt(job: PluginCreationJob, errors: any[]): string {
    const errorSummary = errors
      .map(
        (e) => `
Phase: ${e.phase}
Error: ${e.error}
`
      )
      .join('\n');

    return `The ElizaOS plugin ${job.specification.name} has the following errors that need to be fixed:

${errorSummary}

Current plugin specification:
${JSON.stringify(job.specification, null, 2)}

Please fix all the errors by:
1. Addressing each specific error mentioned
2. Ensuring the code compiles (TypeScript)
3. Fixing any linting issues
4. Making sure all tests pass
5. Following ElizaOS conventions

Provide the updated code with file paths clearly marked.`;
  }

  private async writeGeneratedCode(job: PluginCreationJob, responseText: string): Promise<void> {
    // Parse response for file blocks
    const fileRegex =
      /```(?:typescript|ts|javascript|js)?\s*\n(?:\/\/\s*)?(?:File:\s*)?(.+?)\n([\s\S]*?)```/g;
    let match;

    while ((match = fileRegex.exec(responseText)) !== null) {
      const filePath = match[1].trim();
      const fileContent = match[2].trim();

      // Ensure file path is relative to src/
      const normalizedPath = filePath.startsWith('src/') ? filePath : `src/${filePath}`;
      const fullPath = path.join(job.outputPath, normalizedPath);

      await fs.ensureDir(path.dirname(fullPath));
      await fs.writeFile(fullPath, fileContent);
    }

    // If no files were parsed, try to extract the main index.ts
    if (!responseText.includes('File:') && !responseText.includes('```')) {
      // Assume the entire response is the index.ts content
      const indexPath = path.join(job.outputPath, 'src', 'index.ts');
      await fs.writeFile(indexPath, responseText);
    }
  }

  private async buildPlugin(job: PluginCreationJob): Promise<boolean> {
    try {
      // Install dependencies first
      await this.runCommand(job, 'npm', ['install'], 'Installing dependencies');

      // Run TypeScript compilation
      const { success, output } = await this.runCommand(
        job,
        'npm',
        ['run', 'build'],
        'Building plugin'
      );

      if (!success) {
        job.error = output;
        return false;
      }

      return true;
    } catch (error) {
      job.error = error.message;
      return false;
    }
  }

  private async lintPlugin(job: PluginCreationJob): Promise<boolean> {
    try {
      const { success, output } = await this.runCommand(
        job,
        'npm',
        ['run', 'lint'],
        'Linting plugin'
      );

      if (!success) {
        job.error = output;
        return false;
      }

      return true;
    } catch (error) {
      job.error = error.message;
      return false;
    }
  }

  private async testPlugin(job: PluginCreationJob): Promise<boolean> {
    try {
      const { success, output } = await this.runCommand(job, 'npm', ['test'], 'Running tests');

      // Parse test results
      const testResults = this.parseTestResults(output);
      job.testResults = testResults;

      if (!success || testResults.failed > 0) {
        job.error = `${testResults.failed} tests failed`;
        return false;
      }

      return true;
    } catch (error) {
      job.error = error.message;
      return false;
    }
  }

  private async validatePlugin(job: PluginCreationJob): Promise<boolean> {
    if (!this.anthropic) {
      // Skip AI validation if no API key
      logger.warn('Skipping AI validation - no ANTHROPIC_API_KEY');
      return true;
    }

    try {
      // Collect all generated code
      const codeFiles = await this.collectCodeFiles(job.outputPath);

      const validationPrompt = `Review this ElizaOS plugin for production readiness:

Plugin: ${job.specification.name}
Specification: ${JSON.stringify(job.specification, null, 2)}

Generated Code:
${codeFiles
  .map(
    (f) => `
File: ${f.path}
\`\`\`typescript
${f.content}
\`\`\`
`
  )
  .join('\n')}

Evaluate:
1. Does it implement all specified features?
2. Is the code complete without stubs?
3. Does it follow ElizaOS conventions?
4. Is error handling comprehensive?
5. Are the tests adequate?
6. Is it production ready?

Respond with JSON:
{
  "score": 0-100,
  "production_ready": boolean,
  "issues": ["list of issues"],
  "suggestions": ["list of improvements"]
}`;

      const message = await this.anthropic.messages.create({
        model: job.modelUsed || this.selectedModel,
        max_tokens: 4096,
        temperature: 0,
        messages: [
          {
            role: 'user',
            content: validationPrompt,
          },
        ],
      });

      const responseText = message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n');

      const validation = JSON.parse(responseText);
      job.validationScore = validation.score;

      if (!validation.production_ready) {
        job.error = `Score: ${validation.score}/100. Issues: ${validation.issues.join(', ')}`;
        return false;
      }

      return true;
    } catch (error) {
      job.error = error.message;
      return false;
    }
  }

  private async runCommand(
    job: PluginCreationJob,
    command: string,
    args: string[],
    description: string
  ): Promise<{ success: boolean; output: string }> {
    return new Promise((resolve) => {
      this.logToJob(job.id, `${description} for ${job.specification.name}`);

      let output = '';
      let outputSize = 0;
      const maxOutputSize = 1024 * 1024; // 1MB limit

      // Handle package manager commands
      let actualCommand = command;
      let actualArgs = args;
      
      if (command === 'npm') {
        // Try to find a package manager that exists
        const packageManagers = [
          { cmd: 'bun', install: ['install'], run: ['run'], test: ['test'] },
          { cmd: 'pnpm', install: ['install'], run: ['run'], test: ['test'] },
          { cmd: 'yarn', install: ['install'], run: ['run'], test: ['test'] },
          { cmd: 'npm', install: ['install'], run: ['run'], test: ['test'] }
        ];
        
        // Check which package manager is available
        for (const pm of packageManagers) {
          try {
            execSync(`which ${pm.cmd}`, { stdio: 'ignore' });
            actualCommand = pm.cmd;
            
            // Adjust args based on package manager
            if (args[0] === 'install') {
              actualArgs = pm.install;
            } else if (args[0] === 'run') {
              actualArgs = [...pm.run, ...args.slice(1)];
            } else if (args[0] === 'test') {
              actualArgs = pm.test;
            }
            
            this.logToJob(job.id, `Using ${pm.cmd} as package manager`);
            break;
          } catch {
            // Try next package manager
          }
        }
      }

      // In test environment, we need to ensure commands are available
      const spawnOptions: any = {
        cwd: job.outputPath,
        env: { ...process.env },
        shell: false, // Prevent shell injection
      };

      // Add common paths to PATH
      const paths = [
        '/usr/local/bin',
        '/usr/bin',
        '/bin',
        '/opt/homebrew/bin',
        `${process.env.HOME}/.bun/bin`,
        `${process.env.HOME}/.nvm/versions/node/v23.11.0/bin`,
        process.env.PATH
      ].filter(Boolean);
      
      spawnOptions.env.PATH = paths.join(':');

      const child = spawn(actualCommand, actualArgs, spawnOptions);

      // Handle spawn errors (e.g., command not found)
      child.on('error', (error: any) => {
        if (error.code === 'ENOENT') {
          this.logToJob(job.id, `Command '${actualCommand}' not found`);
          resolve({
            success: false,
            output: `Error: Command '${actualCommand}' not found. ${error.message}`,
          });
        } else {
          this.logToJob(job.id, `Process error: ${error.message}`);
          resolve({
            success: false,
            output: `Process error: ${error.message}`,
          });
        }
      });

      const handleData = (data: Buffer) => {
        outputSize += data.length;
        if (outputSize < maxOutputSize) {
          output += data.toString();
        } else if (outputSize >= maxOutputSize && !output.includes('Output truncated')) {
          output += '\n[Output truncated due to size limit]';
          this.logToJob(job.id, 'Output truncated due to size limit');
        }
      };

      child.stdout.on('data', handleData);
      child.stderr.on('data', handleData);

      child.on('close', (code) => {
        resolve({
          success: code === 0,
          output,
        });
      });

      // Kill process after timeout
      const timeout = setTimeout(
        () => {
          try {
            child.kill('SIGTERM');
          } catch (e) {
            // Process might already be dead
          }
          resolve({
            success: false,
            output: output + '\n[Process killed due to timeout]',
          });
        },
        5 * 60 * 1000
      ); // 5 minutes per command

      child.on('exit', () => {
        clearTimeout(timeout);
      });

      // Store process reference
      job.childProcess = child;
    });
  }

  private parseTestResults(output: string): any {
    // Parse vitest output
    const passedMatch = output.match(/(\d+) passed/);
    const failedMatch = output.match(/(\d+) failed/);
    const skippedMatch = output.match(/(\d+) skipped/);
    const durationMatch = output.match(/Duration (\d+\.?\d*)s/);

    const results = {
      passed: passedMatch ? parseInt(passedMatch[1]) : 0,
      failed: failedMatch ? parseInt(failedMatch[1]) : 0,
      skipped: skippedMatch ? parseInt(skippedMatch[1]) : 0,
      duration: durationMatch ? parseFloat(durationMatch[1]) : 0,
      failures: [] as any[],
    };

    // Extract failure details if any
    if (results.failed > 0) {
      const failureRegex = /FAIL\s+(.+?)\s+›\s+(.+?)(?:\n|$)/g;
      let match;
      while ((match = failureRegex.exec(output)) !== null) {
        results.failures.push({
          test: `${match[1]} › ${match[2]}`,
          error: 'See full output for details',
        });
      }
    }

    return results;
  }

  private async collectCodeFiles(
    dirPath: string
  ): Promise<Array<{ path: string; content: string }>> {
    const files: Array<{ path: string; content: string }> = [];

    const collectRecursive = async (currentPath: string, basePath: string) => {
      const entries = await fs.readdir(currentPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(currentPath, entry.name);
        const relativePath = path.relative(basePath, fullPath);

        if (entry.isDirectory()) {
          if (!['node_modules', 'dist', '.git'].includes(entry.name)) {
            await collectRecursive(fullPath, basePath);
          }
        } else if (entry.isFile() && /\.(ts|js|json)$/.test(entry.name)) {
          const content = await fs.readFile(fullPath, 'utf-8');
          files.push({ path: relativePath, content });
        }
      }
    };

    await collectRecursive(dirPath, dirPath);
    return files;
  }

  private async prepareNextIteration(job: PluginCreationJob): Promise<void> {
    // Clean up failed build artifacts
    const distPath = path.join(job.outputPath, 'dist');
    if (await fs.pathExists(distPath)) {
      await fs.remove(distPath);
    }

    // Log iteration summary
    logger.info(`Iteration ${job.currentIteration} summary for ${job.specification.name}:`);
    const iterationErrors = job.errors.filter((e) => e.iteration === job.currentIteration);
    iterationErrors.forEach((e) => {
      logger.error(`  - ${e.phase}: ${e.error}`);
    });
  }

  private async notifyPluginReady(job: PluginCreationJob): Promise<void> {
    // Notify plugin management service
    const pluginService = this.runtime.getService('pluginManagement') as any;
    if (pluginService) {
      try {
        // Install the newly created plugin
        await pluginService.installPlugin(job.outputPath);
        logger.success(`Plugin ${job.specification.name} installed from ${job.outputPath}`);
      } catch (error) {
        logger.error(`Failed to install newly created plugin:`, error);
      }
    }
  }

  private async ensureWorkspaceDirs(): Promise<void> {
    const workspaceDir = path.join(this.getDataDir(), 'plugin_dev_workspace');
    await fs.ensureDir(workspaceDir);
  }

  // Public API methods

  getJob(jobId: string): PluginCreationJob | undefined {
    return this.jobs.get(jobId);
  }

  listJobs(): PluginCreationJob[] {
    return Array.from(this.jobs.values());
  }

  private isValidPluginName(name: string): boolean {
    // Validate plugin name format and prevent path traversal
    const validNameRegex = /^@?[a-zA-Z0-9-_]+\/[a-zA-Z0-9-_]+$/;
    return (
      validNameRegex.test(name) &&
      !name.includes('..') &&
      !name.includes('./') &&
      !name.includes('\\')
    );
  }

  private sanitizePluginName(name: string): string {
    // Remove @ prefix and replace / with -
    return name.replace(/^@/, '').replace(/\//g, '-').toLowerCase();
  }

  private lastJobCreation: number = 0;
  private jobCreationCount: number = 0;

  private checkRateLimit(): boolean {
    const now = Date.now();
    const oneHour = 60 * 60 * 1000;

    // Reset counter if more than an hour has passed
    if (now - this.lastJobCreation > oneHour) {
      this.jobCreationCount = 0;
    }

    // Allow max 10 jobs per hour
    if (this.jobCreationCount >= 10) {
      return false;
    }

    this.lastJobCreation = now;
    this.jobCreationCount++;
    return true;
  }

  // Add cleanup method for old jobs
  public cleanupOldJobs(): void {
    const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const jobsToRemove: string[] = [];

    for (const [jobId, job] of this.jobs.entries()) {
      if (job.completedAt && job.completedAt < oneWeekAgo) {
        jobsToRemove.push(jobId);

        // Clean up output directory
        if (job.outputPath) {
          fs.remove(job.outputPath).catch((err) => {
            logger.error(`Failed to clean up job ${jobId} output:`, err);
          });
        }
      }
    }

    // Remove old jobs from memory
    jobsToRemove.forEach((jobId) => this.jobs.delete(jobId));

    if (jobsToRemove.length > 0) {
      logger.info(`Cleaned up ${jobsToRemove.length} old jobs`);
    }
  }
}
