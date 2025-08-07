import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '@elizaos/core';

// Helper function to check if a file exists
function fileExists(filePath: string): boolean {
  return fs.existsSync(filePath);
}

// Helper function to check if a directory exists
function directoryExists(dirPath: string): boolean {
  return fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory();
}

describe('Project Structure Validation', () => {
  const rootDir = path.resolve(__dirname, '../..');

  describe('Directory Structure', () => {
    it('should have the expected directory structure', () => {
      expect(directoryExists(path.join(rootDir, 'src'))).toBe(true);
      expect(directoryExists(path.join(rootDir, 'src', '__tests__'))).toBe(true);
    });

    it('should have a dist directory after building', () => {
      // This test assumes the build has been run before testing
      expect(directoryExists(path.join(rootDir, 'dist'))).toBe(true);
    });
  });

  describe('Source Files', () => {
    it('should contain the required source files', () => {
      expect(fileExists(path.join(rootDir, 'src', 'index.ts'))).toBe(true);
      expect(fileExists(path.join(rootDir, 'src', 'plugin.ts'))).toBe(true);
    });

    it('should have properly structured main files', () => {
      // Check index.ts contains character definition
      const indexContent = fs.readFileSync(path.join(rootDir, 'src', 'index.ts'), 'utf8');
      expect(indexContent).toContain('character');
      expect(indexContent).toContain('plugin');

      // Check plugin.ts contains plugin definition
      const pluginContent = fs.readFileSync(path.join(rootDir, 'src', 'plugin.ts'), 'utf8');
      expect(pluginContent).toContain('export default');
      expect(pluginContent).toContain('actions');
    });
  });

  describe('Configuration Files', () => {
    it('should have the required configuration files', () => {
      expect(fileExists(path.join(rootDir, 'package.json'))).toBe(true);
      expect(fileExists(path.join(rootDir, 'tsconfig.json'))).toBe(true);
      expect(fileExists(path.join(rootDir, 'tsconfig.build.json'))).toBe(true);
      expect(fileExists(path.join(rootDir, 'tsup.config.ts'))).toBe(true);
      expect(fileExists(path.join(rootDir, 'bunfig.toml'))).toBe(true);
    });

    it('should have the correct package.json configuration', () => {
      const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));

      // Check package name exists and is valid
      expect(packageJson.name).toBeTruthy();
      expect(typeof packageJson.name).toBe('string');

      // Check scripts
      expect(packageJson.scripts).toHaveProperty('build');
      expect(packageJson.scripts).toHaveProperty('test');
      expect(packageJson.scripts).toHaveProperty('test:coverage');

      // Check dependencies
      expect(packageJson.dependencies).toHaveProperty('@elizaos/core');

      // Check dev dependencies - adjusted for actual dev dependencies
      expect(packageJson.devDependencies).toBeTruthy();
      // bun test is built-in, no external test framework dependency needed
      expect(packageJson.devDependencies).toHaveProperty('tsup');
    });

    it('should have proper TypeScript configuration', () => {
      const tsConfig = JSON.parse(fs.readFileSync(path.join(rootDir, 'tsconfig.json'), 'utf8'));

      // Check essential compiler options
      expect(tsConfig).toHaveProperty('compilerOptions');
      expect(tsConfig.compilerOptions).toHaveProperty('target');
      expect(tsConfig.compilerOptions).toHaveProperty('module');

      // Check paths inclusion
      expect(tsConfig).toHaveProperty('include');
    });
  });

  describe('Build Output', () => {
    it('should check for expected build output structure', () => {
      // Instead of checking specific files, check that the dist directory exists
      // and contains at least some files
      if (directoryExists(path.join(rootDir, 'dist'))) {
        const files = fs.readdirSync(path.join(rootDir, 'dist'));
        expect(files.length).toBeGreaterThan(0);

        // Check for common output patterns rather than specific files
        const hasJsFiles = files.some((file) => file.endsWith('.js'));
        expect(hasJsFiles).toBe(true);
      } else {
        // Skip test if dist directory doesn't exist yet
        logger.warn('Dist directory not found, skipping build output tests');
      }
    });

    it('should verify the build process can be executed', () => {
      // Check that the build script exists in package.json
      const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
      expect(packageJson.scripts).toHaveProperty('build');

      // Check that tsup.config.ts exists and contains proper configuration
      const tsupConfig = fs.readFileSync(path.join(rootDir, 'tsup.config.ts'), 'utf8');
      expect(tsupConfig).toContain('export default');
      expect(tsupConfig).toContain('entry');
    });
  });

  describe('Documentation', () => {
    it('should have README files', () => {
      expect(fileExists(path.join(rootDir, 'README.md'))).toBe(true);
    });

    it('should have appropriate documentation content', () => {
      const readmeContent = fs.readFileSync(path.join(rootDir, 'README.md'), 'utf8');
      expect(readmeContent).toContain('Project Starter');

      // Testing key sections exist without requiring specific keywords
      expect(readmeContent).toContain('Development');
      expect(readmeContent).toContain('Testing');
    });
  });
});
