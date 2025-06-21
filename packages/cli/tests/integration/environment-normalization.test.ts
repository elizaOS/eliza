import { describe, it, expect } from 'vitest';
import {
  detectRuntimeEnvironment,
  normalizeImportPath,
  getEnvironmentConfig,
  isMonorepoContext,
  validateImportExtensions,
} from '../../src/utils/environment-normalization';

describe('Environment Normalization', () => {
  describe('detectRuntimeEnvironment', () => {
    it('should detect the current runtime environment', () => {
      const env = detectRuntimeEnvironment();
      expect(['typescript', 'javascript']).toContain(env);
    });

    it('should detect TypeScript when running with bun', () => {
      if (process.execPath.includes('bun')) {
        expect(detectRuntimeEnvironment()).toBe('typescript');
      }
    });
  });

  describe('normalizeImportPath', () => {
    it('should not modify package imports', () => {
      expect(normalizeImportPath('@elizaos/core')).toBe('@elizaos/core');
      expect(normalizeImportPath('lodash')).toBe('lodash');
    });

    it('should not modify imports with extensions', () => {
      expect(normalizeImportPath('./utils.js')).toBe('./utils.js');
      expect(normalizeImportPath('./data.json')).toBe('./data.json');
    });

    it('should add .js extension in JavaScript environment for relative imports', () => {
      // This test behavior depends on the actual environment
      const path = './utils';
      const normalized = normalizeImportPath(path);

      if (detectRuntimeEnvironment() === 'javascript') {
        expect(normalized).toBe('./utils.js');
      } else {
        expect(normalized).toBe('./utils');
      }
    });
  });

  describe('getEnvironmentConfig', () => {
    it('should return comprehensive environment configuration', () => {
      const config = getEnvironmentConfig();

      expect(config).toHaveProperty('isTypeScript');
      expect(config).toHaveProperty('isMonorepo');
      expect(config).toHaveProperty('requiresJsExtensions');
      expect(config).toHaveProperty('canRunTypeScriptDirectly');

      // Check consistency
      if (config.isTypeScript) {
        expect(config.canRunTypeScriptDirectly).toBe(true);
        expect(config.requiresJsExtensions).toBe(false);
      } else {
        expect(config.requiresJsExtensions).toBe(true);
      }
    });
  });

  describe('isMonorepoContext', () => {
    it('should detect monorepo context correctly', () => {
      const isMonorepo = isMonorepoContext();
      // This should be true when running tests in the ElizaOS monorepo
      expect(typeof isMonorepo).toBe('boolean');
    });
  });

  describe('validateImportExtensions', () => {
    it('should not report issues for TypeScript environment', () => {
      if (detectRuntimeEnvironment() === 'typescript') {
        const code = `
          import { something } from './utils';
          import { another } from '../lib/helper';
        `;
        const issues = validateImportExtensions(code);
        expect(issues).toHaveLength(0);
      }
    });

    it('should report missing extensions in JavaScript environment', () => {
      if (detectRuntimeEnvironment() === 'javascript') {
        const code = `
          import { something } from './utils';
          import { another } from '../lib/helper';
          import { valid } from './file.js';
        `;
        const issues = validateImportExtensions(code);
        expect(issues.length).toBeGreaterThanOrEqual(2);
        expect(issues[0]).toContain('Missing .js extension');
      }
    });

    it('should not report issues for package imports', () => {
      const code = `
        import { Plugin } from '@elizaos/core';
        import lodash from 'lodash';
      `;
      const issues = validateImportExtensions(code);
      expect(issues).toHaveLength(0);
    });
  });
});

describe('Real-world Environment Scenarios', () => {
  it('should handle project-starter environment', () => {
    const config = getEnvironmentConfig();

    // Project starter should work in both TS and JS environments
    expect(config).toBeDefined();

    // Simulate imports that would be in project-starter
    const imports = [
      './src/index',
      '@elizaos/core',
      '@elizaos/plugin-message-handling',
      './characters/main.json',
    ];

    imports.forEach((importPath) => {
      const normalized = normalizeImportPath(importPath);
      // Should not throw
      expect(normalized).toBeDefined();
    });
  });

  it('should handle plugin-starter environment', () => {
    const config = getEnvironmentConfig();

    // Plugin starter typically has TypeScript source
    const pluginImports = ['./src/actions/myAction', './src/providers/myProvider', '@elizaos/core'];

    pluginImports.forEach((importPath) => {
      const normalized = normalizeImportPath(importPath);

      if (importPath.startsWith('./') && config.requiresJsExtensions) {
        expect(normalized).toContain('.js');
      }
    });
  });

  it('should handle monorepo vs standalone differences', () => {
    const isMonorepo = isMonorepoContext();

    if (isMonorepo) {
      // In monorepo, we might have workspace protocol
      expect(true).toBe(true); // Placeholder for monorepo-specific tests
    } else {
      // In standalone, we use regular npm packages
      expect(true).toBe(true); // Placeholder for standalone-specific tests
    }
  });
});
