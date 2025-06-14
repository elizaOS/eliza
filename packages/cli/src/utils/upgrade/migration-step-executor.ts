import * as fs from 'fs-extra';
import * as path from 'node:path';
import { logger } from '@elizaos/core';
import { execa } from 'execa';
import { globby } from 'globby';
import type { MigrationStep, StepResult, MigrationContext, FilePattern } from './types.js';
import {
  IMPORT_MAPPINGS,
  MODEL_TYPE_MAPPINGS,
  ARCHITECTURE_ISSUES,
  parseIntoChunks,
} from './mega-prompt-parser.js';
import { FileByFileMigrator } from './file-by-file-migrator.js';
import { EnvPrompter } from './env-prompter.js';

/**
 * Executes migration steps according to the mega prompt structure
 */
export class MigrationStepExecutor {
  private context: MigrationContext;

  constructor(context: MigrationContext) {
    this.context = context;
  }

  /**
   * Create all migration steps based on the mega prompt
   */
  createMigrationSteps(): MigrationStep[] {
    const steps: MigrationStep[] = [
      // Phase 1: File Structure Migration
      {
        id: 'update-package-json',
        phase: 'file-structure-migration',
        name: 'Update package.json to V2 structure',
        description: 'Updates package.json with V2 requirements',
        required: true,
        execute: async (ctx) => this.updatePackageJson(ctx),
      },
      {
        id: 'remove-v1-configs',
        phase: 'file-structure-migration',
        name: 'Remove V1 configuration files',
        description: 'Removes biome.json, vitest.config.ts, jest.config.js',
        required: true,
        execute: async (ctx) => this.removeV1Configs(ctx),
      },
      {
        id: 'update-tsconfig',
        phase: 'file-structure-migration',
        name: 'Update TypeScript configuration',
        description: 'Updates tsconfig.json and creates tsconfig.build.json',
        required: true,
        execute: async (ctx) => this.updateTsConfig(ctx),
      },
      {
        id: 'update-tsup-config',
        phase: 'file-structure-migration',
        name: 'Update tsup configuration',
        description: 'Updates tsup.config.ts for proper ESM build',
        required: true,
        execute: async (ctx) => this.updateTsupConfig(ctx),
      },
      {
        id: 'create-ci-cd',
        phase: 'file-structure-migration',
        name: 'Create CI/CD pipeline',
        description: 'Creates .github/workflows/npm-deploy.yml',
        required: true,
        execute: async (ctx) => this.createCICD(ctx),
      },
      {
        id: 'create-images-structure',
        phase: 'file-structure-migration',
        name: 'Create images structure',
        description: 'Creates images/ directory with README.md',
        required: true,
        execute: async (ctx) => this.createImagesStructure(ctx),
      },
      {
        id: 'update-gitignore',
        phase: 'file-structure-migration',
        name: 'Update .gitignore and .npmignore',
        description: 'Updates ignore files for V2',
        required: true,
        execute: async (ctx) => this.updateIgnoreFiles(ctx),
      },

      // Phase 2: Core Structure Migration (Service Layer)
      {
        id: 'create-service',
        phase: 'core-structure-migration',
        name: 'Create Service class',
        description: 'Creates Service class extending base Service',
        required: false,
        skipCondition: (ctx) => !ctx.hasService,
        execute: async (ctx) => this.createServiceClass(ctx),
      },

      // Phase 3: Configuration Migration
      {
        id: 'create-config',
        phase: 'configuration-migration',
        name: 'Create configuration with Zod',
        description: 'Creates config.ts with Zod validation',
        required: true,
        execute: async (ctx) => this.createConfig(ctx),
      },

      // Phase 4: File-by-file migration
      {
        id: 'migrate-files',
        phase: 'actions-migration',
        name: 'Migrate all code files',
        description: 'Process each file completely using file-by-file migration',
        required: true,
        execute: async (ctx) => this.migrateFilesOneByOne(ctx),
      },

      // Phase 6: Testing Infrastructure
      {
        id: 'delete-v1-tests',
        phase: 'testing-infrastructure',
        name: 'Delete V1 test structure',
        description: 'Removes __tests__ directory and test configs',
        required: true,
        execute: async (ctx) => this.deleteV1Tests(ctx),
      },
      {
        id: 'create-v2-tests',
        phase: 'testing-infrastructure',
        name: 'Create V2 test structure',
        description: 'Creates src/test/ with utils.ts and test.ts',
        required: true,
        execute: async (ctx) => this.createV2Tests(ctx),
      },

      // Phase 7: Documentation & Assets
      {
        id: 'create-readme',
        phase: 'documentation-assets',
        name: 'Create comprehensive README',
        description: 'Creates or updates README.md with V2 documentation',
        required: true,
        execute: async (ctx) => this.createReadme(ctx),
      },
      {
        id: 'create-images-structure',
        phase: 'documentation-assets',
        name: 'Create images directory structure',
        description: 'Creates images/ directory with README',
        required: true,
        execute: async (ctx) => this.createImagesStructure(ctx),
      },
      {
        id: 'create-environment-template',
        phase: 'documentation-assets',
        name: 'Create minimal environment template',
        description: 'Creates .env.example with only required fields (no defaults)',
        required: true,
        execute: async (ctx) => this.createEnvironmentTemplate(ctx),
      },

      // Phase 8: Build & Quality Validation
      {
        id: 'fix-imports',
        phase: 'build-quality-validation',
        name: 'Fix import statements',
        description: 'Updates all imports to V2 patterns',
        required: true,
        execute: async (ctx) => this.fixImports(ctx),
      },
      {
        id: 'run-formatter',
        phase: 'build-quality-validation',
        name: 'Run code formatter',
        description: 'Runs prettier to ensure consistent formatting',
        required: true,
        execute: async (ctx) => this.runFormatter(ctx),
      },

      // Phase 9: Final Integration Validation
      {
        id: 'update-plugin-export',
        phase: 'final-integration-validation',
        name: 'Update plugin export structure',
        description: 'Ensures plugin exports follow V2 pattern',
        required: true,
        execute: async (ctx) => this.updatePluginExport(ctx),
      },
    ];

    return steps;
  }

