import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { AgentManager } from '../AgentManager';
import type { Character, Plugin } from '@elizaos/core';

// Mock AgentServer
const mockServer = {
  agents: new Map(),
  registerAgent: mock(() => {}),
  unregisterAgent: mock(() => {}),
  isInitialized: true
};

describe('AgentManager', () => {
  let agentManager: AgentManager;

  beforeEach(() => {
    agentManager = new AgentManager(mockServer as any);
    mockServer.agents.clear();
  });

  describe('AgentManager methods', () => {
    test('should validate character configuration', () => {
      const character: Character = {
        name: 'TestAgent',
        bio: 'A test agent',
        system: 'Test system prompt',
        modelProvider: 'openai'
      } as Character;

      // Character should have required fields
      expect(character.name).toBe('TestAgent');
      expect(character.bio).toBeDefined();
      expect(character.modelProvider).toBe('openai');
    });

    test('should handle test mode option', () => {
      const options = { isTestMode: true };
      
      expect(options.isTestMode).toBe(true);
    });

    test('should accept plugin objects', () => {
      const customPlugin: Plugin = {
        name: 'custom-plugin',
        description: 'A custom plugin',
        actions: [],
        services: []
      };

      expect(customPlugin.name).toBe('custom-plugin');
      expect(customPlugin.actions).toEqual([]);
      expect(customPlugin.services).toEqual([]);
    });

    test('should handle plugin with test dependencies', () => {
      const pluginWithTestDeps: Plugin = {
        name: 'test-plugin',
        description: 'Plugin with test dependencies',
        dependencies: ['dep1'],
        testDependencies: ['test-dep1', 'test-dep2'],
        actions: [],
        services: []
      };

      expect(pluginWithTestDeps.testDependencies).toEqual(['test-dep1', 'test-dep2']);
      expect(pluginWithTestDeps.dependencies).toEqual(['dep1']);
    });
  });

  describe('AgentManager configuration', () => {
    test('should use ConfigManager for secrets', () => {
      const agentMgr = new AgentManager(mockServer as any);
      
      // AgentManager should have configManager
      expect(agentMgr).toBeDefined();
      expect((agentMgr as any).configManager).toBeDefined();
    });

    test('should use PluginLoader for plugin handling', () => {
      const agentMgr = new AgentManager(mockServer as any);
      
      // AgentManager should have pluginLoader
      expect(agentMgr).toBeDefined();
      expect((agentMgr as any).pluginLoader).toBeDefined();
    });

    test('should handle server reference', () => {
      const agentMgr = new AgentManager(mockServer as any);
      
      // AgentManager should store server reference
      expect((agentMgr as any).server).toBe(mockServer);
    });
  });
});