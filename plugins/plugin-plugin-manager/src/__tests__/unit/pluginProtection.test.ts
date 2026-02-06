import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PluginManagerService } from '../../services/pluginManagerService';
import type { IAgentRuntime, Plugin, UUID } from '@elizaos/core';

describe('Plugin Protection Mechanism', () => {
  let runtime: IAgentRuntime;
  let pluginManager: PluginManagerService;

  const mockPlugin = (name: string): Plugin => ({
    name,
    description: `Mock ${name} plugin`,
    actions: [
      {
        name: `${name}_ACTION`,
        similes: [],
        description: 'Test action',
        validate: async () => true,
        handler: async () => ({ text: 'Success', success: true }),
      },
    ],
  });

  beforeEach(async () => {
    // Create mock runtime with original plugins
    const originalPlugins = [
      mockPlugin('@elizaos/plugin-sql'),
      mockPlugin('bootstrap'),
      mockPlugin('game-api'),
      mockPlugin('inference'),
      mockPlugin('autonomy'),
      mockPlugin('knowledge'),
      mockPlugin('@elizaos/plugin-personality'),
      mockPlugin('experience'),
    ];

    runtime = {
      agentId: 'test-agent-id' as UUID,
      plugins: [...originalPlugins],
      actions: [],
      providers: [],
      evaluators: [],
      services: new Map(),
      registerPlugin: vi.fn().mockResolvedValue(undefined),
      registerAction: vi.fn(),
      registerProvider: vi.fn(),
      registerEvaluator: vi.fn(),
      registerEvent: vi.fn(),
      getService: vi.fn(),
    } as any;

    pluginManager = await PluginManagerService.start(runtime);
  });

  describe('Protected Plugin List', () => {
    it('should have all core plugins in protected list', () => {
      const protectedPlugins = pluginManager.getProtectedPlugins();

      expect(protectedPlugins).toContain('plugin-manager');
      expect(protectedPlugins).toContain('@elizaos/plugin-sql');
      expect(protectedPlugins).toContain('bootstrap');
      expect(protectedPlugins).toContain('game-api');
      expect(protectedPlugins).toContain('inference');
      expect(protectedPlugins).toContain('autonomy');
      expect(protectedPlugins).toContain('knowledge');
      expect(protectedPlugins).toContain('@elizaos/plugin-personality');
      expect(protectedPlugins).toContain('experience');
    });
  });

  describe('canUnloadPlugin', () => {
    it('should return false for protected plugins', () => {
      expect(pluginManager.canUnloadPlugin('@elizaos/plugin-sql')).toBe(false);
      expect(pluginManager.canUnloadPlugin('bootstrap')).toBe(false);
      expect(pluginManager.canUnloadPlugin('game-api')).toBe(false);
      expect(pluginManager.canUnloadPlugin('plugin-manager')).toBe(false);
    });

    it('should return false for original plugins', () => {
      const originalPlugins = pluginManager.getOriginalPlugins();

      for (const pluginName of originalPlugins) {
        expect(pluginManager.canUnloadPlugin(pluginName)).toBe(false);
      }
    });

    it('should return true for non-protected dynamically loaded plugins', async () => {
      // Register and load a new plugin
      const testPlugin = mockPlugin('test-dynamic-plugin');
      const pluginId = await pluginManager.registerPlugin(testPlugin);
      await pluginManager.loadPlugin({ pluginId });

      expect(pluginManager.canUnloadPlugin('test-dynamic-plugin')).toBe(true);
    });
  });

  describe('getProtectionReason', () => {
    it('should return appropriate reason for core system plugins', () => {
      const reason = pluginManager.getProtectionReason('@elizaos/plugin-sql');
      expect(reason).toContain('core system plugin');
    });

    it('should return appropriate reason for startup plugins', () => {
      // Bootstrap is both a protected plugin and an original plugin
      const reason = pluginManager.getProtectionReason('bootstrap');
      expect(reason).toBeTruthy();
      expect(reason).toMatch(/core system plugin|loaded at startup/);
    });

    it('should return null for unprotected plugins', async () => {
      const testPlugin = mockPlugin('unprotected-plugin');
      const pluginId = await pluginManager.registerPlugin(testPlugin);

      const reason = pluginManager.getProtectionReason('unprotected-plugin');
      expect(reason).toBeNull();
    });
  });

  describe('Plugin Registration Protection', () => {
    it('should throw error when trying to register plugin with protected name', async () => {
      // Try to register a plugin with a name that's in PROTECTED_PLUGINS but not in originalPlugins
      const protectedPlugin = mockPlugin('plugin-manager');

      await expect(pluginManager.registerPlugin(protectedPlugin)).rejects.toThrow(
        'Cannot register protected plugin'
      );
    });

    it('should throw error when trying to register duplicate of original plugin', async () => {
      const duplicatePlugin = mockPlugin('@elizaos/plugin-sql');

      // Since @elizaos/plugin-sql is already registered during initialization,
      // it should throw "already registered" error
      await expect(pluginManager.registerPlugin(duplicatePlugin)).rejects.toThrow(
        'already registered'
      );
    });
  });

  describe('Plugin Unloading Protection', () => {
    it('should throw error when trying to unload protected plugin', async () => {
      // Get a protected plugin's ID
      const plugins = pluginManager.getAllPlugins();
      const sqlPlugin = plugins.find((p) => p.name === '@elizaos/plugin-sql');

      if (sqlPlugin) {
        await expect(pluginManager.unloadPlugin({ pluginId: sqlPlugin.id })).rejects.toThrow(
          'Cannot unload original plugin'
        );
      }
    });

    it('should successfully unload non-protected plugin', async () => {
      // Register and load a new plugin
      const testPlugin = mockPlugin('test-unloadable');
      const pluginId = await pluginManager.registerPlugin(testPlugin);
      await pluginManager.loadPlugin({ pluginId });

      // Should be able to unload it
      await expect(pluginManager.unloadPlugin({ pluginId })).resolves.not.toThrow();

      // Verify it's unloaded
      const pluginState = pluginManager.getPlugin(pluginId);
      expect(pluginState?.status).toBe('unloaded');
    });
  });

  describe('Force Loading Protection', () => {
    it('should throw error when trying to force load protected plugin', async () => {
      const plugins = pluginManager.getAllPlugins();
      const protectedPlugin = plugins.find((p) => p.name === 'bootstrap');

      if (protectedPlugin) {
        await expect(
          pluginManager.loadPlugin({ pluginId: protectedPlugin.id, force: true })
        ).rejects.toThrow('Cannot force load protected plugin');
      }
    });
  });

  describe('Name Variation Protection', () => {
    it('should protect plugins with @elizaos prefix variations', () => {
      // Should protect both with and without prefix
      expect(pluginManager.canUnloadPlugin('plugin-sql')).toBe(false);
      expect(pluginManager.canUnloadPlugin('@elizaos/plugin-sql')).toBe(false);
    });

    it('should detect protection for plugins registered without prefix', async () => {
      const testPlugin = mockPlugin('plugin-personality');

      await expect(pluginManager.registerPlugin(testPlugin)).rejects.toThrow(
        'Cannot register protected plugin'
      );
    });
  });
});
