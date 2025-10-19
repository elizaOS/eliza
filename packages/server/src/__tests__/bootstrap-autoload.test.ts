import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { AgentServer } from '../index';
import type { Character } from '@elizaos/core';

describe('Bootstrap Auto-Loading', () => {
  let server: AgentServer;
  let originalIgnoreBootstrap: string | undefined;

  beforeEach(async () => {
    // Save original environment
    originalIgnoreBootstrap = process.env.IGNORE_BOOTSTRAP;
    delete process.env.IGNORE_BOOTSTRAP;

    // Create and initialize server instance
    server = new AgentServer();
    await server.start({ isTestMode: true }); // Initialize server in test mode
  });

  afterEach(async () => {
    // Restore environment
    if (originalIgnoreBootstrap === undefined) {
      delete process.env.IGNORE_BOOTSTRAP;
    } else {
      process.env.IGNORE_BOOTSTRAP = originalIgnoreBootstrap;
    }

    // Cleanup server
    if (server) {
      await server.stop();
    }
  });

  describe('Bootstrap Plugin Auto-Injection', () => {
    it('should automatically inject bootstrap plugin by default', async () => {
      const testCharacter: Character = {
        name: 'TestAgent',
        bio: ['Test agent for bootstrap injection'],
        plugins: [], // No plugins specified
      };

      const runtimes = await server.startAgents([{ character: testCharacter }], {
        isTestMode: true,
      });

      expect(runtimes).toHaveLength(1);
      const runtime = runtimes[0];

      // Verify bootstrap plugin is present
      const hasBootstrap = runtime.plugins.some((p) => p.name === 'bootstrap');
      expect(hasBootstrap).toBe(true);
    });

    it('should inject bootstrap before character plugins', async () => {
      const testCharacter: Character = {
        name: 'TestAgent',
        bio: ['Test agent'],
        plugins: ['@elizaos/plugin-openai'],
      };

      const runtimes = await server.startAgents([{ character: testCharacter }], {
        isTestMode: true,
      });

      const runtime = runtimes[0];
      const pluginNames = runtime.plugins.map((p) => p.name);

      const bootstrapIndex = pluginNames.indexOf('bootstrap');
      const openaiIndex = pluginNames.findIndex((name) => name.toLowerCase().includes('openai'));

      // Bootstrap should come before openai (if openai loaded successfully)
      if (openaiIndex !== -1) {
        expect(bootstrapIndex).toBeLessThan(openaiIndex);
      }
    });

    it('should not inject bootstrap when IGNORE_BOOTSTRAP is set', async () => {
      process.env.IGNORE_BOOTSTRAP = 'true';

      const testCharacter: Character = {
        name: 'TestAgent',
        bio: ['Test agent'],
        plugins: [],
      };

      const runtimes = await server.startAgents([{ character: testCharacter }], {
        isTestMode: true,
      });

      const runtime = runtimes[0];

      // Verify bootstrap plugin is NOT present
      const hasBootstrap = runtime.plugins.some((p) => p.name === 'bootstrap');
      expect(hasBootstrap).toBe(false);
    });

    it('should handle duplicate bootstrap gracefully', async () => {
      const testCharacter: Character = {
        name: 'TestAgent',
        bio: ['Test agent'],
        plugins: ['@elizaos/plugin-bootstrap'], // User explicitly added bootstrap
      };

      const runtimes = await server.startAgents([{ character: testCharacter }], {
        isTestMode: true,
      });

      const runtime = runtimes[0];

      // Count bootstrap plugins (should be deduplicated to 1)
      const bootstrapCount = runtime.plugins.filter((p) => p.name === 'bootstrap').length;
      expect(bootstrapCount).toBe(1);
    });
  });

  describe('SQL Plugin Auto-Injection', () => {
    it('should automatically inject SQL plugin', async () => {
      const testCharacter: Character = {
        name: 'TestAgent',
        bio: ['Test agent'],
        plugins: [],
      };

      const runtimes = await server.startAgents([{ character: testCharacter }], {
        isTestMode: true,
      });

      const runtime = runtimes[0];

      // Verify SQL plugin is present
      // Note: Plugin can be registered with either 'sql' (short name) or '@elizaos/plugin-sql' (full package name)
      const hasSQL = runtime.plugins.some(
        (p) => p.name === 'sql' || p.name === '@elizaos/plugin-sql'
      );
      expect(hasSQL).toBe(true);
    });

    it('should inject SQL after character plugins', async () => {
      const testCharacter: Character = {
        name: 'TestAgent',
        bio: ['Test agent'],
        plugins: ['@elizaos/plugin-openai'],
      };

      const runtimes = await server.startAgents([{ character: testCharacter }], {
        isTestMode: true,
      });

      const runtime = runtimes[0];
      const pluginNames = runtime.plugins.map((p) => p.name);

      // Plugin names can be either short ('sql') or full package name ('@elizaos/plugin-sql')
      const sqlIndex = pluginNames.findIndex(
        (name) => name === 'sql' || name === '@elizaos/plugin-sql'
      );
      const openaiIndex = pluginNames.findIndex((name) => name.toLowerCase().includes('openai'));

      // SQL should come after openai (if openai loaded successfully)
      if (openaiIndex !== -1 && sqlIndex !== -1) {
        expect(sqlIndex).toBeGreaterThan(openaiIndex);
      }
    });
  });

  describe('Plugin Injection Order', () => {
    it('should maintain correct plugin order: bootstrap -> character -> runtime -> SQL', async () => {
      const testCharacter: Character = {
        name: 'TestAgent',
        bio: ['Test agent'],
        plugins: ['@elizaos/plugin-openai'], // Character plugin
      };

      const runtimePlugin = {
        name: 'test-runtime-plugin',
        description: 'Test runtime plugin',
      };

      const runtimes = await server.startAgents(
        [
          {
            character: testCharacter,
            plugins: [runtimePlugin], // Runtime plugin
          },
        ],
        { isTestMode: true }
      );

      const runtime = runtimes[0];
      const pluginNames = runtime.plugins.map((p) => p.name);

      const bootstrapIndex = pluginNames.indexOf('bootstrap');
      const characterPluginIndex = pluginNames.findIndex((name) =>
        name.toLowerCase().includes('openai')
      );
      const runtimePluginIndex = pluginNames.indexOf('test-runtime-plugin');
      // Plugin names can be either short ('sql') or full package name ('@elizaos/plugin-sql')
      const sqlIndex = pluginNames.findIndex(
        (name) => name === 'sql' || name === '@elizaos/plugin-sql'
      );

      // Verify all plugins are present
      expect(bootstrapIndex).not.toBe(-1);
      expect(characterPluginIndex).not.toBe(-1);
      expect(runtimePluginIndex).not.toBe(-1);
      expect(sqlIndex).not.toBe(-1);

      // Verify correct order: bootstrap -> character -> runtime -> SQL
      expect(bootstrapIndex).toBe(0); // Bootstrap first
      expect(characterPluginIndex).toBeGreaterThan(bootstrapIndex); // Character after bootstrap
      expect(runtimePluginIndex).toBeGreaterThan(characterPluginIndex); // Runtime after character
      expect(sqlIndex).toBeGreaterThan(runtimePluginIndex); // SQL last
    });
  });

  describe('Multiple Agents', () => {
    it('should inject bootstrap and SQL for all agents', async () => {
      const agent1: Character = { name: 'Agent1', bio: ['Agent 1'], plugins: [] };
      const agent2: Character = { name: 'Agent2', bio: ['Agent 2'], plugins: [] };

      const runtimes = await server.startAgents([{ character: agent1 }, { character: agent2 }], {
        isTestMode: true,
      });

      expect(runtimes).toHaveLength(2);

      // Verify both agents have bootstrap and SQL
      for (const runtime of runtimes) {
        const hasBootstrap = runtime.plugins.some((p) => p.name === 'bootstrap');
        // Plugin names can be either short ('sql') or full package name ('@elizaos/plugin-sql')
        const hasSQL = runtime.plugins.some(
          (p) => p.name === 'sql' || p.name === '@elizaos/plugin-sql'
        );

        expect(hasBootstrap).toBe(true);
        expect(hasSQL).toBe(true);
      }
    });
  });
});
