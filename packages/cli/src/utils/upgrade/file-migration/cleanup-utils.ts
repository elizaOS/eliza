/**
 * CLEANUP UTILITIES
 * 
 * Responsibilities:
 * - Post-migration file and folder cleanup
 * - V1 artifact removal
 * - Test file standardization
 * - Comprehensive cleanup patterns
 */

import { logger } from '@elizaos/core';
import * as fs from 'fs-extra';
import * as path from 'node:path';
import { globby } from 'globby';
import type { MigrationContext } from '../types.js';

export class CleanupUtils {
  private context: MigrationContext;

  constructor(context: MigrationContext) {
    this.context = context;
  }

  /**
   * Clean up unnecessary files and folders after migration
   */
  async cleanupAfterMigration(filesToDelete: Set<string>, foldersToDelete: Set<string>): Promise<void> {
    logger.info('\n🧹 Cleaning up after migration...');

    // Delete marked files
    for (const file of filesToDelete) {
      const filePath = path.join(this.context.repoPath, file);
      if (await fs.pathExists(filePath)) {
        logger.info(`🗑️  Deleting file: ${file}`);
        await fs.remove(filePath);
      }
    }

    // Delete marked folders
    for (const folder of foldersToDelete) {
      const folderPath = path.join(this.context.repoPath, folder);
      if (await fs.pathExists(folderPath)) {
        logger.info(`🗑️  Deleting folder: ${folder}`);
        await fs.remove(folderPath);
      }
    }

    // Clean up WRONG test files but preserve ElizaOS V2 pattern
    await this.cleanupTestFiles();

    // Check for nested action directories to clean up if actions were centralized
    await this.cleanupNestedActionDirectories();

    // Clean up additional V1 patterns from comprehensive analysis
    await this.cleanupAdditionalV1Patterns();

    // Clean up V1 lib and vendor directories
    await this.cleanupV1Directories();
  }

  /**
   * Clean up incorrect test files while preserving V2 patterns
   */
  private async cleanupTestFiles(): Promise<void> {
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
  }

  /**
   * Clean up nested action directories if actions were centralized
   */
  private async cleanupNestedActionDirectories(): Promise<void> {
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
  }

  /**
   * Clean up additional V1 patterns from comprehensive analysis
   */
  private async cleanupAdditionalV1Patterns(): Promise<void> {
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
  }

  /**
   * Clean up V1 lib and vendor directories
   */
  private async cleanupV1Directories(): Promise<void> {
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
   * Check if a file should be preserved based on V2 patterns
   */
  shouldPreserveFile(filePath: string): boolean {
    // Preserve correct ElizaOS V2 test files
    if (filePath === 'src/test/test.ts' || filePath === 'src/test/utils.ts') {
      return true;
    }

    // Preserve core V2 files
    const v2CoreFiles = [
      'src/index.ts',
      'src/config.ts',
      'src/actions.ts',
      'src/providers.ts',
      'src/service.ts',
      'package.json',
      'tsconfig.json',
      'tsconfig.build.json',
      'tsup.config.ts',
      'README.md',
      'bun.lockb',
    ];

    return v2CoreFiles.includes(filePath);
  }

  /**
   * Get cleanup statistics
   */
  getCleanupStats(): { filesToDelete: number; foldersToDelete: number } {
    return {
      filesToDelete: 0, // Would be passed from caller
      foldersToDelete: 0, // Would be passed from caller
    };
  }

  /**
   * Verify cleanup completion
   */
  async verifyCleanup(): Promise<{ success: boolean; remainingV1Files: string[] }> {
    const v1Patterns = [
      'vitest.config.*',
      'jest.config.*',
      '.eslintrc.*',
      '.prettierrc*',
      'environment.ts',
      '__tests__/**',
      'src/tests/**',
    ];

    const remainingV1Files: string[] = [];

    for (const pattern of v1Patterns) {
      const files = await globby([pattern], {
        cwd: this.context.repoPath,
        ignore: ['node_modules/**'],
      });
      remainingV1Files.push(...files);
    }

    return {
      success: remainingV1Files.length === 0,
      remainingV1Files,
    };
  }
} 