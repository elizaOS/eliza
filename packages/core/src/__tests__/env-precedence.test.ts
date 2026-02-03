/**
 * Tests for .env file precedence functionality
 *
 * These tests verify that:
 * 1. Closest .env file values take precedence over farther ones
 * 2. Multiple .env files are properly discovered
 * 3. Override behavior works correctly
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { findAllEnvFiles, loadEnvFile, loadEnvFilesWithPrecedence } from '../utils/environment';

describe('Environment File Precedence', () => {
  let tempDir: string;
  const savedEnv: Record<string, string | undefined> = {};

  // Save env vars that tests might modify
  const envVarsToSave = [
    'TEST_VAR',
    'PARENT_VAR',
    'ROOT_VAR',
    'OVERRIDE_VAR',
    'PROJECT_ONLY',
    'MONOREPO_ONLY',
  ];

  beforeEach(() => {
    // Create a temp directory for test fixtures
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-precedence-test-'));

    // Save current env values
    for (const key of envVarsToSave) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    // Clean up temp directory
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }

    // Restore env values
    for (const key of envVarsToSave) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key];
      } else {
        delete process.env[key];
      }
    }
  });

  describe('findAllEnvFiles', () => {
    it('should find .env file in current directory', () => {
      const envPath = path.join(tempDir, '.env');
      fs.writeFileSync(envPath, 'TEST=value');

      const files = findAllEnvFiles(tempDir);

      expect(files).toHaveLength(1);
      expect(files[0]).toBe(envPath);
    });

    it('should find .env files in parent directories', () => {
      // Create nested structure: tempDir/parent/child
      const parentDir = path.join(tempDir, 'parent');
      const childDir = path.join(parentDir, 'child');
      fs.mkdirSync(childDir, { recursive: true });

      // Create .env in root and parent
      fs.writeFileSync(path.join(tempDir, '.env'), 'ROOT=value');
      fs.writeFileSync(path.join(parentDir, '.env'), 'PARENT=value');

      const files = findAllEnvFiles(childDir);

      // Should find both, closest first
      expect(files).toHaveLength(2);
      expect(files[0]).toBe(path.join(parentDir, '.env'));
      expect(files[1]).toBe(path.join(tempDir, '.env'));
    });

    it('should stop at boundary directory', () => {
      // Create structure: tempDir/monorepo/packages/project
      const monorepoRoot = path.join(tempDir, 'monorepo');
      const packagesDir = path.join(monorepoRoot, 'packages');
      const projectDir = path.join(packagesDir, 'project');
      fs.mkdirSync(projectDir, { recursive: true });

      // Create .env files
      fs.writeFileSync(path.join(tempDir, '.env'), 'OUTSIDE=value'); // Outside boundary
      fs.writeFileSync(path.join(monorepoRoot, '.env'), 'MONOREPO=value');
      fs.writeFileSync(path.join(projectDir, '.env'), 'PROJECT=value');

      // Search from project with monorepo as boundary
      const files = findAllEnvFiles(projectDir, monorepoRoot);

      // Should only find files within boundary
      expect(files).toHaveLength(2);
      expect(files[0]).toBe(path.join(projectDir, '.env'));
      expect(files[1]).toBe(path.join(monorepoRoot, '.env'));
      // Should NOT include the one outside boundary
      expect(files).not.toContain(path.join(tempDir, '.env'));
    });

    it('should return empty array when no .env files found', () => {
      const emptyDir = path.join(tempDir, 'empty');
      fs.mkdirSync(emptyDir);

      const files = findAllEnvFiles(emptyDir, tempDir);

      expect(files).toHaveLength(0);
    });
  });

  describe('loadEnvFile with override option', () => {
    it('should not override existing vars by default', () => {
      process.env.TEST_VAR = 'existing-value';

      const envPath = path.join(tempDir, '.env');
      fs.writeFileSync(envPath, 'TEST_VAR=new-value');

      loadEnvFile(envPath);

      // Original value should be preserved
      expect(process.env.TEST_VAR).toBe('existing-value');
    });

    it('should override existing vars when override is true', () => {
      process.env.TEST_VAR = 'existing-value';

      const envPath = path.join(tempDir, '.env');
      fs.writeFileSync(envPath, 'TEST_VAR=new-value');

      loadEnvFile(envPath, { override: true });

      // New value should override
      expect(process.env.TEST_VAR).toBe('new-value');
    });
  });

  describe('loadEnvFilesWithPrecedence', () => {
    it('should load files with closest taking precedence', () => {
      // Create nested structure
      const parentDir = path.join(tempDir, 'parent');
      const childDir = path.join(parentDir, 'child');
      fs.mkdirSync(childDir, { recursive: true });

      // Root has one value, child has a different value for same var
      fs.writeFileSync(path.join(tempDir, '.env'), 'OVERRIDE_VAR=root-value\nROOT_VAR=root-only');
      fs.writeFileSync(path.join(childDir, '.env'), 'OVERRIDE_VAR=child-value');

      const loaded = loadEnvFilesWithPrecedence(childDir, { boundaryDir: tempDir });

      // Should load both files
      expect(loaded).toHaveLength(2);

      // Child (closest) value should win for override var
      expect(process.env.OVERRIDE_VAR).toBe('child-value');

      // Root-only var should still be loaded
      expect(process.env.ROOT_VAR).toBe('root-only');
    });

    it('should respect boundary directory', () => {
      // Create structure: outside/monorepo/project
      const outsideDir = tempDir;
      const monorepoDir = path.join(tempDir, 'monorepo');
      const projectDir = path.join(monorepoDir, 'project');
      fs.mkdirSync(projectDir, { recursive: true });

      // Create .env files
      fs.writeFileSync(path.join(outsideDir, '.env'), 'OUTSIDE_VAR=outside');
      fs.writeFileSync(path.join(monorepoDir, '.env'), 'MONOREPO_ONLY=monorepo');
      fs.writeFileSync(path.join(projectDir, '.env'), 'PROJECT_ONLY=project');

      const loaded = loadEnvFilesWithPrecedence(projectDir, { boundaryDir: monorepoDir });

      // Should only load files within boundary
      expect(loaded).toHaveLength(2);
      expect(process.env.PROJECT_ONLY).toBe('project');
      expect(process.env.MONOREPO_ONLY).toBe('monorepo');
      // Should NOT load outside boundary
      expect(process.env.OUTSIDE_VAR).toBeUndefined();
    });

    it('should handle single .env file', () => {
      const envPath = path.join(tempDir, '.env');
      fs.writeFileSync(envPath, 'TEST_VAR=single-file');

      const loaded = loadEnvFilesWithPrecedence(tempDir);

      expect(loaded).toHaveLength(1);
      expect(process.env.TEST_VAR).toBe('single-file');
    });

    it('should handle no .env files', () => {
      const emptyDir = path.join(tempDir, 'empty');
      fs.mkdirSync(emptyDir);

      const loaded = loadEnvFilesWithPrecedence(emptyDir, { boundaryDir: tempDir });

      expect(loaded).toHaveLength(0);
    });
  });

  describe('Real-world Scenario: Monorepo Structure', () => {
    it('should handle typical monorepo .env hierarchy', () => {
      // Create typical monorepo structure
      const monorepoRoot = path.join(tempDir, 'eliza');
      const packagesDir = path.join(monorepoRoot, 'packages');
      const projectStarter = path.join(packagesDir, 'project-starter');
      fs.mkdirSync(projectStarter, { recursive: true });

      // Monorepo root .env (shared defaults)
      fs.writeFileSync(
        path.join(monorepoRoot, '.env'),
        'LOG_LEVEL=info\nPOSTGRES_URL=postgresql://localhost/eliza\nSHARED_VAR=from-root'
      );

      // Project-specific .env (overrides)
      fs.writeFileSync(
        path.join(projectStarter, '.env'),
        'OPENROUTER_API_KEY=project-specific-key\nLOG_LEVEL=debug\nSHARED_VAR=from-project'
      );

      // Load with precedence from project directory
      const loaded = loadEnvFilesWithPrecedence(projectStarter, { boundaryDir: monorepoRoot });

      expect(loaded).toHaveLength(2);

      // Project-specific values should win
      expect(process.env.OPENROUTER_API_KEY).toBe('project-specific-key');
      expect(process.env.LOG_LEVEL).toBe('debug'); // Project override
      expect(process.env.SHARED_VAR).toBe('from-project'); // Project override

      // Shared defaults from root should be loaded
      expect(process.env.POSTGRES_URL).toBe('postgresql://localhost/eliza');
    });
  });
});
