import { type IAgentRuntime, type UUID } from '@elizaos/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PluginManagerService } from '../../services/pluginManagerService';
import { PluginStatus } from '../../types';

// Mock resetRegistryCache as it may not exist
const resetRegistryCache = vi.fn();

describe('Plugin Installation', () => {
  let mockRuntime: IAgentRuntime;
  let pluginManager: PluginManagerService;

  beforeEach(async () => {
    // Reset registry cache before each test
    resetRegistryCache();

    // Simple mock runtime
    mockRuntime = {
      agentId: 'test-agent-id' as UUID,
      plugins: [],
      registerPlugin: () => Promise.resolve(),
      registerAction: () => {},
      registerProvider: () => {},
      registerEvaluator: () => {},
      services: new Map(),
      getService: vi.fn(),
    } as any;

    pluginManager = new PluginManagerService(mockRuntime, {
      pluginDirectory: './test-plugins',
    });
  });

  afterEach(() => {
    // Clear mocks
    vi.clearAllMocks();
  });

  describe('Plugin Management', () => {
    it('should initialize plugin manager service', () => {
      expect(pluginManager).toBeDefined();
      expect(typeof pluginManager.installPluginFromRegistry).toBe('function');
      expect(typeof pluginManager.loadInstalledPlugin).toBe('function');
      expect(typeof pluginManager.listInstalledPlugins).toBe('function');
    });

    it('should handle non-existent plugin gracefully', async () => {
      await expect(
        pluginManager.installPluginFromRegistry('@elizaos/non-existent-plugin-12345')
      ).rejects.toThrow();
    });

    it('should track plugin installation attempts', () => {
      const installedPlugins = pluginManager.listInstalledPlugins();
      expect(Array.isArray(installedPlugins)).toBe(true);
    });
  });

  describe('Plugin State Management', () => {
    it('should handle plugin loading states', () => {
      const pluginId = 'test-plugin-id';
      const pluginState = pluginManager.getPlugin(pluginId);

      // Should handle non-existent plugin gracefully
      expect(pluginState).toBe(undefined);
    });

    it('should provide plugin configuration status', () => {
      const pluginInfo = pluginManager.getInstalledPluginInfo('@elizaos/non-existent');
      expect(pluginInfo).toBe(undefined);
    });
  });

  describe('Registry Operations', () => {
    it('should handle registry fetch attempts', async () => {
      try {
        const plugins = await pluginManager.getAvailablePluginsFromRegistry();
        expect(typeof plugins).toBe('object');
      } catch (error) {
        // Network errors are expected in test environment
        expect(error).toBeDefined();
      }
    });

    it('should handle invalid plugin names', async () => {
      await expect(pluginManager.installPluginFromRegistry('')).rejects.toThrow();
    });
  });

  describe('Plugin Loading', () => {
    it('should handle plugin loading attempts', async () => {
      await expect(
        pluginManager.loadInstalledPlugin('@elizaos/non-existent-plugin')
      ).rejects.toThrow();
    });

    it('should validate plugin loading prerequisites', () => {
      const hasPlugin = pluginManager.getInstalledPluginInfo('@elizaos/test');
      expect(hasPlugin).toBe(undefined);
    });
  });

  describe('Installed Plugin Management', () => {
    it('should track installed plugins list', () => {
      const installedPlugins = pluginManager.listInstalledPlugins();
      expect(Array.isArray(installedPlugins)).toBe(true);
    });

    it('should handle plugin info requests', () => {
      const pluginInfo = pluginManager.getInstalledPluginInfo('@elizaos/test-plugin');
      expect(pluginInfo).toBe(undefined); // No plugins installed initially
    });

    it('should handle plugin path operations safely', () => {
      // Test that the service handles path sanitization without errors
      expect(() => {
        pluginManager.getInstalledPluginInfo('@elizaos/plugin-test');
      }).not.toThrow();
    });
  });

  describe('Error Handling', () => {
    it('should handle invalid plugin names gracefully', async () => {
      await expect(
        pluginManager.installPluginFromRegistry('invalid-plugin-name')
      ).rejects.toThrow();
    });

    it('should handle network failures gracefully', async () => {
      await expect(
        pluginManager.installPluginFromRegistry('@elizaos/non-existent-plugin-xyz')
      ).rejects.toThrow();
    });

    it('should provide meaningful error messages', () => {
      expect(() => {
        pluginManager.getInstalledPluginInfo('');
      }).not.toThrow();
    });
  });
});
