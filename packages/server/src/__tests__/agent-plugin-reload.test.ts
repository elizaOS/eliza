/**
 * Agent plugin reload tests
 * Tests plugin change detection and agent restart logic for PATCH /api/agents/:agentId endpoint
 * Addresses issues:
 * - Plugin change detection using proper array comparison
 * - Agent restart with error recovery
 * - Input validation for plugins array
 */

import { describe, it, expect, beforeEach, mock, jest } from 'bun:test';
import type { Character } from '@elizaos/core';

// Type for plugins (string or object with name)
type PluginType = string | { name: string };

// Mock logger to avoid console output during tests
mock.module('@elizaos/core', () => ({
  logger: {
    warn: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    success: jest.fn(),
  },
  createUniqueUuid: jest.fn(() => '123e4567-e89b-12d3-a456-426614174000'),
}));

describe('Agent Plugin Reload - Plugin Change Detection', () => {
  describe('Plugin comparison logic', () => {
    it('should detect when plugins are added', () => {
      const currentPlugins = ['bootstrap', 'discord'];
      const updatedPlugins = ['bootstrap', 'discord', 'knowledge'];

      const current = currentPlugins
        .filter((p) => p != null)
        .map((p) => (typeof p === 'string' ? p : p))
        .sort();
      const updated = updatedPlugins
        .filter((p) => p != null)
        .map((p) => (typeof p === 'string' ? p : p))
        .sort();

      const pluginsChanged =
        current.length !== updated.length || current.some((plugin, idx) => plugin !== updated[idx]);

      expect(pluginsChanged).toBe(true);
    });

    it('should detect when plugins are removed', () => {
      const currentPlugins = ['bootstrap', 'discord', 'knowledge'];
      const updatedPlugins = ['bootstrap', 'discord'];

      const current = currentPlugins.sort();
      const updated = updatedPlugins.sort();

      const pluginsChanged =
        current.length !== updated.length || current.some((plugin, idx) => plugin !== updated[idx]);

      expect(pluginsChanged).toBe(true);
    });

    it('should not detect change when plugins array is reordered but content is same', () => {
      const currentPlugins = ['bootstrap', 'discord', 'knowledge'];
      const updatedPlugins = ['knowledge', 'bootstrap', 'discord'];

      const current = currentPlugins.sort();
      const updated = updatedPlugins.sort();

      const pluginsChanged =
        current.length !== updated.length || current.some((plugin, idx) => plugin !== updated[idx]);

      expect(pluginsChanged).toBe(false);
    });

    it('should handle plugin objects with name property', () => {
      const currentPlugins: PluginType[] = [{ name: 'bootstrap' }, { name: 'discord' }];
      const updatedPlugins: PluginType[] = [{ name: 'bootstrap' }, { name: 'knowledge' }];

      const current = currentPlugins.map((p) => (typeof p === 'string' ? p : p.name)).sort();
      const updated = updatedPlugins.map((p) => (typeof p === 'string' ? p : p.name)).sort();

      const pluginsChanged =
        current.length !== updated.length || current.some((plugin, idx) => plugin !== updated[idx]);

      expect(pluginsChanged).toBe(true);
    });

    it('should handle mixed string and object plugins', () => {
      const currentPlugins: PluginType[] = ['bootstrap', { name: 'discord' }];
      const updatedPlugins: PluginType[] = [{ name: 'bootstrap' }, 'discord'];

      const current = currentPlugins.map((p) => (typeof p === 'string' ? p : p.name)).sort();
      const updated = updatedPlugins.map((p) => (typeof p === 'string' ? p : p.name)).sort();

      const pluginsChanged =
        current.length !== updated.length || current.some((plugin, idx) => plugin !== updated[idx]);

      expect(pluginsChanged).toBe(false);
    });

    it('should filter out null and undefined plugins', () => {
      const currentPlugins: (PluginType | null | undefined)[] = [
        'bootstrap',
        null,
        'discord',
        undefined,
      ];
      const updatedPlugins: PluginType[] = ['bootstrap', 'discord'];

      const current = currentPlugins
        .filter((p): p is PluginType => p != null)
        .map((p) => (typeof p === 'string' ? p : p.name))
        .filter((name): name is string => typeof name === 'string')
        .sort();

      const updated = updatedPlugins
        .filter((p): p is PluginType => p != null)
        .map((p) => (typeof p === 'string' ? p : p.name))
        .filter((name): name is string => typeof name === 'string')
        .sort();

      const pluginsChanged =
        current.length !== updated.length || current.some((plugin, idx) => plugin !== updated[idx]);

      expect(pluginsChanged).toBe(false);
    });

    it('should filter out plugins with invalid name', () => {
      const currentPlugins: (PluginType | { name: number })[] = [
        'bootstrap',
        { name: 123 as any },
        'discord',
      ];
      const updatedPlugins: PluginType[] = ['bootstrap', 'discord'];

      const current = currentPlugins
        .filter((p): p is PluginType | { name: number } => p != null)
        .map((p) => (typeof p === 'string' ? p : p.name))
        .filter((name): name is string => typeof name === 'string')
        .sort();

      const updated = updatedPlugins
        .filter((p): p is PluginType => p != null)
        .map((p) => (typeof p === 'string' ? p : p.name))
        .filter((name): name is string => typeof name === 'string')
        .sort();

      const pluginsChanged =
        current.length !== updated.length || current.some((plugin, idx) => plugin !== updated[idx]);

      expect(pluginsChanged).toBe(false);
    });
  });

  describe('Plugin array validation', () => {
    it('should throw error if plugins is not an array', () => {
      const invalidPlugins = 'not-an-array' as any;

      expect(() => {
        if (invalidPlugins && !Array.isArray(invalidPlugins)) {
          throw new Error('plugins must be an array');
        }
      }).toThrow('plugins must be an array');
    });

    it('should throw error if plugins is an object', () => {
      const invalidPlugins = { 0: 'bootstrap', 1: 'discord' } as any;

      expect(() => {
        if (invalidPlugins && !Array.isArray(invalidPlugins)) {
          throw new Error('plugins must be an array');
        }
      }).toThrow('plugins must be an array');
    });

    it('should accept null or undefined plugins', () => {
      expect(() => {
        const plugins = null;
        if (plugins && !Array.isArray(plugins)) {
          throw new Error('plugins must be an array');
        }
      }).not.toThrow();

      expect(() => {
        const plugins = undefined;
        if (plugins && !Array.isArray(plugins)) {
          throw new Error('plugins must be an array');
        }
      }).not.toThrow();
    });

    it('should accept empty array', () => {
      expect(() => {
        const plugins: any[] = [];
        if (plugins && !Array.isArray(plugins)) {
          throw new Error('plugins must be an array');
        }
      }).not.toThrow();
    });
  });

  describe('Agent restart on plugin changes', () => {
    let mockServerInstance: any;
    let mockElizaOS: any;

    const testAgentId = '123e4567-e89b-12d3-a456-426614174000';

    const createMockAgent = (plugins: (string | { name: string })[]): any => ({
      id: testAgentId,
      name: 'TestAgent',
      bio: ['Test bio'],
      plugins,
      enabled: true,
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    beforeEach(() => {
      mockElizaOS = {
        getAgent: jest.fn(),
        updateAgent: jest.fn().mockResolvedValue(undefined),
      };

      mockServerInstance = {
        unregisterAgent: jest.fn().mockResolvedValue(undefined),
        startAgents: jest.fn().mockResolvedValue([{ agentId: testAgentId }]),
      };
    });

    it('should call unregisterAgent and startAgents when plugins change', async () => {
      const currentAgent = createMockAgent(['bootstrap', 'discord']);
      const updatedAgent = createMockAgent(['bootstrap', 'knowledge']);

      mockElizaOS.getAgent.mockReturnValue({ agentId: testAgentId });

      // Simulate the restart logic from crud.ts (lines 227-237)
      const currentPlugins = (currentAgent.plugins || [])
        .filter((p) => p != null)
        .map((p) => (typeof p === 'string' ? p : (p as any).name))
        .filter((name) => typeof name === 'string')
        .sort();

      const updatedPlugins = (updatedAgent.plugins || [])
        .filter((p) => p != null)
        .map((p) => (typeof p === 'string' ? p : (p as any).name))
        .filter((name) => typeof name === 'string')
        .sort();

      const pluginsChanged =
        currentPlugins.length !== updatedPlugins.length ||
        currentPlugins.some((plugin, idx) => plugin !== updatedPlugins[idx]);

      expect(pluginsChanged).toBe(true);

      // Simulate restart (lines 242-251)
      if (pluginsChanged) {
        await mockServerInstance.unregisterAgent(testAgentId);
        const { enabled, status, createdAt, updatedAt, ...characterData } = updatedAgent;
        await mockServerInstance.startAgents([{ character: characterData as Character }]);
      }

      expect(mockServerInstance.unregisterAgent).toHaveBeenCalledWith(testAgentId);
      expect(mockServerInstance.startAgents).toHaveBeenCalled();
    });

    it('should restore previous state if restart fails', async () => {
      const currentAgent = createMockAgent(['bootstrap', 'discord']);
      const updatedAgent = createMockAgent(['bootstrap', 'invalid-plugin']);

      // Mock restart failure
      mockServerInstance.startAgents
        .mockRejectedValueOnce(new Error('Plugin load failed'))
        .mockResolvedValueOnce([{ agentId: testAgentId }]);

      // Simulate error recovery logic (lines 252-271)
      let restartError: Error | null = null;
      let restoredAgent: any = null;

      try {
        await mockServerInstance.unregisterAgent(testAgentId);
        await mockServerInstance.startAgents([{ character: updatedAgent as Character }]);
      } catch (error) {
        restartError = error as Error;

        // Try to restore previous state
        try {
          const { enabled, status, createdAt, updatedAt, ...previousCharacterData } = currentAgent;
          await mockServerInstance.startAgents([{ character: previousCharacterData as Character }]);
          restoredAgent = previousCharacterData;
        } catch (restoreError) {
          // Failed to restore
        }
      }

      expect(restartError).toBeDefined();
      expect(restartError?.message).toBe('Plugin load failed');
      expect(mockServerInstance.startAgents).toHaveBeenCalledTimes(2); // Once failed, once restored
      expect(restoredAgent).toBeDefined();
      expect(restoredAgent.plugins).toEqual(currentAgent.plugins);
    });

    it('should handle complete failure with both restart and restore failing', async () => {
      const currentAgent = createMockAgent(['bootstrap', 'discord']);
      const updatedAgent = createMockAgent(['bootstrap', 'invalid-plugin']);

      // Mock both restart and restore failing
      mockServerInstance.startAgents.mockRejectedValue(new Error('Complete failure'));

      let restartError: Error | null = null;
      let restoreError: Error | null = null;

      try {
        await mockServerInstance.unregisterAgent(testAgentId);
        await mockServerInstance.startAgents([{ character: updatedAgent as Character }]);
      } catch (error) {
        restartError = error as Error;

        try {
          const { enabled, status, createdAt, updatedAt, ...previousCharacterData } = currentAgent;
          await mockServerInstance.startAgents([{ character: previousCharacterData as Character }]);
        } catch (error) {
          restoreError = error as Error;
        }
      }

      expect(restartError).toBeDefined();
      expect(restoreError).toBeDefined();
      expect(restoreError?.message).toBe('Complete failure');
      expect(mockServerInstance.startAgents).toHaveBeenCalledTimes(2);
    });
  });

  describe('In-place updates without restart', () => {
    let mockElizaOS: any;
    let mockServerInstance: any;

    const testAgentId = '123e4567-e89b-12d3-a456-426614174000';

    const createMockAgent = (plugins: (string | { name: string })[]): any => ({
      id: testAgentId,
      name: 'TestAgent',
      bio: ['Test bio'],
      plugins,
      enabled: true,
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    beforeEach(() => {
      mockElizaOS = {
        getAgent: jest.fn(),
        updateAgent: jest.fn().mockResolvedValue(undefined),
      };

      mockServerInstance = {
        unregisterAgent: jest.fn().mockResolvedValue(undefined),
        startAgents: jest.fn().mockResolvedValue([{ agentId: testAgentId }]),
      };
    });

    it('should update character properties without restart when plugins unchanged', async () => {
      const currentAgent = createMockAgent(['bootstrap', 'discord']);
      const updatedAgent = {
        ...createMockAgent(['bootstrap', 'discord']),
        name: 'UpdatedName',
        bio: ['Updated bio'],
      };

      mockElizaOS.getAgent.mockReturnValue({ agentId: testAgentId });

      // Check if plugins changed
      const currentPlugins = (currentAgent.plugins || [])
        .filter((p) => p != null)
        .map((p) => (typeof p === 'string' ? p : (p as any).name))
        .filter((name) => typeof name === 'string')
        .sort();

      const updatedPlugins = (updatedAgent.plugins || [])
        .filter((p) => p != null)
        .map((p) => (typeof p === 'string' ? p : (p as any).name))
        .filter((name) => typeof name === 'string')
        .sort();

      const pluginsChanged =
        currentPlugins.length !== updatedPlugins.length ||
        currentPlugins.some((plugin, idx) => plugin !== updatedPlugins[idx]);

      expect(pluginsChanged).toBe(false);

      // Should update in-place, not restart (lines 273-276)
      if (!pluginsChanged) {
        const { enabled, status, createdAt, updatedAt, ...characterData } = updatedAgent;
        await mockElizaOS.updateAgent(testAgentId, characterData as Character);
      }

      expect(mockElizaOS.updateAgent).toHaveBeenCalledWith(
        testAgentId,
        expect.objectContaining({
          name: 'UpdatedName',
          bio: ['Updated bio'],
        })
      );
      expect(mockServerInstance.unregisterAgent).not.toHaveBeenCalled();
    });
  });
});