  // Implementation methods for each step

  private async updatePackageJson(ctx: MigrationContext): Promise<StepResult> {
    try {
      const packageJsonPath = path.join(ctx.repoPath, 'package.json');
      const packageJson = await fs.readJson(packageJsonPath);

      // Update to V2 structure
      packageJson.type = 'module';
      packageJson.main = 'dist/index.js';
      packageJson.module = 'dist/index.js';
      packageJson.types = 'dist/index.d.ts';

      // Add exports field
      packageJson.exports = {
        './package.json': './package.json',
        '.': {
          import: {
            types: './dist/index.d.ts',
            default: './dist/index.js',
          },
        },
      };

      // Update scripts
      packageJson.scripts = {
        ...packageJson.scripts,
        build: 'tsup',
        dev: 'tsup --watch',
        test: 'elizaos test',
        lint: 'prettier --write ./src',
        format: 'prettier --write ./src',
        'format:check': 'prettier --check ./src',
        clean: 'rm -rf dist .turbo node_modules .turbo-tsconfig.json tsconfig.tsbuildinfo',
      };

      // Add/update dependencies
      packageJson.dependencies = {
        ...packageJson.dependencies,
        '@elizaos/core': '^1.0.0',
        zod: '3.24.2',
      };

      // Add/update devDependencies
      packageJson.devDependencies = {
        ...packageJson.devDependencies,
        prettier: '3.5.3',
        tsup: '8.4.0',
      };

      // Remove vitest if present
      if (packageJson.devDependencies?.vitest) {
        const { vitest, ...otherDevDeps } = packageJson.devDependencies;
        packageJson.devDependencies = otherDevDeps;
      }

      // Add repository info if missing
      if (!packageJson.repository) {
        packageJson.repository = {
          type: 'git',
          url: `git+https://github.com/your-org/${packageJson.name}.git`,
        };
      }

      // Add publishConfig
      packageJson.publishConfig = {
        access: 'public',
      };

      await fs.writeJson(packageJsonPath, packageJson, { spaces: 2 });
      ctx.changedFiles.add('package.json');

      return {
        success: true,
        message: 'Updated package.json to V2 structure',
        changes: ['package.json'],
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to update package.json',
        error: error as Error,
      };
    }
  }

  private async removeV1Configs(ctx: MigrationContext): Promise<StepResult> {
    const v1Configs = [
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
    ];

    const removed: string[] = [];
    for (const config of v1Configs) {
      const configPath = path.join(ctx.repoPath, config);
      if (await fs.pathExists(configPath)) {
        await fs.remove(configPath);
        removed.push(config);
      }
    }

    return {
      success: true,
      message: `Removed ${removed.length} V1 configuration files`,
      changes: removed,
    };
  }

