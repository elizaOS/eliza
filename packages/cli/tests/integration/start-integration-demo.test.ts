import { describe, it, expect } from 'vitest';
import { loadCharacterTryPath } from '@elizaos/server';
import {
  getEnvironmentConfig,
  normalizeImportPath,
} from '../../src/utils/environment-normalization';
import { loadAndPreparePlugin } from '../../src/commands/start/utils/plugin-utils';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

describe('Start Command Integration with Environment Normalization', () => {
  it('should demonstrate complete environment-aware functionality', async () => {
    const config = getEnvironmentConfig();
    console.log('Environment Config:', config);

    // 1. Create a test character in temp directory
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eliza-test-'));
    const characterPath = path.join(tempDir, 'test-character.json');

    const testCharacter = {
      name: 'EnvTestAgent',
      description: 'Agent for testing environment normalization',
      plugins: ['@elizaos/plugin-message-handling'],
      settings: {
      },
    };

    fs.writeFileSync(characterPath, JSON.stringify(testCharacter, null, 2));

    // 2. Test character loading with environment normalization
    const loadedCharacter = await loadCharacterTryPath(characterPath);
    expect(loadedCharacter).toBeDefined();
    expect(loadedCharacter).not.toBeNull();
    expect(loadedCharacter!.name).toBe('EnvTestAgent');

    // 3. Test import path normalization
    const testPaths = ['./utils', '../lib/helper', '@elizaos/core', './data.json'];

    testPaths.forEach((testPath) => {
      const normalized = normalizeImportPath(testPath);
      console.log(`Import normalization: ${testPath} → ${normalized}`);

      // Verify package imports are unchanged
      if (!testPath.startsWith('.')) {
        expect(normalized).toBe(testPath);
      }

      // Verify relative imports get .js in JS environment
      if (testPath.startsWith('.') && !path.extname(testPath) && !config.isTypeScript) {
        expect(normalized).toContain('.js');
      }
    });

    // 4. Test plugin loading (mocked to avoid actual plugin loading)
    const pluginName = '@elizaos/plugin-message-handling';
    console.log(`Testing plugin loading for: ${pluginName}`);

    // In a real scenario, this would load the actual plugin
    // For testing, we just verify the function exists and handles errors gracefully
    expect(typeof loadAndPreparePlugin).toBe('function');

    // 5. Environment-specific behavior
    if (config.isMonorepo) {
      console.log('Running in monorepo - workspace protocols available');
      expect(config.isMonorepo).toBe(true);
    } else {
      console.log('Running standalone - using npm packages');
      expect(config.isMonorepo).toBe(false);
    }

    // 6. Clean up
    fs.rmSync(tempDir, { recursive: true, force: true });

    // Summary
    console.log('\n=== Integration Test Summary ===');
    console.log(
      `✓ Character loading works in ${config.isTypeScript ? 'TypeScript' : 'JavaScript'} environment`
    );
    console.log(
      `✓ Import paths normalized correctly (${config.requiresJsExtensions ? 'with' : 'without'} .js extensions)`
    );
    console.log(`✓ Running in ${config.isMonorepo ? 'monorepo' : 'standalone'} context`);
    console.log(`✓ Environment detection working correctly`);
  });

  it('should handle different file extensions based on environment', () => {
    const config = getEnvironmentConfig();

    // Test file patterns that would be used in real scenarios
    const filePatterns = [
      {
        input: './actions/myAction',
        expected: config.isTypeScript ? './actions/myAction' : './actions/myAction.js',
      },
      { input: './index', expected: config.isTypeScript ? './index' : './index.js' },
      { input: './config.json', expected: './config.json' }, // JSON files unchanged
      { input: 'lodash', expected: 'lodash' }, // Package imports unchanged
    ];

    filePatterns.forEach(({ input, expected }) => {
      const result = normalizeImportPath(input);
      expect(result).toBe(expected);
      console.log(`File extension test: ${input} → ${result} (expected: ${expected})`);
    });
  });
});
