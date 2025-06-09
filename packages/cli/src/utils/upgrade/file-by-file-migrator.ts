import { logger } from '@elizaos/core';
import { spawn } from 'child_process';

// Helper function to replace execa
function execCommand(command: string, args: string[], options: { cwd: string; stdio?: 'pipe' | 'inherit'; env?: Record<string, string> }): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: options.stdio || 'pipe',
      env: options.env ? { ...process.env, ...options.env } : process.env
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
import * as fs from 'fs-extra';
import * as path from 'node:path';
import { globby } from 'globby';
import type { MigrationContext, StepResult } from './types.js';
import { IMPORT_MAPPINGS, MODEL_TYPE_MAPPINGS, ARCHITECTURE_ISSUES } from './mega-prompt-parser.js';

/**
 * File-by-file migrator that processes each file completely before moving to the next
 */
export class FileByFileMigrator {
  private context: MigrationContext;
  private processedFiles: Set<string> = new Set();
  private filesToDelete: Set<string> = new Set();
  private foldersToDelete: Set<string> = new Set();

  constructor(context: MigrationContext) {
    this.context = context;
  }

  /**
   * Migrate all files in the plugin
   */
  async migrateAllFiles(): Promise<StepResult> {
    try {
      logger.info('🔄 Starting file-by-file migration...');

      // First, handle structural changes (package.json, configs, etc.)
      await this.migrateStructuralFiles();

      // Get all TypeScript and JavaScript files
      const codeFiles = await globby(['src/**/*.ts', 'src/**/*.js'], {
        cwd: this.context.repoPath,
        ignore: ['node_modules/**', 'dist/**', '.git/**'],
      });

      logger.info(`📂 Found ${codeFiles.length} code files to process`);

      // Process each file completely
      for (const file of codeFiles) {
        if (!this.processedFiles.has(file)) {
          await this.processFileCompletely(file);
        }
      }

      // Handle test migration separately
      await this.migrateTestStructure();

      // Clean up unnecessary files and folders
      await this.cleanupAfterMigration();

      return {
        success: true,
        message: 'File-by-file migration completed',
        changes: Array.from(this.context.changedFiles),
      };
    } catch (error) {
      return {
        success: false,
        message: 'File-by-file migration failed',
        error: error as Error,
      };
    }
  }

  /**
   * Migrate structural files (package.json, configs, etc.)
   */
  private async migrateStructuralFiles(): Promise<void> {
    logger.info('📋 Migrating structural files...');

    // These are handled by the step executor already
    this.processedFiles.add('package.json');
    this.processedFiles.add('tsconfig.json');
    this.processedFiles.add('tsconfig.build.json');
    this.processedFiles.add('tsup.config.ts');
    this.processedFiles.add('.gitignore');
    this.processedFiles.add('.npmignore');

    // Mark V1 files for deletion
    const v1ConfigFiles = [
      'biome.json',
      'vitest.config.ts',
      'vitest.config.mjs',
      'jest.config.js',
      'jest.config.ts',
      '.eslintrc.js',
      '.eslintrc.json',
      '.eslintignore',
      '.prettierrc',
      '.prettierrc.js',
      '.prettierrc.json',
      '.prettierignore',
      'environment.ts',
      'src/environment.ts',
      'environment.d.ts',
    ];

    for (const file of v1ConfigFiles) {
      if (await fs.pathExists(path.join(this.context.repoPath, file))) {
        this.filesToDelete.add(file);
      }
    }
  }

  /**
   * Process a single file completely
   */
  private async processFileCompletely(filePath: string): Promise<void> {
    logger.info(`\n📄 Processing file: ${filePath}`);
    this.processedFiles.add(filePath);

    const fullPath = path.join(this.context.repoPath, filePath);
    const content = await fs.readFile(fullPath, 'utf-8');

    // Determine file type and apply appropriate fixes
    if (filePath.includes('service') || filePath.includes('Service')) {
      await this.migrateServiceFile(filePath, content);
    } else if (filePath.includes('action') || filePath.includes('Action')) {
      await this.migrateActionFile(filePath, content);
    } else if (filePath.includes('provider') || filePath.includes('Provider')) {
      await this.migrateProviderFile(filePath, content);
    } else if (filePath === 'src/index.ts') {
      await this.migrateIndexFile(filePath, content);
    } else if (filePath.includes('config')) {
      await this.migrateConfigFile(filePath, content);
    } else {
      // Generic migration for other files
      await this.migrateGenericFile(filePath, content);
    }

    this.context.changedFiles.add(filePath);
  }

