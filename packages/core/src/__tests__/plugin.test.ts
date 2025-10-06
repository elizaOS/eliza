import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { PluginManager } from '../plugin';
import type { Plugin } from '../types';

describe('PluginManager', () => {
  let pluginManager: PluginManager;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    pluginManager = new PluginManager();
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('isValidPlugin', () => {
    test('should return true for valid plugin shape', () => {
      const plugin = {
        name: 'test-plugin',
        description: 'A test plugin',
        actions: [],
        services: [],
      };

      expect(pluginManager.isValidPlugin(plugin)).toBe(true);
    });

    test('should return false for invalid plugin shape', () => {
      const invalidPlugin = {
        name: 'test-plugin',
        // Missing required properties
      };

      expect(pluginManager.isValidPlugin(invalidPlugin)).toBe(false);
    });

    test('should return false for null or undefined', () => {
      expect(pluginManager.isValidPlugin(null)).toBe(false);
      expect(pluginManager.isValidPlugin(undefined)).toBe(false);
    });

    test('should return false for non-object types', () => {
      expect(pluginManager.isValidPlugin('string')).toBe(false);
      expect(pluginManager.isValidPlugin(123)).toBe(false);
      expect(pluginManager.isValidPlugin(true)).toBe(false);
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

      const result = await pluginManager.loadPlugin(plugin);

      expect(result).toBe(plugin);
      expect(result?.name).toBe('test-plugin');
    });

    test('should return null for invalid plugin object', async () => {
      const invalidPlugin = {
        // Missing name
        description: 'Invalid plugin',
      } as any;

      const result = await pluginManager.loadPlugin(invalidPlugin);

      expect(result).toBeNull();
    });

    test('should handle plugin loading errors gracefully', async () => {
      // Test with a non-existent plugin
      const result = await pluginManager.loadPlugin('@elizaos/non-existent-plugin');

      expect(result).toBeNull();
    });

    test('should load bootstrap plugin successfully', async () => {
      const result = await pluginManager.loadPlugin('@elizaos/plugin-bootstrap');

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

      const resolved = await pluginManager.resolvePlugins([pluginA, pluginB]);

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

      const resolved = await pluginManager.resolvePlugins([pluginB, pluginA]);

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

      const resolved = await pluginManager.resolvePlugins([pluginA, pluginB]);

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

      const resolved = await pluginManager.resolvePlugins([validPlugin, invalidPlugin]);

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

      const resolved = await pluginManager.resolvePlugins([pluginA, pluginB], true);

      expect(resolved).toHaveLength(2);
      const indexA = resolved.findIndex((p) => p.name === 'plugin-a');
      const indexB = resolved.findIndex((p) => p.name === 'plugin-b');
      // In test mode, plugin-b should come before plugin-a due to testDependencies
      expect(indexB).toBeLessThan(indexA);
    });
  });
});
