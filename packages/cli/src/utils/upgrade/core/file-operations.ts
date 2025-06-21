import * as fs from 'fs-extra';
import * as path from 'node:path';
import { logger } from '@elizaos/core';
import { globby } from 'globby';
import type { MigrationContext } from '../types.js';
import { LOCK_FILE_NAME } from '../config.js';

/**
 * File operations for migration process
 */
export class FileOperations {
  private lockFilePath: string | null = null;

  constructor(private repoPath: string) {}

  /**
   * Create lock file to prevent concurrent migrations
   */
  async createLockFile(): Promise<void> {
    this.lockFilePath = path.join(this.repoPath, LOCK_FILE_NAME);

    // Check if lock file exists
    if (await fs.pathExists(this.lockFilePath)) {
      const lockData = await fs.readFile(this.lockFilePath, 'utf-8');
      const errorMessage = `Another migration is already running on this repository.
Lock file: ${this.lockFilePath}
Lock data: ${lockData}
If this is an error, manually delete the lock file and try again.`;
      throw new Error(errorMessage);
    }

    // Create lock file with process info
    const lockData = {
      pid: process.pid,
      startTime: new Date().toISOString(),
      repository: this.repoPath,
    };

    await fs.writeFile(this.lockFilePath, JSON.stringify(lockData, null, 2));
  }

  /**
   * Remove lock file
   */
  async removeLockFile(): Promise<void> {
    if (this.lockFilePath && (await fs.pathExists(this.lockFilePath))) {
      await fs.remove(this.lockFilePath);
      this.lockFilePath = null;
    }
  }

  /**
   * Check modified files and update context
   */
  async checkModifiedFiles(context: MigrationContext): Promise<void> {
    try {
      // Get all TypeScript files in src
      const files = await globby(['src/**/*.ts'], {
        cwd: this.repoPath,
        ignore: ['node_modules/**', 'dist/**']
      });

      // Update changed files set
      for (const file of files) {
        context.changedFiles.add(file);
      }

      logger.info(`📊 Tracking ${context.changedFiles.size} files`);
    } catch (error) {
      logger.warn('Could not check modified files:', error);
    }
  }

  /**
   * Include test suites in index.ts for build validation
   */
  async includeTestSuitesInIndex(
    context: MigrationContext, 
    claudeIntegration: { runClaudeWithPrompt: (prompt: string) => Promise<void> }
  ): Promise<void> {
    try {
      const indexPath = path.join(this.repoPath, 'src', 'index.ts');
      
      // Check if index.ts exists
      if (!(await fs.pathExists(indexPath))) {
        logger.warn('⚠️  index.ts not found, skipping test suite inclusion');
        return;
      }

      // Check if test file exists (must be test.ts, not test.test.ts)
      const testFilePath = path.join(this.repoPath, 'src', 'test', 'test.ts');
      const hasTestFile = await fs.pathExists(testFilePath);

      if (!hasTestFile) {
        logger.info('ℹ️  No src/test/test.ts file found, skipping test suite inclusion');
        logger.info('   Expected: src/test/test.ts (ElizaOS V2 standard)');
        return;
      }

      // Read current files
      const indexContent = await fs.readFile(indexPath, 'utf-8');
      const testContent = await fs.readFile(testFilePath, 'utf-8');

      // Check if test imports/exports already exist
      if (indexContent.includes('test/test') || indexContent.includes('tests:')) {
        logger.info('✅ Test suites already included in index.ts');
        return;
      }
      
      logger.info('🤖 Using Claude to integrate test suite into index.ts...');

      // Create Claude prompt for test suite integration
      const testIntegrationPrompt = `# Fix ElizaOS V2 Plugin Test Suite Integration

## Current src/index.ts:
\`\`\`typescript
${indexContent}
\`\`\`

## Current src/test/test.ts (test file exists):
\`\`\`typescript
${testContent.slice(0, 200)}...
\`\`\`

## 🎯 TASK: Fix the plugin to properly include the test suite

### CRITICAL REQUIREMENTS:
1. **Import the test suite** from "./test/test.js" (note .js extension)
2. **Add tests array** to the plugin definition
3. **Detect the correct export** from test.ts (could be default export or named export)
4. **Preserve all existing functionality**

### EXAMPLES:

**If test.ts has default export:**
\`\`\`typescript
import testSuite from "./test/test.js";

const myPlugin: Plugin = {
  name: "plugin-name",
  // ... existing fields
  tests: [testSuite],
};
\`\`\`

**If test.ts has named export 'test':**
\`\`\`typescript
import { test as testSuite } from "./test/test.js";

const myPlugin: Plugin = {
  name: "plugin-name", 
  // ... existing fields
  tests: [testSuite],
};
\`\`\`

### 🚨 CRITICAL RULES:
- Use .js extension in import (not .ts)
- Add import after existing imports
- Add tests array to plugin object
- Don't break existing functionality
- Handle any plugin naming pattern (alloraPlugin, newsPlugin, etc.)

Fix the src/index.ts file to properly include the test suite!`;

      // Use Claude to fix the test integration
      await claudeIntegration.runClaudeWithPrompt(testIntegrationPrompt);
      
      logger.info('✅ Test suite integration completed via Claude');
      context.changedFiles.add('src/index.ts');

    } catch (error) {
      logger.error('❌ Failed to include test suites in index.ts:', error);
      // Don't throw - this is not critical for migration success
    }
  }