  /**
   * Migrate service files
   */
  private async migrateServiceFile(filePath: string, content: string): Promise<void> {
    // Check if service is actually needed
    if (!this.context.hasService) {
      logger.info(`⏭️  Skipping service file ${filePath} - service not required`);
      return;
    }

    logger.info(`🔧 Migrating service file: ${filePath}`);

    const prompt = `# Migrate Service File to V2

File: ${filePath}

Current content:
\`\`\`typescript
${content}
\`\`\`

Requirements:
1. Service must extend base Service class from @elizaos/core
2. Must have static serviceType property
3. Must have static start() method
4. Must have stop() method for cleanup
5. Must have capabilityDescription getter
6. Constructor must accept IAgentRuntime parameter
7. Use double quotes consistently
8. Add 'type' prefix for interface imports

Example V2 service structure:
\`\`\`typescript
export class MyService extends Service {
    static serviceType: string = 'my-service';
    
    constructor(runtime: IAgentRuntime) {
        super(runtime);
    }
    
    static async start(runtime: IAgentRuntime) {
        const service = new MyService(runtime);
        return service;
    }
    
    async stop(): Promise<void> {
        // Cleanup resources
    }
    
    get capabilityDescription(): string {
        return 'Service capability description';
    }
}
\`\`\`

Migrate this service file to V2 patterns. Make all necessary changes.`;

    await this.runCodexOnFile(prompt);
  }

  /**
   * Migrate action files
   */
  private async migrateActionFile(filePath: string, content: string): Promise<void> {
    logger.info(`🎯 Migrating action file: ${filePath}`);

    // Check if this is a nested action that needs centralization
    if (filePath.match(/src\/actions\/[^/]+\/(index\.ts|.*\.ts)$/)) {
      logger.info(`📁 Found nested action: ${filePath}`);
      // Mark for centralization but don't delete yet
      this.processedFiles.add(filePath);
      return;
    }

    const prompt = `# Migrate Action File to V2

File: ${filePath}

Current content:
\`\`\`typescript
${content}
\`\`\`

Critical V2 patterns to apply:
${ARCHITECTURE_ISSUES.filter(i => i.type === 'broken-handler' || i.type === 'memory-pattern')
  .map(i => `
- ${i.pattern}
  Solution: ${i.solution}
  Wrong: ${i.codeExample?.wrong}
  Correct: ${i.codeExample?.correct}
`).join('\n')}

Requirements:
1. Update handler signature to V2 format (no Promise<boolean> return)
2. Use runtime.createMemory() not memory operations
3. Content must have 'text' and 'source' fields only
4. ActionExample must use 'name' not 'user'
5. Update all imports (ModelType not ModelClass, etc.)
6. Use double quotes consistently
7. Add metadata field for extra data (not in content)
8. Ensure proper error handling with callback

Fix ALL issues in this action file to be fully V2 compliant.`;

    await this.runCodexOnFile(prompt);
  }

  /**
   * Migrate provider files
   */
  private async migrateProviderFile(filePath: string, content: string): Promise<void> {
    logger.info(`🔌 Migrating provider file: ${filePath}`);

    const prompt = `# Migrate Provider File to V2

File: ${filePath}

Current content:
\`\`\`typescript
${content}
\`\`\`

Requirements:
1. Use standard Provider interface from @elizaos/core
2. Must have name property
3. get() method signature: (runtime: IAgentRuntime, message: Memory, state: State) => Promise<any>
4. Return object with data/values/text properties
5. Access service via runtime.getService()
6. Remove any custom provider interfaces
7. Use double quotes consistently

Example V2 provider:
\`\`\`typescript
export const myStateProvider: Provider = {
    name: 'myState',
    get: async (runtime: IAgentRuntime, message: Memory, state: State) => {
        const myService = runtime.getService('my-service') as MyService;
        
        return {
            data: {
                isInitialized: myService?.isInitialized() || false,
            },
            values: {
                serviceStatus: myService?.isInitialized() ? 'Ready' : 'Not initialized'
            },
            text: \`Service status: \${myService?.isInitialized() ? 'Ready' : 'Not initialized'}\`
        };
    }
};
\`\`\`

Migrate this provider to V2 standard interface.`;

    await this.runCodexOnFile(prompt);
  }

