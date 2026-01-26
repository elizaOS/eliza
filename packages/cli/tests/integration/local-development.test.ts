import { describe, it, expect } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Integration tests for local development scenarios
 *
 * These tests verify the development scenarios work correctly:
 *
 * 1. Monorepo Development: Running bun run dev/start from monorepo root
 *    - Validates workspace:* references in template packages
 *    - Ensures bun can resolve dependencies from monorepo root
 *
 * 2. Linked CLI Development: Running elizaos commands from packages/project-starter
 *    - Validates that project-starter has correct structure
 *    - Ensures workspace:* references work within monorepo
 *
 * 3. Bundled Templates: Ensures bundled templates use 'latest' for npm installability
 *
 * 4. Version Consistency: Verifies copy-templates build script converts workspace:* to latest
 */

const MONOREPO_ROOT = join(__dirname, '../../../..');
const CLI_PACKAGE = join(MONOREPO_ROOT, 'packages/cli');
const PROJECT_STARTER = join(MONOREPO_ROOT, 'packages/project-starter');
const PLUGIN_STARTER = join(MONOREPO_ROOT, 'packages/plugin-starter');

describe('Local Development Scenarios', () => {
  describe('Scenario 1: Monorepo Development (bun run dev/start from root)', () => {
    it('project-starter package.json uses workspace:* references', () => {
      const packageJsonPath = join(PROJECT_STARTER, 'package.json');
      expect(existsSync(packageJsonPath)).toBe(true);

      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));

      // Check that @elizaos dependencies use workspace:*
      const elizaosDeps = Object.entries(packageJson.dependencies || {}).filter(([name]) =>
        name.startsWith('@elizaos/')
      );

      expect(elizaosDeps.length).toBeGreaterThan(0);

      for (const [, version] of elizaosDeps) {
        expect(version).toBe('workspace:*');
      }
    });

    it('plugin-starter package.json uses workspace:* references', () => {
      const packageJsonPath = join(PLUGIN_STARTER, 'package.json');
      expect(existsSync(packageJsonPath)).toBe(true);

      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));

      const elizaosDeps = Object.entries(packageJson.dependencies || {}).filter(([name]) =>
        name.startsWith('@elizaos/')
      );

      for (const [, version] of elizaosDeps) {
        expect(version).toBe('workspace:*');
      }

      const elizaosDevDeps = Object.entries(packageJson.devDependencies || {}).filter(([name]) =>
        name.startsWith('@elizaos/')
      );

      for (const [, version] of elizaosDevDeps) {
        expect(version).toBe('workspace:*');
      }
    });

    it('monorepo root package.json has workspaces configured', () => {
      const packageJsonPath = join(MONOREPO_ROOT, 'package.json');
      expect(existsSync(packageJsonPath)).toBe(true);

      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));

      expect(packageJson.workspaces).toBeDefined();
      expect(Array.isArray(packageJson.workspaces)).toBe(true);
      expect(packageJson.workspaces).toContain('packages/*');
    });

    it('core packages exist and have proper structure', () => {
      const corePackages = ['core', 'cli', 'server', 'client', 'plugin-bootstrap', 'plugin-sql'];

      for (const pkg of corePackages) {
        const pkgPath = join(MONOREPO_ROOT, 'packages', pkg);
        const pkgJsonPath = join(pkgPath, 'package.json');

        expect(existsSync(pkgPath)).toBe(true);
        expect(existsSync(pkgJsonPath)).toBe(true);

        const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
        expect(pkgJson.name).toBe(`@elizaos/${pkg}`);
      }
    });
  });

  describe('Scenario 2: Linked CLI Development (elizaos from packages/project-starter)', () => {
    it('project-starter has required dependencies', () => {
      const packageJsonPath = join(PROJECT_STARTER, 'package.json');
      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));

      const requiredDeps = ['@elizaos/core', '@elizaos/cli', '@elizaos/plugin-bootstrap'];

      for (const dep of requiredDeps) {
        expect(packageJson.dependencies[dep]).toBeDefined();
      }
    });

    it('project-starter has elizaos commands in scripts', () => {
      const packageJsonPath = join(PROJECT_STARTER, 'package.json');
      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));

      // Should have start and dev scripts that use elizaos
      expect(packageJson.scripts.start).toContain('elizaos');
      expect(packageJson.scripts.dev).toContain('elizaos');
    });

    it('project-starter has proper source structure', () => {
      const srcDir = join(PROJECT_STARTER, 'src');
      expect(existsSync(srcDir)).toBe(true);

      // Check for key source files
      const indexPath = join(srcDir, 'index.ts');
      expect(existsSync(indexPath)).toBe(true);
    });
  });

  describe('Scenario 3: Bundled Templates', () => {
    it('bundled CLI templates use "latest" versions (not workspace:*)', () => {
      const bundledTemplateDir = join(CLI_PACKAGE, 'dist/templates/project-starter');

      // Skip if dist doesn't exist (not built yet)
      if (!existsSync(bundledTemplateDir)) {
        console.warn('Skipping: CLI not built yet. Run `bun run build:cli` first.');
        return;
      }

      const packageJsonPath = join(bundledTemplateDir, 'package.json');
      expect(existsSync(packageJsonPath)).toBe(true);

      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));

      // Check dependencies
      const elizaosDeps = Object.entries(packageJson.dependencies || {}).filter(([name]) =>
        name.startsWith('@elizaos/')
      );

      for (const [, version] of elizaosDeps) {
        expect(version).toBe('latest');
        expect(version).not.toBe('workspace:*');
        expect(version).not.toMatch(/^\d+\.\d+\.\d+/);
      }
    });

    it('bundled plugin-starter template uses "latest" versions', () => {
      const bundledTemplateDir = join(CLI_PACKAGE, 'dist/templates/plugin-starter');

      if (!existsSync(bundledTemplateDir)) {
        console.warn('Skipping: CLI not built yet. Run `bun run build:cli` first.');
        return;
      }

      const packageJsonPath = join(bundledTemplateDir, 'package.json');
      expect(existsSync(packageJsonPath)).toBe(true);

      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));

      const allDeps = {
        ...packageJson.dependencies,
        ...packageJson.devDependencies,
      };

      const elizaosDeps = Object.entries(allDeps).filter(([name]) => name.startsWith('@elizaos/'));

      for (const [, version] of elizaosDeps) {
        expect(version).toBe('latest');
      }
    });
  });

  describe('Version Consistency', () => {
    it('source templates use workspace:* and bundled templates use latest', () => {
      const sourcePackageJson = JSON.parse(
        readFileSync(join(PROJECT_STARTER, 'package.json'), 'utf8')
      );

      for (const [name, version] of Object.entries(sourcePackageJson.dependencies || {})) {
        if (name.startsWith('@elizaos/')) {
          expect(version).toBe('workspace:*');
        }
      }

      const bundledTemplateDir = join(CLI_PACKAGE, 'dist/templates/project-starter');

      if (existsSync(bundledTemplateDir)) {
        const bundledPackageJson = JSON.parse(
          readFileSync(join(bundledTemplateDir, 'package.json'), 'utf8')
        );

        for (const [name, version] of Object.entries(bundledPackageJson.dependencies || {})) {
          if (name.startsWith('@elizaos/')) {
            expect(version).toBe('latest');
          }
        }
      }
    });

    it('copy-templates build script converts workspace:* to latest', () => {
      const copyTemplatesPath = join(CLI_PACKAGE, 'src/scripts/copy-templates.ts');
      expect(existsSync(copyTemplatesPath)).toBe(true);

      const content = readFileSync(copyTemplatesPath, 'utf8');

      // Should have updatePackageJson function that converts versions
      expect(content).toContain('updatePackageJson');
      expect(content).toContain('workspace:*');
      expect(content).toContain("'latest'");
    });

    it('runtime copy-template normalizes to latest', () => {
      const copyTemplatePath = join(CLI_PACKAGE, 'src/utils/copy-template.ts');
      expect(existsSync(copyTemplatePath)).toBe(true);

      const content = readFileSync(copyTemplatePath, 'utf8');

      // Should normalize @elizaos deps to latest
      expect(content).toContain("'latest'");
      expect(content).toContain('normalizeElizaDeps');
    });
  });
});
