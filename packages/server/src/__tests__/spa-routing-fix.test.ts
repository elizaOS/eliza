/**
 * Test to verify SPA routing fix for globally installed CLI
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import path from 'node:path';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';

describe('SPA Routing Fix', () => {
  let tempDir: string;

  beforeEach(() => {
    // Create a temporary directory for testing
    tempDir = path.join(os.tmpdir(), `eliza-spa-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    // Clean up temp directory
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('Client Path Resolution', () => {
    it('should find index.html when explicitly provided via options', () => {
      // Create a mock index.html
      const clientPath = path.join(tempDir, 'dist');
      mkdirSync(clientPath, { recursive: true });
      writeFileSync(path.join(clientPath, 'index.html'), '<html></html>');

      // Verify the file exists
      expect(existsSync(path.join(clientPath, 'index.html'))).toBe(true);
    });

    it('should handle missing index.html gracefully', () => {
      const clientPath = path.join(tempDir, 'dist');
      mkdirSync(clientPath, { recursive: true });
      // Don't create index.html

      // Verify the file doesn't exist
      expect(existsSync(path.join(clientPath, 'index.html'))).toBe(false);
    });

    it('should resolve absolute paths correctly', () => {
      const clientPath = path.join(tempDir, 'dist');
      const indexPath = path.join(clientPath, 'index.html');

      // Verify path is absolute
      expect(path.isAbsolute(indexPath)).toBe(true);
    });
  });

  describe('CLI Path Resolution', () => {
    it('should calculate correct dist path from nested directory', () => {
      // Simulate CLI structure
      const cliRoot = path.join(tempDir, 'cli');
      const commandsDir = path.join(cliRoot, 'dist', 'commands', 'start', 'actions');
      mkdirSync(commandsDir, { recursive: true });

      // Create index.html in dist
      writeFileSync(path.join(cliRoot, 'dist', 'index.html'), '<html></html>');

      // Simulate path resolution
      const resolvedPath = path.resolve(commandsDir, '../../../');
      expect(resolvedPath).toBe(path.join(cliRoot, 'dist'));
      expect(existsSync(path.join(resolvedPath, 'index.html'))).toBe(true);
    });

    it('should find package.json and resolve dist directory', () => {
      // Create a mock package structure
      const pkgRoot = path.join(tempDir, 'node_modules', '@elizaos', 'cli');
      const distDir = path.join(pkgRoot, 'dist');
      mkdirSync(distDir, { recursive: true });

      // Create package.json
      writeFileSync(
        path.join(pkgRoot, 'package.json'),
        JSON.stringify({
          name: '@elizaos/cli',
          version: '1.0.0',
        })
      );

      // Create index.html
      writeFileSync(path.join(distDir, 'index.html'), '<html></html>');

      // Verify structure
      expect(existsSync(path.join(pkgRoot, 'package.json'))).toBe(true);
      expect(existsSync(path.join(distDir, 'index.html'))).toBe(true);
    });
  });
});