  /**
   * Migrate index.ts file
   */
  private async migrateIndexFile(filePath: string, content: string): Promise<void> {
    logger.info(`📦 Migrating index file: ${filePath}`);

    const prompt = `# Migrate Plugin Index File to V2

File: ${filePath}

Current content:
\`\`\`typescript
${content}
\`\`\`

Requirements:
1. Import all components (service, actions, providers, tests)
2. Export default plugin object with V2 structure
3. Include name, description, services, actions, providers, tests
4. Add init function if needed
5. Remove evaluators (V1 pattern)
6. Use double quotes consistently

Example V2 plugin export:
\`\`\`typescript
import { type Plugin } from '@elizaos/core';
import { MyService } from './service';
import { myPluginActions } from './actions';
import { myPluginProviders } from './providers';
import testSuite from './test/test';

const myPlugin: Plugin = {
    name: 'my-plugin',
    description: 'Plugin description',
    services: [MyService],
    actions: myPluginActions,
    providers: myPluginProviders,
    evaluators: [],
    tests: [testSuite],
    init: async (config: Record<string, string>, runtime: IAgentRuntime) => {
        // initialization if needed
    }
};

export default myPlugin;
\`\`\`

Migrate this index file to proper V2 plugin export.`;

    await this.runCodexOnFile(prompt);
  }

  /**
   * Migrate config files
   */
  private async migrateConfigFile(filePath: string, content: string): Promise<void> {
    logger.info(`⚙️  Migrating config file: ${filePath}`);

    // Skip if it's the new config.ts we created
    if (filePath === 'src/config.ts' && content.includes('zod')) {
      logger.info(`✅ Config file already migrated`);
      return;
    }

    const prompt = `# Migrate Config File to V2

File: ${filePath}

Current content:
\`\`\`typescript
${content}
\`\`\`

Requirements:
1. Use Zod for schema validation
2. Use runtime.getSetting() instead of direct process.env
3. Export validation function
4. Handle both runtime settings and environment variables
5. Use double quotes consistently

Example V2 config:
\`\`\`typescript
import { z } from 'zod';
import { type IAgentRuntime } from '@elizaos/core';

export const ConfigSchema = z.object({
    API_KEY: z.string().min(1, "API key is required"),
    API_ENDPOINT: z.string().url().optional(),
});

export type MyConfig = z.infer<typeof ConfigSchema>;

export function validateMyConfig(runtime: IAgentRuntime): MyConfig {
    const config = {
        API_KEY: runtime.getSetting('MY_API_KEY') || process.env.MY_API_KEY,
        API_ENDPOINT: runtime.getSetting('MY_API_ENDPOINT') || process.env.MY_API_ENDPOINT,
    };
    
    return ConfigSchema.parse(config);
}
\`\`\`

Migrate this config to V2 patterns with Zod validation.`;

    await this.runCodexOnFile(prompt);
  }

  /**
   * Migrate generic TypeScript files
   */
  private async migrateGenericFile(filePath: string, content: string): Promise<void> {
    // Check for V1 patterns
    const hasV1Patterns = 
      content.includes('ModelClass') ||
      content.includes('elizaLogger') ||
      content.includes('runtime.memory.create') ||
      content.includes('user:') ||
      content.includes('stop:') ||
      content.includes('max_tokens:');

    if (!hasV1Patterns) {
      logger.info(`✅ File ${filePath} appears to be V2 compatible`);
      return;
    }

    logger.info(`🔄 Migrating generic file: ${filePath}`);

    const prompt = `# Migrate TypeScript File to V2

File: ${filePath}

Current content:
\`\`\`typescript
${content}
\`\`\`

Apply these V2 migrations:
${IMPORT_MAPPINGS.map(m => `- ${m.description}`).join('\n')}
${MODEL_TYPE_MAPPINGS.map(m => `- ${m.v1} → ${m.v2}`).join('\n')}

Requirements:
1. Update all imports to V2 patterns
2. Add 'type' prefix for interface imports
3. Fix all model usage (ModelType not ModelClass)
4. Fix all parameter names (stopSequences, maxTokens, etc.)
5. Use double quotes consistently
6. Fix any memory operations to use runtime.createMemory()

Make all necessary changes for V2 compatibility.`;

    await this.runCodexOnFile(prompt);
  }