  private async updateTsConfig(ctx: MigrationContext): Promise<StepResult> {
    try {
      // Create main tsconfig.json
      const tsConfig = {
        compilerOptions: {
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'bundler',
          allowSyntheticDefaultImports: true,
          esModuleInterop: true,
          allowJs: true,
          strict: true,
          skipLibCheck: true,
          forceConsistentCasingInFileNames: true,
          declaration: true,
          outDir: './dist',
          rootDir: './src',
          resolveJsonModule: true,
        },
        include: ['src/**/*'],
        exclude: ['node_modules', 'dist', '**/*.test.*'],
      };

      await fs.writeJson(path.join(ctx.repoPath, 'tsconfig.json'), tsConfig, { spaces: 2 });

      // Create tsconfig.build.json
      const tsBuildConfig = {
        extends: './tsconfig.json',
        compilerOptions: {
          outDir: './dist',
          rootDir: './src',
        },
        include: ['src/**/*'],
        exclude: ['node_modules', 'dist', '**/*.test.*', '__tests__/**/*'],
      };

      await fs.writeJson(path.join(ctx.repoPath, 'tsconfig.build.json'), tsBuildConfig, {
        spaces: 2,
      });

      ctx.changedFiles.add('tsconfig.json');
      ctx.changedFiles.add('tsconfig.build.json');

      return {
        success: true,
        message: 'Updated TypeScript configuration',
        changes: ['tsconfig.json', 'tsconfig.build.json'],
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to update TypeScript configuration',
        error: error as Error,
      };
    }
  }

  private async updateTsupConfig(ctx: MigrationContext): Promise<StepResult> {
    try {
      const tsupConfig = `import { defineConfig } from 'tsup';

export default defineConfig({
    entry: ['src/index.ts'],
    outDir: 'dist',
    tsconfig: './tsconfig.build.json',
    sourcemap: true,
    clean: true,
    format: ['esm'],
    dts: true,
    external: [
        'dotenv',
        'fs',
        'path',
        '@reflink/reflink',
        '@node-llama-cpp',
        'https',
        'http',
        'agentkeepalive',
        'zod',
    ],
});`;

      await fs.writeFile(path.join(ctx.repoPath, 'tsup.config.ts'), tsupConfig);
      ctx.changedFiles.add('tsup.config.ts');

      return {
        success: true,
        message: 'Updated tsup configuration',
        changes: ['tsup.config.ts'],
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to update tsup configuration',
        error: error as Error,
      };
    }
  }

  private async createCICD(ctx: MigrationContext): Promise<StepResult> {
    try {
      const workflowDir = path.join(ctx.repoPath, '.github', 'workflows');
      await fs.ensureDir(workflowDir);

      const cicdContent = await this.getCICDTemplate();
      await fs.writeFile(path.join(workflowDir, 'npm-deploy.yml'), cicdContent);

      ctx.changedFiles.add('.github/workflows/npm-deploy.yml');

      return {
        success: true,
        message: 'Created CI/CD pipeline',
        changes: ['.github/workflows/npm-deploy.yml'],
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to create CI/CD pipeline',
        error: error as Error,
      };
    }
  }

  private async createImagesStructure(ctx: MigrationContext): Promise<StepResult> {
    try {
      const imagesDir = path.join(ctx.repoPath, 'images');
      await fs.ensureDir(imagesDir);

      const readmeContent = `# Plugin Images

This directory contains visual assets for the plugin.

## Required Files
- \`icon.png\` - Plugin icon (512x512px recommended)
- \`banner.png\` - Plugin banner for documentation
- \`screenshot.png\` - Plugin functionality screenshot

## Usage
These images are used in:
- NPM package listing
- Documentation
- Plugin marketplace
- GitHub repository display

## Guidelines
- Use high-quality PNG format
- Keep file sizes reasonable (<500KB each)
- Maintain consistent branding
- Follow ElizaOS visual guidelines`;

      await fs.writeFile(path.join(imagesDir, 'README.md'), readmeContent);
      ctx.changedFiles.add('images/README.md');

      return {
        success: true,
        message: 'Created images structure',
        changes: ['images/README.md'],
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to create images structure',
        error: error as Error,
      };
    }
  }

