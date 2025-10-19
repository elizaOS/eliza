import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { loadPlugin, resolvePlugins, isValidPluginShape, tryInstallPlugin } from '../plugin';
import type { Plugin } from '../types';

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('Plugin Functions', () => {
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    for (const k of Object.keys(process.env)) {
      if (!(k in originalEnv)) {
        delete (process.env as any)[k];
      }
    }
    for (const [k, v] of Object.entries(originalEnv)) {
      (process.env as any)[k] = v;
    }
  });

  describe('isValidPlugin', () => {
    test('should return true for valid plugin shape', () => {
      const plugin = {
        name: 'test-plugin',
        description: 'A test plugin',
        actions: [],
        services: [],
      };

      expect(isValidPluginShape(plugin)).toBe(true);
    });

    test('should return false for invalid plugin shape', () => {
      const invalidPlugin = {
        name: 'test-plugin',
        // Missing required properties
      };

      expect(isValidPluginShape(invalidPlugin)).toBe(false);
    });

    test('should return false for null or undefined', () => {
      expect(isValidPluginShape(null)).toBe(false);
      expect(isValidPluginShape(undefined)).toBe(false);
    });

    test('should return false for non-object types', () => {
      expect(isValidPluginShape('string')).toBe(false);
      expect(isValidPluginShape(123)).toBe(false);
      expect(isValidPluginShape(true)).toBe(false);
    });
  });

  describe('loadPlugin', () => {
    test('should validate and return plugin object when provided', async () => {
      const plugin: Plugin = {
        name: 'test-plugin',
        description: 'A test plugin',
        actions: [],
        services: [],
        providers: [],
        evaluators: [],
      };

      const result = await loadPlugin(plugin);

      expect(result).toBe(plugin);
      expect(result?.name).toBe('test-plugin');
    });

    test('should return null for invalid plugin object', async () => {
      const invalidPlugin = {
        // Missing name
        description: 'Invalid plugin',
      } as any;

      const result = await loadPlugin(invalidPlugin);

      expect(result).toBeNull();
    });

    test('should handle plugin loading errors gracefully', async () => {
      // Test with a non-existent plugin
      const result = await loadPlugin('@elizaos/non-existent-plugin');

      expect(result).toBeNull();
    });

    test('should load bootstrap plugin successfully', async () => {
      const result = await loadPlugin('@elizaos/plugin-bootstrap');

      expect(result).toBeDefined();
      expect(result?.name).toBe('bootstrap');
    });
  });

  describe('resolvePlugins', () => {
    test('should resolve simple plugin array', async () => {
      const pluginA: Plugin = {
        name: 'plugin-a',
        description: 'Plugin A',
        actions: [],
        services: [],
      };

      const pluginB: Plugin = {
        name: 'plugin-b',
        description: 'Plugin B',
        actions: [],
        services: [],
      };

      const resolved = await resolvePlugins([pluginA, pluginB]);

      expect(resolved).toHaveLength(2);
      expect(resolved.some((p) => p.name === 'plugin-a')).toBe(true);
      expect(resolved.some((p) => p.name === 'plugin-b')).toBe(true);
    });

    test('should resolve plugin dependencies', async () => {
      const pluginA: Plugin = {
        name: 'plugin-a',
        description: 'Plugin A',
        actions: [],
        services: [],
      };

      const pluginB: Plugin = {
        name: 'plugin-b',
        description: 'Plugin B',
        dependencies: ['plugin-a'],
        actions: [],
        services: [],
      };

      const resolved = await resolvePlugins([pluginB, pluginA]);

      expect(resolved).toHaveLength(2);
      // Plugin A should come before Plugin B due to dependency
      const indexA = resolved.findIndex((p) => p.name === 'plugin-a');
      const indexB = resolved.findIndex((p) => p.name === 'plugin-b');
      expect(indexA).toBeLessThan(indexB);
    });

    test('should handle circular dependencies', async () => {
      const pluginA: Plugin = {
        name: 'plugin-a',
        description: 'Plugin A',
        dependencies: ['plugin-b'],
        actions: [],
        services: [],
      };

      const pluginB: Plugin = {
        name: 'plugin-b',
        description: 'Plugin B',
        dependencies: ['plugin-a'],
        actions: [],
        services: [],
      };

      const resolved = await resolvePlugins([pluginA, pluginB]);

      // Should return plugins even with circular dependencies
      expect(resolved).toHaveLength(2);
    });

    test('should skip invalid plugins', async () => {
      const validPlugin: Plugin = {
        name: 'valid-plugin',
        description: 'A valid plugin',
        actions: [],
        services: [],
      };

      const invalidPlugin = {
        // Missing name
        description: 'Invalid plugin',
      } as any;

      const resolved = await resolvePlugins([validPlugin, invalidPlugin]);

      expect(resolved).toHaveLength(1);
      expect(resolved[0].name).toBe('valid-plugin');
    });

    test('should handle test dependencies in test mode', async () => {
      const pluginA: Plugin = {
        name: 'plugin-a',
        description: 'Plugin A',
        testDependencies: ['plugin-b'],
        actions: [],
        services: [],
      };

      const pluginB: Plugin = {
        name: 'plugin-b',
        description: 'Plugin B',
        actions: [],
        services: [],
      };

      const resolved = await resolvePlugins([pluginA, pluginB], true);

      expect(resolved).toHaveLength(2);
      const indexA = resolved.findIndex((p) => p.name === 'plugin-a');
      const indexB = resolved.findIndex((p) => p.name === 'plugin-b');
      // In test mode, plugin-b should come before plugin-a due to testDependencies
      expect(indexB).toBeLessThan(indexA);
    });
  });

  describe('tryInstallPlugin (auto-install)', () => {
    const originalSpawn = (Bun as any).spawn;
    const originalEnv = { ...process.env } as Record<string, string>;

    beforeEach(() => {
      // Reset environment to allow auto-install
      process.env = { ...originalEnv } as any;
      process.env.NODE_ENV = 'development';
      delete process.env.CI;
      delete process.env.ELIZA_TEST_MODE;
      delete process.env.ELIZA_NO_AUTO_INSTALL;
      delete process.env.ELIZA_NO_PLUGIN_AUTO_INSTALL;
    });

    afterEach(() => {
      (Bun as any).spawn = originalSpawn;
      process.env = { ...originalEnv } as any;
    });

    test('returns false when auto-install disallowed by ELIZA_NO_PLUGIN_AUTO_INSTALL', async () => {
      process.env.ELIZA_NO_PLUGIN_AUTO_INSTALL = 'true';

      let called = 0;
      (Bun as any).spawn = ((cmd: any[]) => {
        called += 1;
        return { exited: Promise.resolve(0) } as any;
      }) as any;

      const result = await tryInstallPlugin('@elizaos/test-no-plugin-auto-install');
      expect(result).toBe(false);
      expect(called).toBe(0);
    });

    test('returns false when auto-install disallowed by ELIZA_NO_AUTO_INSTALL', async () => {
      process.env.ELIZA_NO_AUTO_INSTALL = 'true';

      let called = 0;
      (Bun as any).spawn = ((cmd: any[]) => {
        called += 1;
        return { exited: Promise.resolve(0) } as any;
      }) as any;

      const result = await tryInstallPlugin('@elizaos/test-no-auto-install');
      expect(result).toBe(false);
      expect(called).toBe(0);
    });

    test('returns false when in CI environment', async () => {
      process.env.CI = 'true';

      let called = 0;
      (Bun as any).spawn = ((cmd: any[]) => {
        called += 1;
        return { exited: Promise.resolve(0) } as any;
      }) as any;

      const result = await tryInstallPlugin('@elizaos/test-ci-env');
      expect(result).toBe(false);
      expect(called).toBe(0);
    });

    test('returns false when in test mode', async () => {
      process.env.NODE_ENV = 'test';

      let called = 0;
      (Bun as any).spawn = ((cmd: any[]) => {
        called += 1;
        return { exited: Promise.resolve(0) } as any;
      }) as any;

      const result = await tryInstallPlugin('@elizaos/test-test-mode');
      expect(result).toBe(false);
      expect(called).toBe(0);
    });

    test('succeeds when bun present and bun add exits 0', async () => {
      const calls: any[] = [];

      (Bun as any).spawn = ((args: any[]) => {
        calls.push(args);
        // First call is bun --version, second is bun add <pkg>
        const isVersion = Array.isArray(args) && args[1] === '--version';
        const exitCode = isVersion ? 0 : 0;
        return { exited: Promise.resolve(exitCode) } as any;
      }) as any;

      const result = await tryInstallPlugin('@elizaos/test-success');
      expect(result).toBe(true);
      expect(calls.length).toBe(2);
      expect(calls[0]).toEqual(['bun', '--version']);
      expect(calls[1]).toEqual(['bun', 'add', '@elizaos/test-success']);
    });

    test('fails when bun --version exits non-zero', async () => {
      let versionCalls = 0;
      (Bun as any).spawn = ((args: any[]) => {
        if (Array.isArray(args) && args[1] === '--version') {
          versionCalls += 1;
          return { exited: Promise.resolve(1) } as any;
        }
        // would be bun add; should not be called
        return { exited: Promise.resolve(0) } as any;
      }) as any;

      const result = await tryInstallPlugin('@elizaos/test-bun-version-fail');
      expect(result).toBe(false);
      expect(versionCalls).toBe(1);
    });

    test('fails when bun add exits non-zero', async () => {
      const calls: any[] = [];
      (Bun as any).spawn = ((args: any[]) => {
        calls.push(args);
        const isVersion = Array.isArray(args) && args[1] === '--version';
        return { exited: Promise.resolve(isVersion ? 0 : 1) } as any;
      }) as any;

      const result = await tryInstallPlugin('@elizaos/test-bun-add-fail');
      expect(result).toBe(false);
      expect(calls.length).toBe(2);
    });

    test('awaits process completion before returning', async () => {
      let versionResolved = false;
      let addResolved = false;
      (Bun as any).spawn = ((args: any[]) => {
        const isVersion = Array.isArray(args) && args[1] === '--version';
        return {
          exited: (async () => {
            await delay(isVersion ? 25 : 50);
            if (isVersion) versionResolved = true;
            else addResolved = true;
            return 0;
          })(),
        } as any;
      }) as any;

      const result = await tryInstallPlugin('@elizaos/plugin-unique-test');
      expect(result).toBe(true);
      expect(versionResolved).toBe(true);
      expect(addResolved).toBe(true);
    });
  });
});
