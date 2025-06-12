import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { detectDirectoryType, isValidForUpdates } from '../../src/utils/directory-detection';

describe('Directory Detection Utility', () => {
  let testTmpDir: string;
  let originalCwd: string;

  beforeAll(() => {
    originalCwd = process.cwd();
  });

  beforeEach(async () => {
    testTmpDir = await mkdtemp(join(tmpdir(), 'eliza-test-dir-detection-'));
    process.chdir(testTmpDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    if (testTmpDir && testTmpDir.includes('eliza-test-dir-detection-')) {
      await rm(testTmpDir, { recursive: true, force: true });
    }
  });

  afterAll(() => {
    process.chdir(originalCwd);
  });

  describe('detectDirectoryType', () => {
    test('detects non-elizaos directory without package.json', () => {
      const result = detectDirectoryType(testTmpDir);

      expect(result.type).toBe('non-elizaos-dir');
      expect(result.hasPackageJson).toBe(false);
      expect(result.hasElizaOSDependencies).toBe(false);
      expect(result.elizaPackageCount).toBe(0);
      expect(result.isNonElizaOS).toBe(true);
      expect(result.isProject).toBe(false);
      expect(result.isPlugin).toBe(false);
      expect(result.isMonorepo).toBe(false);
      expect(result.isSubdir).toBe(false);
    });

    test('detects non-elizaos directory with non-eliza package.json', async () => {
      await writeFile(
        'package.json',
        JSON.stringify(
          {
            name: 'some-project',
            version: '1.0.0',
            dependencies: {
              express: '^4.18.0',
            },
          },
          null,
          2
        )
      );

      const result = detectDirectoryType(testTmpDir);

      expect(result.type).toBe('non-elizaos-dir');
      expect(result.hasPackageJson).toBe(true);
      expect(result.hasElizaOSDependencies).toBe(false);
      expect(result.elizaPackageCount).toBe(0);
      expect(result.packageName).toBe('some-project');
      expect(result.isNonElizaOS).toBe(true);
    });

    test('detects elizaos plugin by packageType field', async () => {
      await writeFile(
        'package.json',
        JSON.stringify(
          {
            name: '@elizaos/plugin-test',
            version: '1.0.0',
            packageType: 'plugin',
            dependencies: {
              '@elizaos/core': '^1.0.0',
            },
          },
          null,
          2
        )
      );

      const result = detectDirectoryType(testTmpDir);

      expect(result.type).toBe('elizaos-plugin');
      expect(result.hasPackageJson).toBe(true);
      expect(result.hasElizaOSDependencies).toBe(true);
      expect(result.elizaPackageCount).toBe(1);
      expect(result.packageName).toBe('@elizaos/plugin-test');
      expect(result.isPlugin).toBe(true);
      expect(result.isProject).toBe(false);
      expect(result.isNonElizaOS).toBe(false);
    });

    test('detects elizaos plugin by keywords', async () => {
      await writeFile(
        'package.json',
        JSON.stringify(
          {
            name: '@elizaos/plugin-discord',
            version: '1.0.0',
            keywords: ['plugin', 'discord'],
            dependencies: {
              '@elizaos/core': '^1.0.0',
            },
          },
          null,
          2
        )
      );

      const result = detectDirectoryType(testTmpDir);

      expect(result.type).toBe('elizaos-plugin');
      expect(result.isPlugin).toBe(true);
    });

    test('detects elizaos plugin by name pattern', async () => {
      await writeFile(
        'package.json',
        JSON.stringify(
          {
            name: '@elizaos/plugin-twitter',
            version: '1.0.0',
            dependencies: {
              '@elizaos/core': '^1.0.0',
            },
          },
          null,
          2
        )
      );

      const result = detectDirectoryType(testTmpDir);

      expect(result.type).toBe('elizaos-plugin');
      expect(result.isPlugin).toBe(true);
    });

    test('detects elizaos project by packageType field', async () => {
      await writeFile(
        'package.json',
        JSON.stringify(
          {
            name: 'my-elizaos-project',
            version: '1.0.0',
            packageType: 'project',
            dependencies: {
              '@elizaos/core': '^1.0.0',
              '@elizaos/plugin-bootstrap': '^1.0.0',
            },
          },
          null,
          2
        )
      );

      const result = detectDirectoryType(testTmpDir);

      expect(result.type).toBe('elizaos-project');
      expect(result.hasPackageJson).toBe(true);
      expect(result.hasElizaOSDependencies).toBe(true);
      expect(result.elizaPackageCount).toBe(2);
      expect(result.isProject).toBe(true);
      expect(result.isPlugin).toBe(false);
      expect(result.isNonElizaOS).toBe(false);
    });

    test('detects elizaos project by keywords', async () => {
      await writeFile(
        'package.json',
        JSON.stringify(
          {
            name: 'my-agent-project',
            version: '1.0.0',
            keywords: ['project', 'ai-agent'],
            dependencies: {
              '@elizaos/core': '^1.0.0',
              '@elizaos/plugin-bootstrap': '^1.0.0',
            },
          },
          null,
          2
        )
      );

      const result = detectDirectoryType(testTmpDir);

      expect(result.type).toBe('elizaos-project');
      expect(result.isProject).toBe(true);
    });

    test('detects elizaos project by character files', async () => {
      await writeFile(
        'package.json',
        JSON.stringify(
          {
            name: 'my-agent',
            version: '1.0.0',
            dependencies: {
              '@elizaos/core': '^1.0.0',
              '@elizaos/plugin-bootstrap': '^1.0.0',
            },
          },
          null,
          2
        )
      );

      await writeFile(
        'character.json',
        JSON.stringify({
          name: 'TestAgent',
          bio: ['Test agent bio'],
        })
      );

      const result = detectDirectoryType(testTmpDir);

      expect(result.type).toBe('elizaos-project');
      expect(result.isProject).toBe(true);
    });

    test('detects elizaos project by directory structure', async () => {
      await writeFile(
        'package.json',
        JSON.stringify(
          {
            name: 'my-agent',
            version: '1.0.0',
            dependencies: {
              '@elizaos/core': '^1.0.0',
              '@elizaos/plugin-bootstrap': '^1.0.0',
            },
          },
          null,
          2
        )
      );

      await mkdir('characters');
      await writeFile('characters/agent.json', '{}');

      const result = detectDirectoryType(testTmpDir);

      expect(result.type).toBe('elizaos-project');
      expect(result.isProject).toBe(true);
    });

    test('plugin takes precedence over project when both patterns match', async () => {
      await writeFile(
        'package.json',
        JSON.stringify(
          {
            name: '@elizaos/plugin-test',
            version: '1.0.0',
            packageType: 'plugin', // Explicit plugin marker
            keywords: ['project'], // Project keyword (should be ignored)
            dependencies: {
              '@elizaos/core': '^1.0.0',
            },
          },
          null,
          2
        )
      );

      const result = detectDirectoryType(testTmpDir);

      expect(result.type).toBe('elizaos-plugin');
      expect(result.isPlugin).toBe(true);
      expect(result.isProject).toBe(false);
    });

    test('handles corrupted package.json gracefully', async () => {
      await writeFile('package.json', 'invalid json content');

      const result = detectDirectoryType(testTmpDir);

      expect(result.type).toBe('non-elizaos-dir');
      expect(result.hasPackageJson).toBe(true);
      expect(result.hasElizaOSDependencies).toBe(false);
    });

    test('counts elizaos dependencies correctly', async () => {
      await writeFile(
        'package.json',
        JSON.stringify(
          {
            name: 'test-project',
            version: '1.0.0',
            packageType: 'project',
            dependencies: {
              '@elizaos/core': '^1.0.0',
              '@elizaos/plugin-bootstrap': '^1.0.0',
              express: '^4.18.0',
            },
            devDependencies: {
              '@elizaos/plugin-test': '^1.0.0',
              typescript: '^5.0.0',
            },
          },
          null,
          2
        )
      );

      const result = detectDirectoryType(testTmpDir);

      expect(result.elizaPackageCount).toBe(3); // core, bootstrap, test
      expect(result.hasElizaOSDependencies).toBe(true);
    });
  });

  describe('isValidForUpdates', () => {
    test('returns true for elizaos-project', async () => {
      await writeFile(
        'package.json',
        JSON.stringify({
          name: 'test-project',
          packageType: 'project',
          dependencies: { '@elizaos/core': '^1.0.0' },
        })
      );

      const result = detectDirectoryType(testTmpDir);
      expect(isValidForUpdates(result)).toBe(true);
    });

    test('returns true for elizaos-plugin', async () => {
      await writeFile(
        'package.json',
        JSON.stringify({
          name: '@elizaos/plugin-test',
          packageType: 'plugin',
          dependencies: { '@elizaos/core': '^1.0.0' },
        })
      );

      const result = detectDirectoryType(testTmpDir);
      expect(isValidForUpdates(result)).toBe(true);
    });

    test('returns false for non-elizaos-dir', async () => {
      await writeFile(
        'package.json',
        JSON.stringify({
          name: 'some-project',
          dependencies: { express: '^4.18.0' },
        })
      );

      const result = detectDirectoryType(testTmpDir);
      expect(isValidForUpdates(result)).toBe(false);
    });
  });

  describe('boolean flag consistency', () => {
    test('boolean flags are mutually exclusive for primary types', async () => {
      await writeFile(
        'package.json',
        JSON.stringify({
          name: '@elizaos/plugin-test',
          packageType: 'plugin',
          dependencies: { '@elizaos/core': '^1.0.0' },
        })
      );

      const result = detectDirectoryType(testTmpDir);

      // Only one primary flag should be true
      const primaryFlags = [
        result.isProject,
        result.isPlugin,
        result.isMonorepo,
        result.isNonElizaOS,
      ];
      const trueCount = primaryFlags.filter((flag) => flag).length;
      expect(trueCount).toBe(1);
    });

    test('boolean flags match type string', async () => {
      // Test plugin detection
      await writeFile(
        'package.json',
        JSON.stringify({
          name: 'test-plugin',
          packageType: 'plugin',
          dependencies: { '@elizaos/core': '^1.0.0' },
        })
      );

      let result = detectDirectoryType(testTmpDir);
      expect(result.type).toBe('elizaos-plugin');
      expect(result.isPlugin).toBe(true);
      expect(result.isProject).toBe(false);

      // Test project detection
      await writeFile(
        'package.json',
        JSON.stringify({
          name: 'test-project',
          packageType: 'project',
          dependencies: { '@elizaos/core': '^1.0.0' },
        })
      );

      result = detectDirectoryType(testTmpDir);
      expect(result.type).toBe('elizaos-project');
      expect(result.isProject).toBe(true);
      expect(result.isPlugin).toBe(false);
    });
  });
});
