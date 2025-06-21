/**
 * FILE STRUCTURE MIGRATION STEPS
 * 
 * Responsibilities:
 * - Package.json updates to V2 structure
 * - TypeScript and build configuration
 * - CI/CD pipeline creation
 * - Ignore files management
 * - Images directory structure
 * - V1 configuration cleanup
 */

import * as fs from 'fs-extra';
import * as path from 'node:path';
import type { MigrationContext, StepResult } from '../types.js';

export class FileStructureSteps {
  private context: MigrationContext;

  constructor(context: MigrationContext) {
    this.context = context;
  }

  /**
   * Update package.json to V2 structure
   */
  async updatePackageJson(ctx: MigrationContext): Promise<StepResult> {
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

  /**
   * Remove V1 configuration files
   */
  async removeV1Configs(ctx: MigrationContext): Promise<StepResult> {
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

  /**
   * Update TypeScript configuration
   */
  async updateTsConfig(ctx: MigrationContext): Promise<StepResult> {
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

  /**
   * Update tsup configuration
   */
  async updateTsupConfig(ctx: MigrationContext): Promise<StepResult> {
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

  /**
   * Create CI/CD pipeline
   */
  async createCICD(ctx: MigrationContext): Promise<StepResult> {
    try {
      const workflowDir = path.join(ctx.repoPath, '.github', 'workflows');
      await fs.ensureDir(workflowDir);

      const cicdContent = this.getCICDTemplate();
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

  /**
   * Create images directory structure
   */
  async createImagesStructure(ctx: MigrationContext): Promise<StepResult> {
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

  /**
   * Update .gitignore and .npmignore files
   */
  async updateIgnoreFiles(ctx: MigrationContext): Promise<StepResult> {
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

  /**
   * Get CI/CD template content
   */
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