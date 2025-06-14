import { logger } from '@elizaos/core';
import { execa } from 'execa';
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

      // Process each file that hasn't been processed yet
      const files = await globby(['src/**/*.ts', 'src/**/*.js'], {
        cwd: this.context.repoPath,
        ignore: ['node_modules/**', 'dist/**', 'build/**'],
      });

      logger.info(`Found ${files.length} source files to process`);

      for (const file of files) {
        if (!this.processedFiles.has(file)) {
          // Skip test files - they will be created with exact templates in Phase 6
          if (file.startsWith('src/test/') || file.startsWith('src/tests/')) {
            logger.info(`⏭️  Skipping test file ${file} - will be created from templates`);
            continue;
          }
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

    // Mark V1 files for deletion - comprehensive list from plugin-news analysis
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
      '.env.example',
      '.env.template',
      'CHANGELOG.md',
      'CONTRIBUTING.md',
    ];

    for (const file of v1ConfigFiles) {
      if (await fs.pathExists(path.join(this.context.repoPath, file))) {
        this.filesToDelete.add(file);
      }
    }

    // Also check for V1 test directories to mark for deletion
    const v1TestDirs = ['__tests__', 'test'];
    for (const dir of v1TestDirs) {
      if (await fs.pathExists(path.join(this.context.repoPath, dir))) {
        this.foldersToDelete.add(dir);
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
      logger.warn(`⚠️  Found service file ${filePath} but no service in main branch - DELETING`);
      // Mark for deletion since service shouldn't exist
      this.filesToDelete.add(filePath);
      return;
    }

    logger.info(`🔧 Migrating service file: ${filePath} (verified: existed in V1)`);

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

    await this.runClaudeOnFile(prompt);
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

    await this.runClaudeOnFile(prompt);
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

    await this.runClaudeOnFile(prompt);
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

    await this.runClaudeOnFile(prompt);
  }

  /**
   * Migrate config files
   */
  private async migrateConfigFile(filePath: string, content: string): Promise<void> {
    logger.info(`⚙️  Migrating config file: ${filePath}`);

    // Skip if it's the new config.ts we created
    if (filePath === 'src/config.ts' && content.includes('zod')) {
      logger.info('✅ Config file already migrated');
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

    await this.runClaudeOnFile(prompt);
  }

  /**
   * Migrate generic TypeScript files
   */
  private async migrateGenericFile(filePath: string, content: string): Promise<void> {
    // Enhanced V1 pattern detection from plugin-news analysis
    const v1Patterns = [
      { pattern: /ModelClass/g, found: false, name: 'ModelClass usage' },
      { pattern: /elizaLogger/g, found: false, name: 'elizaLogger usage' },
      { pattern: /runtime\.memory\.create/g, found: false, name: 'memory.create usage' },
      { pattern: /runtime\.messageManager\.createMemory/g, found: false, name: 'messageManager usage' },
      { pattern: /runtime\.language\.generateText/g, found: false, name: 'generateText usage' },
      { pattern: /user:\s*["']/g, found: false, name: 'role property in examples' },
      { pattern: /role:\s*["']/g, found: false, name: 'role property' },
      { pattern: /stop:\s*\[/g, found: false, name: 'stop parameter' },
      { pattern: /max_tokens:/g, found: false, name: 'max_tokens parameter' },
      { pattern: /frequency_penalty:/g, found: false, name: 'frequency_penalty parameter' },
      { pattern: /import\s+{\s*type\s+\w+\s*}/g, found: false, name: 'type imports needing conversion' },
      { pattern: /import\s+{[^}]*,\s*type\s+[^}]+}/g, found: false, name: 'mixed imports' },
      { pattern: /state:\s*{}\s*[,)]/g, found: false, name: 'empty State objects' },
      { pattern: /\sany\s*[,)]/g, found: false, name: 'any type usage' },
      { pattern: /Promise<boolean>/g, found: false, name: 'Promise<boolean> return type' },
      { pattern: /static serviceType:\s*ServiceType/g, found: false, name: 'explicit ServiceType' },
      { pattern: /private config:/g, found: false, name: 'private config field' },
      { pattern: /z\.number\(\)/g, found: false, name: 'non-coerced Zod numbers' },
      // Additional patterns from plugin-news migration
      { pattern: /import\s+{\s*TestSuite\s*}/g, found: false, name: 'TestSuite value import' },
      { pattern: /import\s+{\s*AgentTest/g, found: false, name: 'AgentTest import' },
      { pattern: /export\s+(const|let|var)\s+testSuite/g, found: false, name: 'testSuite export name' },
      { pattern: /_options:\s*any/g, found: false, name: 'options any type' },
      { pattern: /context:\s*["']/g, found: false, name: 'context parameter in useModel' },
      { pattern: /model:\s*ModelType/g, found: false, name: 'model in options object' },
      { pattern: /import\s+{\s*(\w+),\s*type\s+(\w+)\s*}\s+from\s+["']@elizaos\/core["']/g, found: false, name: 'mixed @elizaos/core imports' },
      { pattern: /state\s*\|\s*undefined/g, found: false, name: 'State | undefined type' },
      { pattern: /callback\?:/g, found: false, name: 'optional callback parameter' },
      { pattern: /options.*=\s*{}/g, found: false, name: 'options default empty object' },
    ];

    // Check for V1 patterns
    let hasV1Patterns = false;
    for (const p of v1Patterns) {
      if (p.pattern.test(content)) {
        p.found = true;
        hasV1Patterns = true;
      }
    }

    if (!hasV1Patterns) {
      logger.info(`✅ File ${filePath} appears to be V2 compatible`);
      return;
    }

    // Log detected patterns
    const detectedPatterns = v1Patterns.filter(p => p.found).map(p => p.name);
    logger.info(`🔄 Migrating generic file: ${filePath}`);
    if (detectedPatterns.length > 0) {
      logger.info(`   Detected V1 patterns: ${detectedPatterns.join(', ')}`);
    }

    const prompt = `# Comprehensive V2 Migration for TypeScript File

File: ${filePath}

Current content:
\`\`\`typescript
${content}
\`\`\`

Detected V1 patterns that MUST be fixed:
${detectedPatterns.map(p => `- ${p}`).join('\n')}

## Critical Import Fixes:
${IMPORT_MAPPINGS.map(m => `- ${m.description}
  Old: ${m.oldImport}
  New: ${m.newImport}`).join('\n')}

## Model/API Changes:
${MODEL_TYPE_MAPPINGS.map(m => `- ${m.v1} → ${m.v2} (${m.description})`).join('\n')}

## Type Import Rules:
1. Separate ALL type imports from value imports
   Wrong: import { Service, type IAgentRuntime } from "@elizaos/core";
   Right: import { Service } from "@elizaos/core";
          import type { IAgentRuntime } from "@elizaos/core";

2. Use type-only imports for interfaces
   Wrong: import { TestSuite } from "@elizaos/core";
   Right: import type { TestSuite } from "@elizaos/core";

## State Object Rules:
1. Never use empty objects as State
   Wrong: state: {}
   Right: state: { values: {}, data: {}, text: "" }

2. Create proper State helper if needed:
   export function createTestState(): State {
     return { values: {}, data: {}, text: "" };
   }

## Handler Signature Rules:
1. Remove Promise<boolean> return type
2. Use proper options type: { [key: string]: unknown }
3. Always include callback parameter

## Memory API Rules:
1. Use runtime.createMemory() not runtime.memory.create()
2. Include all required fields: entityId, agentId, roomId, content, metadata, createdAt
3. Content should only have text and source fields

## Config/Zod Rules:
1. Use z.coerce.number() for ALL numeric environment variables
   Wrong: z.number()
   Right: z.coerce.number()

## Service Rules:
1. Remove explicit ServiceType annotation
   Wrong: static serviceType: ServiceType = "my-service";
   Right: static serviceType = "my-service";

2. Make config public for test access if needed

## Additional Rules:
1. Use double quotes consistently
2. Add null safety with optional chaining (?.)
3. Replace 'any' with proper types or { [key: string]: unknown }
4. Fix ALL occurrences, not just the first one

IMPORTANT: Fix ALL detected patterns comprehensively. Make the file fully V2 compliant.`;

    await this.runClaudeOnFile(prompt);
  }

  /**
   * Migrate test structure from __tests__ to src/test
   */
  private async migrateTestStructure(): Promise<void> {
    logger.info('\n🧪 Migrating test structure...');

    const oldTestDir = path.join(this.context.repoPath, '__tests__');
    const oldTestsDir = path.join(this.context.repoPath, 'src', 'tests');
    const newTestDir = path.join(this.context.repoPath, 'src', 'test');

    // Check if __tests__ exists
    if (await fs.pathExists(oldTestDir)) {
      logger.info('📁 Found __tests__ directory, marking for deletion');
      this.foldersToDelete.add('__tests__');
    }

    // Check if src/tests exists (V1 pattern)
    if (await fs.pathExists(oldTestsDir)) {
      logger.info('📁 Found src/tests directory (V1 pattern), marking for deletion');
      this.foldersToDelete.add('src/tests');
    }

    // Ensure new test directory exists
    await fs.ensureDir(newTestDir);

    logger.info('📝 Test directory prepared, files will be created in testing infrastructure phase');
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

    // Clean up WRONG test files but preserve ElizaOS V2 pattern
    const wrongTestFiles = await globby([
      'src/test/*.test.ts',  // Wrong: ElizaOS V2 uses test.ts not *.test.ts
      'src/test/*.spec.ts',  // Wrong: ElizaOS V2 uses test.ts not *.spec.ts
    ], {
      cwd: this.context.repoPath,
    });
    
    for (const testFile of wrongTestFiles) {
      // PRESERVE src/test/test.ts - this is the CORRECT ElizaOS V2 pattern
      if (testFile === 'src/test/test.ts') {
        logger.info(`✅ Preserving correct ElizaOS V2 test file: ${testFile}`);
        continue;
      }
      
      logger.info(`🗑️  Deleting incorrect test file: ${testFile}`);
      await fs.remove(path.join(this.context.repoPath, testFile));
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

    // Clean up additional V1 patterns from comprehensive analysis
    const additionalCleanupPatterns = [
      '**/*.bak',
      '**/*.orig',
      '**/yarn.lock', // If switching to bun
      '**/package-lock.json', // If switching to bun
      '**/pnpm-lock.yaml', // If switching to bun
      '**/.turbo/',
      '**/dist/',
      '**/build/',
      '**/*.tsbuildinfo',
      '**/.turbo-tsconfig.json',
      '**/coverage/',
      '**/*.lcov',
    ];

    for (const pattern of additionalCleanupPatterns) {
      const files = await globby([pattern], {
        cwd: this.context.repoPath,
        ignore: ['node_modules/**', '.git/**'],
      });

      for (const file of files) {
        logger.info(`🗑️  Deleting: ${file}`);
        await fs.remove(path.join(this.context.repoPath, file));
      }
    }

    // Clean up any V1 lib directories if present
    const libDir = path.join(this.context.repoPath, 'lib');
    if (await fs.pathExists(libDir)) {
      logger.info('🗑️  Deleting V1 lib directory');
      await fs.remove(libDir);
    }

    // Clean up V1 vendor directories
    const vendorPatterns = await globby(['**/vendor'], {
      cwd: this.context.repoPath,
      onlyDirectories: true,
      ignore: ['node_modules/**'],
    });

    for (const vendor of vendorPatterns) {
      logger.info(`🗑️  Deleting vendor directory: ${vendor}`);
      await fs.remove(path.join(this.context.repoPath, vendor));
    }
  }

  /**
   * Run Claude on a specific file with a prompt
   */
  private async runClaudeOnFile(prompt: string): Promise<void> {
    if (!this.context.repoPath) return;

    try {
      await execa(
        'claude',
        [
          '--print',
          '--max-turns',
          '10',
          '--model',
          'claude-sonnet-4-20250514',
          '--dangerously-skip-permissions',
          prompt,
        ],
        {
          stdio: 'inherit',
          cwd: this.context.repoPath,
          timeout: 5 * 60 * 1000, // 5 minutes per file
        }
      );
    } catch (error) {
      logger.error('Claude failed to process file:', error);
      throw error;
    }
  }
} 