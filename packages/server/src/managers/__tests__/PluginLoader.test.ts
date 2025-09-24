import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { PluginLoader } from '../PluginLoader';
import type { Plugin } from '@elizaos/core';

describe('PluginLoader', () => {
  let pluginLoader: PluginLoader;

  beforeEach(() => {
    pluginLoader = new PluginLoader();
  });

  describe('isValidPluginShape', () => {
    test('should return true for valid plugin shape', () => {
      const plugin = {
        name: 'test-plugin',
        description: 'A test plugin',
        actions: [],
        services: []
      };

      expect(pluginLoader.isValidPluginShape(plugin)).toBe(true);
    });

    test('should return false for invalid plugin shape', () => {
      const invalidPlugin = {
        name: 'test-plugin'
        // Missing required properties
      };

      expect(pluginLoader.isValidPluginShape(invalidPlugin)).toBe(false);
    });

    test('should return false for null or undefined', () => {
      expect(pluginLoader.isValidPluginShape(null)).toBe(false);
      expect(pluginLoader.isValidPluginShape(undefined)).toBe(false);
    });

    test('should return false for non-object types', () => {
      expect(pluginLoader.isValidPluginShape('string')).toBe(false);
      expect(pluginLoader.isValidPluginShape(123)).toBe(false);
      expect(pluginLoader.isValidPluginShape(true)).toBe(false);
    });
  });

  describe('validatePlugin', () => {
    test('should validate a correct plugin', () => {
      const plugin: Plugin = {
        name: 'test-plugin',
        description: 'A test plugin',
        actions: [],
        services: [],
        providers: [],
        evaluators: []
      };

      const result = pluginLoader.validatePlugin(plugin);
      
      expect(result.isValid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    test('should detect missing name', () => {
      const plugin = {
        description: 'A test plugin',
        actions: [],
        services: []
      } as any;

      const result = pluginLoader.validatePlugin(plugin);
      
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Plugin must have a name');
    });

    test('should detect invalid action format', () => {
      const plugin: Plugin = {
        name: 'test-plugin',
        description: 'A test plugin',
        actions: ['not-an-action'] as any,
        services: []
      };

      const result = pluginLoader.validatePlugin(plugin);
      
      expect(result.isValid).toBe(false);
      expect(result.errors.some(e => e.includes('actions'))).toBe(true);
    });

    test('should detect invalid service format', () => {
      const plugin: Plugin = {
        name: 'test-plugin',
        description: 'A test plugin',
        actions: [],
        services: ['not-a-service'] as any
      };

      const result = pluginLoader.validatePlugin(plugin);
      
      expect(result.isValid).toBe(false);
      expect(result.errors.some(e => e.includes('services'))).toBe(true);
    });
  });

  describe('resolvePluginDependencies', () => {
    test('should resolve simple dependencies', () => {
      const pluginA: Plugin = {
        name: 'plugin-a',
        description: 'Plugin A',
        actions: [],
        services: []
      };

      const pluginB: Plugin = {
        name: 'plugin-b',
        description: 'Plugin B',
        dependencies: ['plugin-a'],
        actions: [],
        services: []
      };

      const pluginsMap = new Map<string, Plugin>([
        ['plugin-a', pluginA],
        ['plugin-b', pluginB]
      ]);

      const resolved = pluginLoader.resolvePluginDependencies(pluginsMap);
      
      expect(resolved).toHaveLength(2);
      expect(resolved[0].name).toBe('plugin-a');
      expect(resolved[1].name).toBe('plugin-b');
    });

    test('should handle circular dependencies', () => {
      const pluginA: Plugin = {
        name: 'plugin-a',
        description: 'Plugin A',
        dependencies: ['plugin-b'],
        actions: [],
        services: []
      };

      const pluginB: Plugin = {
        name: 'plugin-b',
        description: 'Plugin B',
        dependencies: ['plugin-a'],
        actions: [],
        services: []
      };

      const pluginsMap = new Map<string, Plugin>([
        ['plugin-a', pluginA],
        ['plugin-b', pluginB]
      ]);

      const resolved = pluginLoader.resolvePluginDependencies(pluginsMap);
      
      // Should return plugins even with circular dependencies
      expect(resolved).toHaveLength(2);
    });

    test('should handle missing dependencies', () => {
      const plugin: Plugin = {
        name: 'plugin-a',
        description: 'Plugin A',
        dependencies: ['non-existent-plugin'],
        actions: [],
        services: []
      };

      const pluginsMap = new Map<string, Plugin>([
        ['plugin-a', plugin]
      ]);

      const resolved = pluginLoader.resolvePluginDependencies(pluginsMap);
      
      expect(resolved).toHaveLength(1);
      expect(resolved[0].name).toBe('plugin-a');
    });

    test('should handle test dependencies in test mode', () => {
      const pluginA: Plugin = {
        name: 'plugin-a',
        description: 'Plugin A',
        testDependencies: ['plugin-b'],
        actions: [],
        services: []
      };

      const pluginB: Plugin = {
        name: 'plugin-b',
        description: 'Plugin B',
        actions: [],
        services: []
      };

      const pluginsMap = new Map<string, Plugin>([
        ['plugin-a', pluginA],
        ['plugin-b', pluginB]
      ]);

      const resolved = pluginLoader.resolvePluginDependencies(pluginsMap, true);
      
      expect(resolved).toHaveLength(2);
      expect(resolved[0].name).toBe('plugin-b');
      expect(resolved[1].name).toBe('plugin-a');
    });

    test('should ignore test dependencies in non-test mode', () => {
      const pluginA: Plugin = {
        name: 'plugin-a',
        description: 'Plugin A',
        testDependencies: ['plugin-b'],
        actions: [],
        services: []
      };

      const pluginB: Plugin = {
        name: 'plugin-b',
        description: 'Plugin B',
        actions: [],
        services: []
      };

      const pluginsMap = new Map<string, Plugin>([
        ['plugin-a', pluginA],
        ['plugin-b', pluginB]
      ]);

      const resolved = pluginLoader.resolvePluginDependencies(pluginsMap, false);
      
      // Plugin B should not be included as dependency in non-test mode
      expect(resolved.some(p => p.name === 'plugin-a')).toBe(true);
      expect(resolved.some(p => p.name === 'plugin-b')).toBe(true);
    });
  });

  describe('loadAndPreparePlugin', () => {
    test('should handle plugin loading errors gracefully', async () => {
      // Test with a non-existent plugin
      const result = await pluginLoader.loadAndPreparePlugin('@elizaos/non-existent-plugin');
      
      expect(result).toBeNull();
    });

    test('should load bootstrap plugin successfully', async () => {
      const result = await pluginLoader.loadAndPreparePlugin('@elizaos/plugin-bootstrap');
      
      expect(result).toBeDefined();
      expect(result?.name).toBe('bootstrap');
    });
  });
});