  private async updateIgnoreFiles(ctx: MigrationContext): Promise<StepResult> {
    try {
      // Update .gitignore
      const gitignoreContent = `# Dependencies
node_modules/
.pnp
.pnp.js

# Build outputs
dist/
build/
*.tsbuildinfo
.turbo/

# Environment files
.env
.env.local
.env.development.local
.env.test.local
.env.production.local

# IDE files
.vscode/
.idea/
*.swp
*.swo

# OS files
.DS_Store
Thumbs.db

# Logs
npm-debug.log*
yarn-debug.log*
yarn-error.log*
lerna-debug.log*

# Coverage
coverage/
*.lcov
*.eliza
*.elizadb`;

      await fs.writeFile(path.join(ctx.repoPath, '.gitignore'), gitignoreContent);

      // Create .npmignore
      const npmignoreContent = `# Source files
src/
__tests__/
e2e/

# Config files
tsconfig*.json
tsup.config.ts
.github/
.gitignore

# Development files
*.test.*
*.spec.*
coverage/
.turbo/`;

      await fs.writeFile(path.join(ctx.repoPath, '.npmignore'), npmignoreContent);

      ctx.changedFiles.add('.gitignore');
      ctx.changedFiles.add('.npmignore');

      return {
        success: true,
        message: 'Updated ignore files',
        changes: ['.gitignore', '.npmignore'],
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to update ignore files',
        error: error as Error,
      };
    }
  }

  private async createServiceClass(ctx: MigrationContext): Promise<StepResult> {
    // Double-check that service should be created
    if (!ctx.hasService) {
      logger.warn('⚠️  Skipping service creation - no service found in main branch');
      return {
        success: true,
        message: 'No service needed - plugin did not have service in V1',
        warnings: ['Service creation skipped - not present in original plugin'],
      };
    }

    const promptContent = `Create a Service class for the ${ctx.pluginName} plugin following V2 architecture:

⚠️ IMPORTANT: This plugin HAD a service in V1, so we are migrating it to V2.

1. Extend base Service class from @elizaos/core
2. Implement static serviceType property
3. Implement static start() method
4. Implement stop() method for cleanup
5. Implement capabilityDescription getter
6. Add proper constructor with runtime parameter

Example structure:
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
\`\`\``;

    ctx.claudePrompts.set('create-service', promptContent);

    return {
      success: true,
      message: 'Prepared Service class creation prompt',
      warnings: ['Requires Claude to implement Service class'],
    };
  }

  private async migrateFilesOneByOne(ctx: MigrationContext): Promise<StepResult> {
    const migrator = new FileByFileMigrator(ctx);
    return await migrator.migrateAllFiles();
  }

  private async createConfig(ctx: MigrationContext): Promise<StepResult> {
    const promptContent = `Create a config.ts file with Zod validation for the ${ctx.pluginName} plugin:

1. Import zod and IAgentRuntime type
2. Create ConfigSchema with all required configuration fields
3. Export type from schema inference
4. Create validateConfig function that uses runtime.getSetting()
5. Handle both runtime settings and environment variables

Example:
\`\`\`typescript
import { z } from 'zod';
import { type IAgentRuntime } from '@elizaos/core';

export const ConfigSchema = z.object({
    API_KEY: z.string().min(1, "API key is required"),
    API_ENDPOINT: z.string().url().optional(),
    ENABLE_FEATURE: z.boolean().default(false),
});

export type MyConfig = z.infer<typeof ConfigSchema>;

export function validateMyConfig(runtime: IAgentRuntime): MyConfig {
    const config = {
        API_KEY: runtime.getSetting('MY_API_KEY') || process.env.MY_API_KEY,
        API_ENDPOINT: runtime.getSetting('MY_API_ENDPOINT') || process.env.MY_API_ENDPOINT,
        ENABLE_FEATURE: runtime.getSetting('MY_ENABLE_FEATURE') === 'true',
    };
    
    return ConfigSchema.parse(config);
}
\`\`\``;

    ctx.claudePrompts.set('create-config', promptContent);

    return {
      success: true,
      message: 'Prepared config.ts creation prompt',
      warnings: ['Requires Claude to implement configuration'],
    };
  }

  private async centralizeActions(ctx: MigrationContext): Promise<StepResult> {
    const actionFiles = await globby(['src/actions/*/index.ts', 'src/actions/*/*.ts'], {
      cwd: ctx.repoPath,
    });

    if (actionFiles.length === 0) {
      return {
        success: true,
        message: 'No nested actions found to centralize',
      };
    }

    const promptContent = `Centralize actions from nested structure to src/actions.ts:

Current structure:
${actionFiles.join('\n')}

Required changes:
1. Create src/actions.ts that imports and exports all actions
2. Update all action handlers to V2 signature
3. Fix memory creation patterns (use runtime.createMemory)
4. Add Content source field to all responses
5. Update ActionExample structure (user → name)
6. Export actions array at the end

Critical patterns to fix:
${ARCHITECTURE_ISSUES.filter((i) => i.type === 'broken-handler')
  .map((i) => i.codeExample?.wrong)
  .join('\n\n')}`;

    ctx.claudePrompts.set('centralize-actions', promptContent);

    return {
      success: true,
      message: 'Prepared actions centralization prompt',
      warnings: ['Requires Claude to centralize actions'],
    };
  }

