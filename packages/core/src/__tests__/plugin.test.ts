import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  loadPlugin,
  resolvePlugins,
  isValidPluginShape,
  tryInstallPlugin,
  normalizePluginName,
  resolvePluginDependencies,
} from '../plugin';
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
        delete process.env[k];
      }
    }
    for (const [k, v] of Object.entries(originalEnv)) {
      process.env[k] = v;
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

    test('should handle scoped plugin names with short name dependencies', async () => {
      // Plugin with scoped name
      const pluginDiscord: Plugin = {
        name: '@elizaos/plugin-discord',
        description: 'Discord plugin',
        actions: [],
        services: [],
      };

      // Plugin that depends on it using short name
      const pluginBootstrap: Plugin = {
        name: 'bootstrap',
        description: 'Bootstrap plugin',
        dependencies: ['discord'], // Short name reference
        actions: [],
        services: [],
      };

      // Resolve plugins - discord should be loaded first due to dependency
      const resolved = await resolvePlugins([pluginBootstrap, pluginDiscord]);

      // Should have both plugins
      expect(resolved).toHaveLength(2);

      // Discord should come before bootstrap due to dependency
      const indexDiscord = resolved.findIndex((p) => p.name === '@elizaos/plugin-discord');
      const indexBootstrap = resolved.findIndex((p) => p.name === 'bootstrap');
      expect(indexDiscord).toBeLessThan(indexBootstrap);

      // Verify both plugins are present
      expect(resolved.some((p) => p.name === '@elizaos/plugin-discord')).toBe(true);
      expect(resolved.some((p) => p.name === 'bootstrap')).toBe(true);
    });

    test('should not queue dependency twice when plugin has scoped name', async () => {
      // Plugin with scoped name
      const pluginDiscord: Plugin = {
        name: '@elizaos/plugin-discord',
        description: 'Discord plugin',
        actions: [],
        services: [],
      };

      // Plugin that depends on it using short name
      const pluginA: Plugin = {
        name: 'plugin-a',
        description: 'Plugin A',
        dependencies: ['discord'], // Short name reference
        actions: [],
        services: [],
      };

      // Another plugin that also depends on it using short name
      const pluginB: Plugin = {
        name: 'plugin-b',
        description: 'Plugin B',
        dependencies: ['discord'], // Short name reference
        actions: [],
        services: [],
      };

      // Resolve plugins - discord should only appear once
      const resolved = await resolvePlugins([pluginA, pluginB, pluginDiscord]);

      // Should have all three plugins, but discord only once
      expect(resolved).toHaveLength(3);

      // Count occurrences of discord plugin
      const discordCount = resolved.filter((p) => p.name === '@elizaos/plugin-discord').length;
      expect(discordCount).toBe(1);
    });
  });

  describe('normalizePluginName', () => {
    test('should extract short name from @elizaos scoped packages', () => {
      expect(normalizePluginName('@elizaos/plugin-discord')).toBe('discord');
      expect(normalizePluginName('@elizaos/plugin-sql')).toBe('sql');
      expect(normalizePluginName('@elizaos/plugin-bootstrap')).toBe('bootstrap');
    });

    test('should extract short name from other scoped packages', () => {
      expect(normalizePluginName('@myorg/plugin-custom')).toBe('custom');
      expect(normalizePluginName('@company/plugin-integration')).toBe('integration');
    });

    test('should return original name for non-scoped packages', () => {
      expect(normalizePluginName('discord')).toBe('discord');
      expect(normalizePluginName('bootstrap')).toBe('bootstrap');
      expect(normalizePluginName('my-custom-plugin')).toBe('my-custom-plugin');
    });

    test('should return original name for scoped packages without plugin- prefix', () => {
      expect(normalizePluginName('@elizaos/core')).toBe('@elizaos/core');
      expect(normalizePluginName('@myorg/utils')).toBe('@myorg/utils');
    });
  });

  describe('resolvePluginDependencies with scoped names', () => {
    test('should resolve dependency using scoped package name', () => {
      const pluginA: Plugin = {
        name: 'discord',
        description: 'Discord plugin',
        actions: [],
        services: [],
      };

      const pluginB: Plugin = {
        name: 'music-player',
        description: 'Music player plugin',
        dependencies: ['@elizaos/plugin-discord'], // Scoped name
        actions: [],
        services: [],
      };

      const pluginMap = new Map<string, Plugin>();
      pluginMap.set('discord', pluginA);
      pluginMap.set('music-player', pluginB);

      const resolved = resolvePluginDependencies(pluginMap);

      expect(resolved).toHaveLength(2);
      const indexA = resolved.findIndex((p) => p.name === 'discord');
      const indexB = resolved.findIndex((p) => p.name === 'music-player');
      // Discord should come before music-player due to dependency
      expect(indexA).toBeLessThan(indexB);
    });

    test('should resolve dependency using short name', () => {
      const pluginA: Plugin = {
        name: 'discord',
        description: 'Discord plugin',
        actions: [],
        services: [],
      };

      const pluginB: Plugin = {
        name: 'music-player',
        description: 'Music player plugin',
        dependencies: ['discord'], // Short name
        actions: [],
        services: [],
      };

      const pluginMap = new Map<string, Plugin>();
      pluginMap.set('discord', pluginA);
      pluginMap.set('music-player', pluginB);

      const resolved = resolvePluginDependencies(pluginMap);

      expect(resolved).toHaveLength(2);
      const indexA = resolved.findIndex((p) => p.name === 'discord');
      const indexB = resolved.findIndex((p) => p.name === 'music-player');
      expect(indexA).toBeLessThan(indexB);
    });

    test('should handle mixed scoped and short names', () => {
      const pluginA: Plugin = {
        name: 'sql',
        description: 'SQL plugin',
        actions: [],
        services: [],
      };

      const pluginB: Plugin = {
        name: 'discord',
        description: 'Discord plugin',
        dependencies: ['@elizaos/plugin-sql'], // Scoped name
        actions: [],
        services: [],
      };

      const pluginC: Plugin = {
        name: 'music-player',
        description: 'Music player plugin',
        dependencies: ['discord', 'sql'], // Short names
        actions: [],
        services: [],
      };

      const pluginMap = new Map<string, Plugin>();
      pluginMap.set('sql', pluginA);
      pluginMap.set('discord', pluginB);
      pluginMap.set('music-player', pluginC);

      const resolved = resolvePluginDependencies(pluginMap);

      expect(resolved).toHaveLength(3);
      const indexA = resolved.findIndex((p) => p.name === 'sql');
      const indexB = resolved.findIndex((p) => p.name === 'discord');
      const indexC = resolved.findIndex((p) => p.name === 'music-player');
      // SQL should come first, then discord, then music-player
      expect(indexA).toBeLessThan(indexB);
      expect(indexB).toBeLessThan(indexC);
    });

    test('should warn on missing scoped dependency', () => {
      const pluginA: Plugin = {
        name: 'music-player',
        description: 'Music player plugin',
        dependencies: ['@elizaos/plugin-nonexistent'],
        actions: [],
        services: [],
      };

      const pluginMap = new Map<string, Plugin>();
      pluginMap.set('music-player', pluginA);

      const resolved = resolvePluginDependencies(pluginMap);

      // Should still resolve the plugin even if dependency is missing
      expect(resolved).toHaveLength(1);
      expect(resolved[0].name).toBe('music-player');
    });

    test('should not create double-scoped names in lookup map', () => {
      // Plugin with scoped name - this should not create '@elizaos/plugin-@elizaos/plugin-discord'
      const pluginDiscord: Plugin = {
        name: '@elizaos/plugin-discord',
        description: 'Discord plugin',
        actions: [],
        services: [],
      };

      const pluginBootstrap: Plugin = {
        name: 'bootstrap',
        description: 'Bootstrap plugin',
        dependencies: ['discord'], // Short name reference
        actions: [],
        services: [],
      };

      const pluginMap = new Map<string, Plugin>();
      pluginMap.set('@elizaos/plugin-discord', pluginDiscord);
      pluginMap.set('bootstrap', pluginBootstrap);

      const resolved = resolvePluginDependencies(pluginMap);

      // Should resolve correctly without creating double-scoped names
      expect(resolved).toHaveLength(2);
      const indexDiscord = resolved.findIndex((p) => p.name === '@elizaos/plugin-discord');
      const indexBootstrap = resolved.findIndex((p) => p.name === 'bootstrap');
      // Discord should come before bootstrap due to dependency
      expect(indexDiscord).toBeLessThan(indexBootstrap);

      // Verify the plugin is found correctly
      expect(resolved.some((p) => p.name === '@elizaos/plugin-discord')).toBe(true);
    });

    test('should handle complex dependency chains with scoped names', () => {
      const pluginA: Plugin = {
        name: 'sql',
        description: 'SQL plugin',
        actions: [],
        services: [],
      };

      const pluginB: Plugin = {
        name: 'bootstrap',
        description: 'Bootstrap plugin',
        dependencies: ['@elizaos/plugin-sql'],
        actions: [],
        services: [],
      };

      const pluginC: Plugin = {
        name: 'discord',
        description: 'Discord plugin',
        dependencies: ['bootstrap'],
        actions: [],
        services: [],
      };

      const pluginD: Plugin = {
        name: 'music-player',
        description: 'Music player plugin',
        dependencies: ['@elizaos/plugin-discord', '@elizaos/plugin-bootstrap'],
        actions: [],
        services: [],
      };

      const pluginMap = new Map<string, Plugin>();
      pluginMap.set('sql', pluginA);
      pluginMap.set('bootstrap', pluginB);
      pluginMap.set('discord', pluginC);
      pluginMap.set('music-player', pluginD);

      const resolved = resolvePluginDependencies(pluginMap);

      expect(resolved).toHaveLength(4);
      const indexSql = resolved.findIndex((p) => p.name === 'sql');
      const indexBootstrap = resolved.findIndex((p) => p.name === 'bootstrap');
      const indexDiscord = resolved.findIndex((p) => p.name === 'discord');
      const indexMusicPlayer = resolved.findIndex((p) => p.name === 'music-player');

      // Verify dependency order
      expect(indexSql).toBeLessThan(indexBootstrap);
      expect(indexBootstrap).toBeLessThan(indexDiscord);
      expect(indexDiscord).toBeLessThan(indexMusicPlayer);
    });
  });

  describe('resolvePlugins with scoped dependencies', () => {
    test('should resolve plugins with scoped dependencies', async () => {
      const pluginA: Plugin = {
        name: 'sql',
        description: 'SQL plugin',
        actions: [],
        services: [],
      };

      const pluginB: Plugin = {
        name: 'test-plugin',
        description: 'Test plugin',
        dependencies: ['@elizaos/plugin-sql'],
        actions: [],
        services: [],
      };

      const resolved = await resolvePlugins([pluginB, pluginA]);

      expect(resolved).toHaveLength(2);
      const indexA = resolved.findIndex((p) => p.name === 'sql');
      const indexB = resolved.findIndex((p) => p.name === 'test-plugin');
      expect(indexA).toBeLessThan(indexB);
    });

    test('should handle test dependencies with scoped names', async () => {
      const pluginA: Plugin = {
        name: 'sql',
        description: 'SQL plugin',
        actions: [],
        services: [],
      };

      const pluginB: Plugin = {
        name: 'test-plugin',
        description: 'Test plugin',
        testDependencies: ['@elizaos/plugin-sql'],
        actions: [],
        services: [],
      };

      const resolved = await resolvePlugins([pluginB, pluginA], true);

      expect(resolved).toHaveLength(2);
      const indexA = resolved.findIndex((p) => p.name === 'sql');
      const indexB = resolved.findIndex((p) => p.name === 'test-plugin');
      expect(indexA).toBeLessThan(indexB);
    });
  });

  describe('tryInstallPlugin (auto-install)', () => {
    const originalSpawn = (Bun as any).spawn;
    const originalEnv = { ...process.env } as Record<string, string>;

    beforeEach(() => {
      // Reset environment to allow auto-install
      process.env = { ...originalEnv } as Record<string, string | undefined>;
      process.env.NODE_ENV = 'development';
      delete process.env.CI;
      delete process.env.ELIZA_TEST_MODE;
      delete process.env.ELIZA_NO_AUTO_INSTALL;
      delete process.env.ELIZA_NO_PLUGIN_AUTO_INSTALL;
    });

    afterEach(() => {
      (Bun as any).spawn = originalSpawn;
      process.env = { ...originalEnv } as Record<string, string | undefined>;
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
