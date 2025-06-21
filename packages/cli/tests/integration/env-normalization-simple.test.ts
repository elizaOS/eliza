import { describe, it, expect } from 'vitest';
import {
  detectRuntimeEnvironment,
  getEnvironmentConfig,
  normalizeImportPath,
  isMonorepoContext,
  validateImportExtensions,
} from '../../src/utils/environment-normalization';

describe('Environment Normalization Simple Tests', () => {
  it('should demonstrate complete environment detection and normalization', () => {
    console.log('\n=== Environment Normalization Test Results ===\n');

    // 1. Detect runtime environment
    const runtime = detectRuntimeEnvironment();
    console.log(`Runtime Environment: ${runtime}`);
    expect(['typescript', 'javascript']).toContain(runtime);

    // 2. Get full environment config
    const config = getEnvironmentConfig();
    console.log('\nEnvironment Configuration:');
    console.log(`- TypeScript Support: ${config.isTypeScript}`);
    console.log(`- Monorepo Context: ${config.isMonorepo}`);
    console.log(`- Requires .js Extensions: ${config.requiresJsExtensions}`);
    console.log(`- Can Run TypeScript: ${config.canRunTypeScriptDirectly}`);

    // Validate config consistency
    expect(config.isTypeScript).toBe(runtime === 'typescript');
    if (config.isTypeScript) {
      expect(config.requiresJsExtensions).toBe(false);
      expect(config.canRunTypeScriptDirectly).toBe(true);
    } else {
      expect(config.requiresJsExtensions).toBe(true);
    }

    // 3. Test import path normalization
    console.log('\nImport Path Normalization:');
    const testCases = [
      { path: './utils', description: 'Relative module' },
      { path: '../lib/helper', description: 'Parent directory module' },
      { path: '@elizaos/core', description: 'Package import' },
      { path: './data.json', description: 'JSON file' },
      { path: './script.js', description: 'JS file with extension' },
    ];

    testCases.forEach(({ path, description }) => {
      const normalized = normalizeImportPath(path);
      console.log(`  ${path} → ${normalized} (${description})`);

      // Verify behavior
      if (!path.startsWith('.')) {
        // Package imports should never change
        expect(normalized).toBe(path);
      } else if (path.includes('.')) {
        // Files with extensions should not change
        expect(normalized).toBe(path);
      } else if (config.requiresJsExtensions) {
        // JS environment should add .js
        expect(normalized).toBe(`${path}.js`);
      } else {
        // TS environment should not change
        expect(normalized).toBe(path);
      }
    });

    // 4. Test monorepo detection
    const isMonorepo = isMonorepoContext();
    console.log(`\nMonorepo Context: ${isMonorepo}`);
    expect(typeof isMonorepo).toBe('boolean');

    // 5. Test import validation
    console.log('\nImport Validation:');
    const codeWithoutExtensions = `
      import { something } from './utils';
      import { another } from '../lib/helper';
      import { Plugin } from '@elizaos/core';
    `;

    const issues = validateImportExtensions(codeWithoutExtensions);
    console.log(`  Found ${issues.length} issues`);

    if (config.requiresJsExtensions) {
      expect(issues.length).toBeGreaterThan(0);
      issues.forEach((issue) => console.log(`  - ${issue}`));
    } else {
      expect(issues.length).toBe(0);
    }

    console.log('\n=== Test Summary ===');
    console.log(`✓ Environment detection working correctly`);
    console.log(
      `✓ Import normalization ${config.requiresJsExtensions ? 'adds' : 'skips'} .js extensions`
    );
    console.log(`✓ Running in ${isMonorepo ? 'monorepo' : 'standalone'} context`);
    console.log(`✓ All tests passed!`);
  });
});
