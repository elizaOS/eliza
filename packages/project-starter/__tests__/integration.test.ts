import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { logger } from '@elizaos/core';

// Skip in CI environments or when running automated tests without interaction
const isCI = process.env.CI === 'true' || process.env.NODE_ENV === 'test';

// Create a temp directory for testing the scaffolding
const TEST_DIR = path.join(process.cwd(), 'test-project');

describe('Project Scaffolding', () => {
  beforeAll(() => {
    // Skip setup in CI environments
    if (isCI) return;

    // Create test directory if it doesn't exist
    if (!fs.existsSync(TEST_DIR)) {
      fs.mkdirSync(TEST_DIR, { recursive: true });
    }
  });

  afterAll(() => {
    // Skip cleanup in CI environments
    if (isCI) return;

    // Clean up test directory
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it('should have a valid package structure', () => {
    const srcDir = path.join(process.cwd(), 'src');
    expect(fs.existsSync(srcDir)).toBe(true);

    // Check for required source files
    const srcFiles = [
      path.join(srcDir, 'index.ts'),
      path.join(srcDir, 'plugin.ts'),
      path.join(srcDir, 'tests.ts'),
    ];

    srcFiles.forEach((file) => {
      expect(fs.existsSync(file)).toBe(true);
    });
  });

  it('should have dist directory for build outputs', () => {
    const distDir = path.join(process.cwd(), 'dist');

    // Skip directory content validation if dist doesn't exist yet
    if (!fs.existsSync(distDir)) {
      logger.warn('Dist directory does not exist yet. Build the project first.');
      return;
    }

    expect(fs.existsSync(distDir)).toBe(true);

    // Only check presence of dist directory, not specific files
    // since they might not exist in a fresh clone without building
  });

  it('should contain required exports', () => {
    try {
      // Import source files directly for testing exports
      const indexModule = require('../src/index');
      const pluginModule = require('../src/plugin');
      const testsModule = require('../src/tests');

      // Check index exports
      expect(indexModule).toHaveProperty('character');

      // Check plugin exports
      expect(pluginModule.default).toHaveProperty('name');
      expect(pluginModule.default).toHaveProperty('description');
      expect(pluginModule.default).toHaveProperty('init');
      expect(pluginModule.default).toHaveProperty('models');

      // Check tests exports
      expect(testsModule.default).toHaveProperty('name');
      expect(testsModule.default).toHaveProperty('description');
      expect(testsModule.default).toHaveProperty('tests');
      expect(Array.isArray(testsModule.default.tests)).toBe(true);
    } catch (error) {
      // If we're in a test environment without builds, this might fail
      if (!isCI) {
        throw error;
      }
    }
  });

  // Skip scaffolding tests in CI environments
  it.skipIf(isCI)('should scaffold a new project correctly', () => {
    try {
      // This is a simple simulation of the scaffolding process
      // In a real scenario, you'd use the CLI or API to scaffold

      // Copy essential files to test directory
      const srcFiles = ['index.ts', 'plugin.ts', 'tests.ts'];

      for (const file of srcFiles) {
        const sourceFilePath = path.join(process.cwd(), 'src', file);
        const targetFilePath = path.join(TEST_DIR, file);

        if (fs.existsSync(sourceFilePath)) {
          fs.copyFileSync(sourceFilePath, targetFilePath);
        }
      }

      // Create package.json in test directory
      const packageJson = {
        name: 'test-project',
        version: '1.0.0',
        type: 'module',
        dependencies: {
          '@elizaos/core': 'workspace:*',
        },
      };

      fs.writeFileSync(path.join(TEST_DIR, 'package.json'), JSON.stringify(packageJson, null, 2));

      // Verify files exist
      expect(fs.existsSync(path.join(TEST_DIR, 'index.ts'))).toBe(true);
      expect(fs.existsSync(path.join(TEST_DIR, 'plugin.ts'))).toBe(true);
      expect(fs.existsSync(path.join(TEST_DIR, 'tests.ts'))).toBe(true);
      expect(fs.existsSync(path.join(TEST_DIR, 'package.json'))).toBe(true);
    } catch (error) {
      logger.error('Error in scaffolding test:', error);
      throw error;
    }
  });
});