  private async migrateProviders(ctx: MigrationContext): Promise<StepResult> {
    const promptContent = `Migrate providers to V2 standard interface:

Replace custom provider interfaces with standard Provider interface:
\`\`\`typescript
export const myStateProvider: Provider = {
    name: 'myState',
    get: async (runtime: IAgentRuntime, message: Memory, state: State) => {
        const myService = runtime.getService('my-service') as MyService;
        
        return {
            data: {
                isInitialized: myService?.isInitialized() || false,
                serviceType: MyService.serviceType
            },
            values: {
                serviceStatus: myService?.isInitialized() ? 'Ready' : 'Not initialized'
            },
            text: \`My Plugin Service: \${myService?.isInitialized() ? 'Ready' : 'Not initialized'}\`
        };
    }
};
\`\`\``;

    ctx.claudePrompts.set('migrate-providers', promptContent);

    return {
      success: true,
      message: 'Prepared providers migration prompt',
      warnings: ['Requires Claude to migrate providers'],
    };
  }

  private async deleteV1Tests(ctx: MigrationContext): Promise<StepResult> {
    const testsDir = path.join(ctx.repoPath, '__tests__');
    if (await fs.pathExists(testsDir)) {
      await fs.remove(testsDir);
      return {
        success: true,
        message: 'Deleted V1 __tests__ directory',
        changes: ['__tests__/'],
      };
    }

    return {
      success: true,
      message: 'No V1 tests directory found',
    };
  }

  private async createV2Tests(ctx: MigrationContext): Promise<StepResult> {
    const testDir = path.join(ctx.repoPath, 'src', 'test');
    await fs.ensureDir(testDir);

    // Import test templates
    const { UTILS_TS_EXACT_CONTENT } = await import('./test-templates.js');

    // Create utils.ts with exact content from template
    const utilsPath = path.join(testDir, 'utils.ts');
    await fs.writeFile(utilsPath, UTILS_TS_EXACT_CONTENT);
    logger.info('✅ Created src/test/utils.ts with exact template content');

    ctx.changedFiles.add('src/test/utils.ts');

    // CRITICAL: Create placeholder test.ts to ensure correct filename
    // The real content will be generated by Claude, but this ensures the right filename exists
    const testPath = path.join(testDir, 'test.ts'); // NOT test.test.ts
    const placeholderTest = `// Placeholder - will be generated by migration system
import type { TestSuite } from "@elizaos/core";

export const test: TestSuite = {
  name: "${ctx.pluginName} tests",
  tests: []
};

export default test;`;
    
    await fs.writeFile(testPath, placeholderTest);
    logger.info('✅ Created src/test/test.ts placeholder (will be filled by test generator)');
    ctx.changedFiles.add('src/test/test.ts');

    logger.info('📝 Test suite content will be generated after migration completes');

    return {
      success: true,
      message: 'Created V2 test infrastructure (utils.ts)',
      changes: ['src/test/utils.ts'],
      warnings: ['Comprehensive test suite will be generated after migration completes'],
    };
  }

  private async createReadme(ctx: MigrationContext): Promise<StepResult> {
    const readmeTemplate = `# @elizaos/plugin-${ctx.pluginName}

Brief description of what this plugin does.

## Installation

\`\`\`bash
npm install @elizaos/plugin-${ctx.pluginName}
\`\`\`

## Configuration

Add to your \`.eliza/.env\` file:

\`\`\`bash
# Add plugin-specific environment variables here
MY_API_KEY=your_api_key_here
MY_API_ENDPOINT=https://api.example.com
MY_ENABLE_FEATURE=true
\`\`\`

## Usage

\`\`\`typescript
import ${ctx.pluginName}Plugin from '@elizaos/plugin-${ctx.pluginName}';

// Add to your ElizaOS configuration
const plugins = [${ctx.pluginName}Plugin];
\`\`\`

## Actions

- \`MY_ACTION\` - Performs plugin functionality

## Providers

- \`myState\` - Provides current plugin state

## Development

\`\`\`bash
bun run dev    # Development mode
bun run build  # Build for production
bun run test   # Run tests
bun run lint   # Lint code
\`\`\`

## License

MIT`;

    await fs.writeFile(path.join(ctx.repoPath, 'README.md'), readmeTemplate);
    ctx.changedFiles.add('README.md');

    return {
      success: true,
      message: 'Created README.md',
      changes: ['README.md'],
    };
  }