  /**
   * Clean up incorrect test files while preserving correct ElizaOS V2 patterns
   */
  async cleanupTestFiles(): Promise<void> {
    logger.info('\n🧹 Cleaning up extra test files...');
    
    // Only delete WRONG test file patterns, not the correct ones
    const wrongTestFiles = await globby([
      'src/test/*.test.ts', // Wrong: ElizaOS V2 doesn't use .test.ts suffix
      'src/test/*.spec.ts', // Wrong: ElizaOS V2 doesn't use .spec.ts suffix
      '__tests__/**/*',     // V1 pattern - should be gone
      'test/**/*.ts',       // V1 pattern - should be gone
    ], {
      cwd: this.repoPath,
    });
    
    // Only delete files that don't match ElizaOS V2 pattern
    for (const testFile of wrongTestFiles) {
      // PRESERVE src/test/test.ts - this is the correct ElizaOS V2 pattern
      if (testFile === 'src/test/test.ts') {
        logger.info(`✅ Preserving correct ElizaOS V2 test file: ${testFile}`);
        continue;
      }
      
      logger.info(`🗑️  Deleting incorrect test file: ${testFile}`);
      await fs.remove(path.join(this.repoPath, testFile));
    }
  }

  /**
   * Ensure directory exists
   */
  static async ensureDir(dirPath: string): Promise<void> {
    await fs.ensureDir(dirPath);
  }

  /**
   * Check if path exists
   */
  static async pathExists(filePath: string): Promise<boolean> {
    return fs.pathExists(filePath);
  }

  /**
   * Read file content
   */
  static async readFile(filePath: string): Promise<string> {
    return fs.readFile(filePath, 'utf-8');
  }

  /**
   * Write file content
   */
  static async writeFile(filePath: string, content: string): Promise<void> {
    await fs.writeFile(filePath, content, 'utf-8');
  }

  /**
   * Copy file
   */
  static async copyFile(src: string, dest: string): Promise<void> {
    await fs.copy(src, dest);
  }

  /**
   * Remove file or directory
   */
  static async remove(filePath: string): Promise<void> {
    await fs.remove(filePath);
  }

  /**
   * Read JSON file
   */
  static async readJson(filePath: string): Promise<unknown> {
    return fs.readJson(filePath);
  }

  /**
   * Write JSON file
   */
  static async writeJson(filePath: string, data: unknown): Promise<void> {
    await fs.writeJson(filePath, data, { spaces: 2 });
  }
} 