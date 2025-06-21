/**
 * CORE FILE-BY-FILE MIGRATOR
 * 
 * Responsibilities:
 * - Main orchestration of file migration
 * - File discovery and processing coordination
 * - State management (processed files, deletions)
 * - Integration with Claude SDK adapter
 */

import { logger } from '@elizaos/core';
import * as fs from 'fs-extra';
import * as path from 'node:path';
import { globby } from 'globby';
import type { MigrationContext, StepResult } from '../types.js';
import { EnhancedClaudeSDKAdapter } from '../claude-sdk/index.js';
import { FileHandlers } from './file-handlers.js';
import { CleanupUtils } from './cleanup-utils.js';

/**
 * File-by-file migrator that processes each file completely before moving to the next
 */
export class FileByFileMigrator {
  private context: MigrationContext;
  private processedFiles: Set<string> = new Set();
  private filesToDelete: Set<string> = new Set();
  private foldersToDelete: Set<string> = new Set();
  private claudeSDKAdapter: EnhancedClaudeSDKAdapter;
  private fileHandlers: FileHandlers;
  private cleanupUtils: CleanupUtils;

  constructor(context: MigrationContext) {
    this.context = context;
    this.claudeSDKAdapter = new EnhancedClaudeSDKAdapter({
      maxRetries: 3
    });
    this.fileHandlers = new FileHandlers(this.context, this.claudeSDKAdapter);
    this.cleanupUtils = new CleanupUtils(this.context);
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
      await this.fileHandlers.migrateServiceFile(filePath, content);
    } else if (filePath.includes('action') || filePath.includes('Action')) {
      await this.fileHandlers.migrateActionFile(filePath, content);
    } else if (filePath.includes('provider') || filePath.includes('Provider')) {
      await this.fileHandlers.migrateProviderFile(filePath, content);
    } else if (filePath === 'src/index.ts') {
      await this.fileHandlers.migrateIndexFile(filePath, content);
    } else if (filePath.includes('config')) {
      await this.fileHandlers.migrateConfigFile(filePath, content);
    } else {
      // Generic migration for other files
      await this.fileHandlers.migrateGenericFile(filePath, content);
    }

    this.context.changedFiles.add(filePath);
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
    await this.cleanupUtils.cleanupAfterMigration(this.filesToDelete, this.foldersToDelete);
  }

  /**
   * Get processed files for reporting
   */
  getProcessedFiles(): Set<string> {
    return this.processedFiles;
  }

  /**
   * Get files marked for deletion
   */
  getFilesToDelete(): Set<string> {
    return this.filesToDelete;
  }

  /**
   * Get folders marked for deletion
   */
  getFoldersToDelete(): Set<string> {
    return this.foldersToDelete;
  }
} 