  private async fixImports(ctx: MigrationContext): Promise<StepResult> {
    const promptContent = `Fix all imports in the codebase to V2 patterns:

IMPORTANT: Do NOT modify files in src/test/ directory - they use exact templates.

Import mappings to apply:
${IMPORT_MAPPINGS.map((m) => `- ${m.oldImport} → ${m.newImport}: ${m.description}`).join('\n')}

Model type mappings:
${MODEL_TYPE_MAPPINGS.map((m) => `- ${m.v1} → ${m.v2}: ${m.description}`).join('\n')}

Key changes:
1. Add 'type' prefix for interface imports
2. ModelClass → ModelType
3. elizaLogger → logger
4. Update all parameter names (stop → stopSequences, etc.)
5. Fix ActionExample structure (user → name)

Skip test files in src/test/ - they are managed separately.`;

    ctx.claudePrompts.set('fix-imports', promptContent);

    return {
      success: true,
      message: 'Prepared import fixing prompt',
      warnings: ['Requires Claude to fix imports'],
    };
  }

  private async runFormatter(ctx: MigrationContext): Promise<StepResult> {
    try {
      await execa('bun', ['run', 'format'], {
        cwd: ctx.repoPath,
        stdio: 'pipe',
      });

      return {
        success: true,
        message: 'Ran code formatter successfully',
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to run formatter',
        error: error as Error,
        warnings: ['Run "bun run format" manually'],
      };
    }
  }

  private async updatePluginExport(ctx: MigrationContext): Promise<StepResult> {
    const promptContent = `Update the main plugin export in src/index.ts to follow V2 pattern:

Required structure:
\`\`\`typescript
import { type Plugin } from '@elizaos/core';
import { MyService } from './service';
import { myPluginActions } from './actions';
import { myPluginProviders } from './providers';
import testSuite from './test/test';

const ${ctx.pluginName}Plugin: Plugin = {
    name: '${ctx.pluginName}',
    description: 'Plugin description for ElizaOS',
    services: [MyService],
    actions: myPluginActions,
    providers: myPluginProviders,
    evaluators: [],
    tests: [testSuite],
    init: async (config: Record<string, string>, runtime: IAgentRuntime) => {
        // initialization logic if needed
    }
};

export default ${ctx.pluginName}Plugin;
\`\`\`

Ensure:
1. Default export of the plugin
2. All components are registered
3. Tests are included
4. Remove any V1 patterns`;

    ctx.claudePrompts.set('update-plugin-export', promptContent);

    return {
      success: true,
      message: 'Prepared plugin export update prompt',
      warnings: ['Requires Claude to update plugin export'],
    };
  }

  private async createEnvironmentTemplate(ctx: MigrationContext): Promise<StepResult> {
    const envExamplePath = path.join(ctx.repoPath, '.env.example');
    
    // Analyze config.ts to find required fields with improved analysis
    const configPath = path.join(ctx.repoPath, 'src', 'config.ts');
    let requiredEnvVars: string[] = [];
    
    if (await fs.pathExists(configPath)) {
      const configContent = await fs.readFile(configPath, 'utf-8');
      
      // Use improved Zod schema analysis
      requiredEnvVars = await this.analyzeZodSchemaForRequiredFields(configContent);
    }
    
    // Always include OPENAI_API_KEY as it's mandatory for ElizaOS
    const allRequiredVars = ['OPENAI_API_KEY', ...requiredEnvVars.filter(v => v !== 'OPENAI_API_KEY')];
    
    // If no other required vars found, try to guess based on common patterns
    if (allRequiredVars.length === 1) { // Only OPENAI_API_KEY
      const pluginNameUpper = ctx.pluginName
        .replace('@elizaos/plugin-', '')
        .replace('plugin-', '')
        .toUpperCase()
        .replace(/-/g, '_');
      
      // Default to API_KEY as it's almost always required
      allRequiredVars.push(`${pluginNameUpper}_API_KEY`);
    }
    
    // Create .env.example with all required fields
    const envEntries = allRequiredVars.map(varName => {
      if (varName === 'OPENAI_API_KEY') {
        return `# Required - ElizaOS core functionality\n${varName}=your_openai_api_key_here`;
      }
      return `# Required - Plugin will not function without this\n${varName}=your_${varName.toLowerCase()}_here`;
    });
    
    const headerComment = `# ${ctx.pluginName} Configuration
# All required environment variables are listed below
# 
# NOTE: During migration, you will be prompted to enter these values interactively.
# Alternatively, you can manually configure them here after migration.
# 
# To use this plugin:
# 1. Run migration - you'll be prompted for values
# 2. Or manually edit the .env file with actual values
# 3. Replace 'your_*_here' with real values\n\n`;
    
    const finalContent = `${headerComment}${envEntries.join('\n\n')}\n`;
    
    await fs.writeFile(envExamplePath, finalContent);
    ctx.changedFiles.add('.env.example');
    
    logger.info(`✅ Created .env.example with ${allRequiredVars.length} required field(s)`);
    logger.info('   💡 Environment variables will be collected interactively during migration');
    for (const v of allRequiredVars) {
      if (v === 'OPENAI_API_KEY') {
        logger.info(`   - ${v} (required for ElizaOS core)`);
      } else {
        logger.info(`   - ${v} (required, no default)`);
      }
    }

    return {
      success: true,
      message: `Created .env.example with required fields including OPENAI_API_KEY: ${allRequiredVars.join(', ')}`,
      changes: ['.env.example'],
    };
  }