  /**
   * Migrate test structure from __tests__ to src/test
   */
  private async migrateTestStructure(): Promise<void> {
    logger.info('\n🧪 Migrating test structure...');

    const oldTestDir = path.join(this.context.repoPath, '__tests__');
    const newTestDir = path.join(this.context.repoPath, 'src', 'test');

    // Check if __tests__ exists
    if (await fs.pathExists(oldTestDir)) {
      logger.info('📁 Found __tests__ directory, marking for deletion');
      this.foldersToDelete.add('__tests__');
    }

    // Ensure new test directory exists
    await fs.ensureDir(newTestDir);

    // Create test files if they don't exist
    const utilsPath = path.join(newTestDir, 'utils.ts');
    const testPath = path.join(newTestDir, 'test.ts');

    if (!(await fs.pathExists(utilsPath))) {
      logger.info('📝 Creating test utils.ts based on plugin-coinmarketcap pattern');
      // Utils creation handled by step executor
    }

    if (!(await fs.pathExists(testPath))) {
      logger.info('📝 Creating test suite based on plugin-coinmarketcap pattern');
      // Test suite creation handled by step executor
    }

    this.processedFiles.add('src/test/utils.ts');
    this.processedFiles.add('src/test/test.ts');
  }

  /**
   * Clean up unnecessary files and folders after migration
   */
  private async cleanupAfterMigration(): Promise<void> {
    logger.info('\n🧹 Cleaning up after migration...');

    // Delete marked files
    for (const file of this.filesToDelete) {
      const filePath = path.join(this.context.repoPath, file);
      if (await fs.pathExists(filePath)) {
        logger.info(`🗑️  Deleting file: ${file}`);
        await fs.remove(filePath);
      }
    }

    // Delete marked folders
    for (const folder of this.foldersToDelete) {
      const folderPath = path.join(this.context.repoPath, folder);
      if (await fs.pathExists(folderPath)) {
        logger.info(`🗑️  Deleting folder: ${folder}`);
        await fs.remove(folderPath);
      }
    }

    // Check for nested action directories to clean up if actions were centralized
    const actionDirs = await globby(['src/actions/*'], {
      cwd: this.context.repoPath,
      onlyDirectories: true,
    });

    if (actionDirs.length > 0 && await fs.pathExists(path.join(this.context.repoPath, 'src/actions.ts'))) {
      logger.info('📁 Found centralized actions.ts, cleaning up nested directories');
      for (const dir of actionDirs) {
        logger.info(`🗑️  Deleting action directory: ${dir}`);
        await fs.remove(path.join(this.context.repoPath, dir));
      }
    }

    // Delete any .bak or .orig files
    const backupFiles = await globby(['**/*.bak', '**/*.orig'], {
      cwd: this.context.repoPath,
      ignore: ['node_modules/**', '.git/**'],
    });

    for (const backup of backupFiles) {
      logger.info(`🗑️  Deleting backup file: ${backup}`);
      await fs.remove(path.join(this.context.repoPath, backup));
    }
  }

  /**
   * Run OpenAI Codex on a specific file with a prompt
   */
  private async runCodexOnFile(prompt: string): Promise<void> {
    if (!this.context.repoPath) return;

    try {
      // Write prompt to temporary file
      const tempPromptFile = path.join(this.context.repoPath, '.codex-prompt.txt');
      await fs.writeFile(tempPromptFile, prompt);

      const codexResult = await execCommand(
        'npx',
        [
          '@openai/codex',
          '--quiet',
          '--auto-edit',
          tempPromptFile,
        ],
        {
          stdio: 'inherit',
          cwd: this.context.repoPath,
          env: {
            OPENAI_API_KEY: process.env.OPENAI_API_KEY,
            // Unset NODE_OPTIONS to prevent read-only process.noDeprecation issue
            NODE_OPTIONS: undefined,
          },
        }
      );

      // Clean up temporary file
      await fs.remove(tempPromptFile);

      if (codexResult.exitCode !== 0) {
        throw new Error(`Codex failed with exit code ${codexResult.exitCode}`);
      }
    } catch (error) {
      logger.error('OpenAI Codex failed to process file:', error);
      throw error;
    }
  }
} 