  /**
   * IMPROVED: Enhanced Zod schema analysis for better environment variable detection
   */
  private async analyzeZodSchemaForRequiredFields(configContent: string): Promise<string[]> {
    const requiredFields: string[] = [];
    
    try {
      // Find the main ConfigSchema definition
      const schemaMatch = configContent.match(/(?:export\s+)?const\s+\w*ConfigSchema\s*=\s*z\.object\s*\(\s*{([\s\S]*?)}\s*\)/);
      if (!schemaMatch) {
        logger.warn('Could not find Zod schema in config.ts');
        return [];
      }
      
      const schemaContent = schemaMatch[1];
      
      // Parse field definitions with improved multi-line support
      const fields = this.parseZodSchemaFields(schemaContent);
      
      // Filter for required fields (no default, no optional)
      for (const field of fields) {
        if (field.required && !field.hasDefault && !field.isOptional) {
          // Convert field name to environment variable name
          const envVarName = this.fieldNameToEnvVar(field.name);
          requiredFields.push(envVarName);
        }
      }
      
      logger.info(`✅ Analyzed Zod schema: found ${fields.length} fields, ${requiredFields.length} required`);
      
    } catch (error) {
      logger.warn('Error analyzing Zod schema:', error);
    }
    
    return requiredFields;
  }

  /**
   * Parse Zod schema field definitions with support for multi-line and complex patterns
   */
  private parseZodSchemaFields(schemaContent: string): Array<{
    name: string;
    required: boolean;
    hasDefault: boolean;
    isOptional: boolean;
    type: string;
  }> {
    const fields: Array<{
      name: string;
      required: boolean;
      hasDefault: boolean;
      isOptional: boolean;
      type: string;
    }> = [];
    
    // Handle multi-line field definitions
    // This regex handles fields that may span multiple lines
    const fieldPattern = /(\w+):\s*z\.([^,}]+(?:\n\s*[^,}]+)*)/g;
    
    let match: RegExpExecArray | null;
    fieldPattern.lastIndex = 0; // Reset regex state
    match = fieldPattern.exec(schemaContent);
    while (match !== null) {
      const [, fieldName, fieldDefinition] = match;
      
      // Clean up the field definition by removing extra whitespace
      const cleanDef = fieldDefinition.replace(/\s+/g, ' ').trim();
      
      // Analyze the field definition
      const analysis = this.analyzeZodFieldDefinition(cleanDef);
      
      fields.push({
        name: fieldName,
        required: analysis.required,
        hasDefault: analysis.hasDefault,
        isOptional: analysis.isOptional,
        type: analysis.type
      });
      
      match = fieldPattern.exec(schemaContent);
    }
    
    return fields;
  }

  /**
   * Analyze a single Zod field definition to determine its requirements
   */
  private analyzeZodFieldDefinition(fieldDef: string): {
    required: boolean;
    hasDefault: boolean;
    isOptional: boolean;
    type: string;
  } {
    // Check for default values
    const hasDefault = /\.default\s*\(/.test(fieldDef);
    
    // Check for optional modifier
    const isOptional = /\.optional\s*\(\s*\)/.test(fieldDef);
    
    // Check for validation that implies required (like .min())
    const hasValidation = /\.min\s*\(/.test(fieldDef) || 
                         /\.max\s*\(/.test(fieldDef) ||
                         /\.length\s*\(/.test(fieldDef) ||
                         /\.regex\s*\(/.test(fieldDef) ||
                         /\.email\s*\(/.test(fieldDef) ||
                         /\.url\s*\(/.test(fieldDef);
    
    // Determine base type
    let type = 'unknown';
    if (fieldDef.includes('z.string')) type = 'string';
    else if (fieldDef.includes('z.number') || fieldDef.includes('z.coerce.number')) type = 'number';
    else if (fieldDef.includes('z.boolean')) type = 'boolean';
    else if (fieldDef.includes('z.array')) type = 'array';
    else if (fieldDef.includes('z.object')) type = 'object';
    
    // A field is required if:
    // 1. It has validation (like .min()) AND
    // 2. It doesn't have a default value AND
    // 3. It's not marked as optional
    const required = hasValidation && !hasDefault && !isOptional;
    
    return {
      required,
      hasDefault,
      isOptional,
      type
    };
  }

  /**
   * Convert a field name to environment variable format
   */
  private fieldNameToEnvVar(fieldName: string): string {
    // Convert camelCase to UPPER_SNAKE_CASE
    const envVarName = fieldName
      .replace(/([a-z])([A-Z])/g, '$1_$2') // Insert underscore before capital letters
      .toUpperCase();
    
    // If it doesn't already end with common suffixes, it might need a prefix
    // This is a heuristic based on common patterns
    if (!envVarName.includes('API_KEY') && 
        !envVarName.includes('TOKEN') && 
        !envVarName.includes('SECRET') &&
        !envVarName.includes('ENDPOINT') &&
        !envVarName.includes('URL')) {
      // This might be a field that maps to a prefixed env var
      // We'll return it as-is and let the calling code handle prefixing
    }
    
    return envVarName;
  }

  // Helper method to get CI/CD template
  private getCICDTemplate(): string {
    return `name: Publish Package

on:
  push:
    branches:
      - 1.x
  workflow_dispatch:

jobs:
  verify_version:
    runs-on: ubuntu-latest
    outputs:
      should_publish: \${{ steps.check.outputs.should_publish }}
      version: \${{ steps.check.outputs.version }}
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Check if package.json version changed
        id: check
        run: |
          echo "Current branch: \${{ github.ref }}"
          CURRENT_VERSION=$(jq -r .version package.json)
          echo "Current version: $CURRENT_VERSION"
          git rev-parse HEAD~1 || git rev-parse HEAD
          PREV_COMMIT=$(git rev-parse HEAD~1 2>/dev/null || git rev-parse HEAD)
          
          if git diff --name-only HEAD~1 HEAD | grep "package.json"; then
            echo "Package.json was changed in this commit"
            
            if git show "$PREV_COMMIT:package.json" 2>/dev/null; then
              PREV_VERSION=$(git show "$PREV_COMMIT:package.json" | jq -r .version)
              echo "Previous version: $PREV_VERSION"
              
              if [ "$CURRENT_VERSION" != "$PREV_VERSION" ]; then
                echo "Version changed from $PREV_VERSION to $CURRENT_VERSION"
                echo "should_publish=true" >> $GITHUB_OUTPUT
              else
                echo "Version unchanged"
                echo "should_publish=false" >> $GITHUB_OUTPUT
              fi
            else
              echo "First commit with package.json, will publish"
              echo "should_publish=true" >> $GITHUB_OUTPUT
            fi
          else
            echo "Package.json not changed in this commit"
            echo "should_publish=false" >> $GITHUB_OUTPUT
          fi

          echo "version=$CURRENT_VERSION" >> $GITHUB_OUTPUT

  publish:
    needs: verify_version
    if: needs.verify_version.outputs.should_publish == 'true'
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Create Git tag
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git tag -a "v\${{ needs.verify_version.outputs.version }}" -m "Release v\${{ needs.verify_version.outputs.version }}"
          git push origin "v\${{ needs.verify_version.outputs.version }}"
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}

      - name: Setup Bun
        uses: oven-sh/setup-bun@v2

      - name: Install dependencies
        run: bun install

      - name: Build package
        run: bun run build

      - name: Publish to npm
        run: bun publish
        env:
          NPM_CONFIG_TOKEN: \${{ secrets.NPM_TOKEN }}

  create_release:
    needs: [verify_version, publish]
    if: needs.verify_version.outputs.should_publish == 'true'
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - name: Create GitHub Release
        uses: actions/create-release@v1
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        with:
          tag_name: "v\${{ needs.verify_version.outputs.version }}"
          release_name: "v\${{ needs.verify_version.outputs.version }}"
          body: "Release v\${{ needs.verify_version.outputs.version }}"
          draft: false
          prerelease: false`;
  }
}
