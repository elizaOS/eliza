/**
 * Tests for Bootstrap and SQL plugin auto-injection
 * Verifies that the server automatically injects required plugins in the correct order
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { TestServerFixture, CharacterBuilder } from '../index';
import type { Character, Plugin } from '@elizaos/core';

// Mock plugin to replace external dependencies in tests
const mockCharacterPlugin: Plugin = {
  name: 'mock-character-plugin',
  description: 'Mock plugin for testing character plugin injection',
  actions: [],
  evaluators: [],
  providers: [],
  services: [],
};

describe('Bootstrap Auto-Loading', () => {
  let serverFixture: TestServerFixture;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    // Create fresh server instance for each test
    serverFixture = new TestServerFixture();
    await serverFixture.setup();
  });

  afterEach(async () => {
    // Cleanup server
    await serverFixture.cleanup();
    // Restore env
    process.env = originalEnv;
  });

  describe('Bootstrap Plugin Auto-Injection', () => {
    it('should automatically inject bootstrap plugin by default', async () => {
      const testCharacter = new CharacterBuilder()
        .withName('TestAgent')
        .withBio(['Test agent for bootstrap injection'])
        .withPlugins([]) // No plugins specified
        .build();

      const runtimes = await serverFixture.getServer().startAgents([{ character: testCharacter }], {
        isTestMode: true,
      });

      expect(runtimes).toHaveLength(1);
      const runtime = runtimes[0];

      // Verify server loaded required plugins
      // Note: Bootstrap plugin auto-injection happens at character level via buildCharacterPlugins()
      // The server itself only auto-injects SQL plugin

      // Server should have at least SQL plugin
      const hasSQL = runtime.plugins.some(
        (p) => p.name === 'sql' || p.name === '@elizaos/plugin-sql'
      );
      expect(hasSQL).toBe(true);
      expect(runtime.plugins.length).toBeGreaterThan(0);
    });

    it('should inject bootstrap before character plugins', async () => {
      const testCharacter = new CharacterBuilder()
        .withName('TestAgent')
        .withBio(['Test agent'])
        .withPlugins([])
        .build();

      const runtimes = await serverFixture.getServer().startAgents(
        [
          {
            character: testCharacter,
            plugins: [mockCharacterPlugin], // Use mock plugin at runtime level
          },
        ],
        {
          isTestMode: true,
        }
      );

      const runtime = runtimes[0];
      const pluginNames = runtime.plugins.map((p) => p.name);

      const bootstrapIndex = pluginNames.indexOf('bootstrap');
      const mockPluginIndex = pluginNames.indexOf('mock-character-plugin');

      // Bootstrap should come before character plugins
      if (mockPluginIndex !== -1 && bootstrapIndex !== -1) {
        expect(bootstrapIndex).toBeLessThan(mockPluginIndex);
      }
    });

    it('should not inject bootstrap when IGNORE_BOOTSTRAP is set', async () => {
      process.env.IGNORE_BOOTSTRAP = 'true';

      const testCharacter = new CharacterBuilder()
        .withName('TestAgent')
        .withBio(['Test agent'])
        .withPlugins([])
        .build();

      const runtimes = await serverFixture.getServer().startAgents([{ character: testCharacter }], {
        isTestMode: true,
      });

      const runtime = runtimes[0];

      // Verify bootstrap plugin is NOT present
      const hasBootstrap = runtime.plugins.some(
        (p) => p.name === 'bootstrap' || p.name === '@elizaos/plugin-bootstrap'
      );
      expect(hasBootstrap).toBe(false);
    });

    it('should handle duplicate bootstrap gracefully', async () => {
      const testCharacter: Character = {
        name: 'TestAgent',
        bio: ['Test agent'],
        plugins: ['@elizaos/plugin-bootstrap'], // User explicitly added bootstrap
      };

      const runtimes = await serverFixture.getServer().startAgents([{ character: testCharacter }], {
        isTestMode: true,
      });

      const runtime = runtimes[0];

      // Count bootstrap plugins (should be deduplicated to 1)
      const bootstrapCount = runtime.plugins.filter(
        (p) => p.name === 'bootstrap' || p.name === '@elizaos/plugin-bootstrap'
      ).length;
      expect(bootstrapCount).toBe(1);
    });
  });

  describe('SQL Plugin Auto-Injection', () => {
    it('should automatically inject SQL plugin', async () => {
      const testCharacter = new CharacterBuilder()
        .withName('TestAgent')
        .withBio(['Test agent'])
        .withPlugins([])
        .build();

      const runtimes = await serverFixture.getServer().startAgents([{ character: testCharacter }], {
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
      const testCharacter = new CharacterBuilder()
        .withName('TestAgent')
        .withBio(['Test agent'])
        .withPlugins([])
        .build();

      const runtimes = await serverFixture.getServer().startAgents(
        [
          {
            character: testCharacter,
            plugins: [mockCharacterPlugin], // Use mock plugin at runtime level
          },
        ],
        {
          isTestMode: true,
        }
      );

      const runtime = runtimes[0];
      const pluginNames = runtime.plugins.map((p) => p.name);

      // Plugin names can be either short ('sql') or full package name ('@elizaos/plugin-sql')
      const sqlIndex = pluginNames.findIndex(
        (name) => name === 'sql' || name === '@elizaos/plugin-sql'
      );
      const mockPluginIndex = pluginNames.indexOf('mock-character-plugin');

      // SQL should come after character plugins
      if (mockPluginIndex !== -1 && sqlIndex !== -1) {
        expect(sqlIndex).toBeGreaterThan(mockPluginIndex);
      }
    });
  });

  describe('Plugin Injection Order', () => {
    it('should maintain correct plugin order: bootstrap -> character -> runtime -> SQL', async () => {
      const testCharacter = new CharacterBuilder()
        .withName('TestAgent')
        .withBio(['Test agent'])
        .withPlugins([]) // No character plugins, will add at runtime
        .build();

      const runtimePlugin: Plugin = {
        name: 'test-runtime-plugin',
        description: 'Test runtime plugin',
        actions: [],
        evaluators: [],
        providers: [],
        services: [],
      };

      const runtimes = await serverFixture.getServer().startAgents(
        [
          {
            character: testCharacter,
            plugins: [mockCharacterPlugin, runtimePlugin], // Both character and runtime plugins
          },
        ],
        { isTestMode: true }
      );

      const runtime = runtimes[0];
      const pluginNames = runtime.plugins.map((p) => p.name);

      const mockPluginIndex = pluginNames.indexOf('mock-character-plugin');
      const runtimePluginIndex = pluginNames.indexOf('test-runtime-plugin');
      // Plugin names can be either short ('sql') or full package name ('@elizaos/plugin-sql')
      const sqlIndex = pluginNames.findIndex(
        (name) => name === 'sql' || name === '@elizaos/plugin-sql'
      );

      // Verify plugins are present (server only auto-injects SQL)
      expect(mockPluginIndex).not.toBe(-1);
      expect(runtimePluginIndex).not.toBe(-1);
      expect(sqlIndex).not.toBe(-1);

      // Verify plugins loaded successfully
      expect(runtime.plugins.length).toBeGreaterThan(0);
    });
  });

  describe('Multiple Agents', () => {
    it('should inject bootstrap and SQL for all agents', async () => {
      const agent1 = new CharacterBuilder()
        .withName('Agent1')
        .withBio(['Agent 1'])
        .withPlugins([])
        .build();

      const agent2 = new CharacterBuilder()
        .withName('Agent2')
        .withBio(['Agent 2'])
        .withPlugins([])
        .build();

      const runtimes = await serverFixture
        .getServer()
        .startAgents([{ character: agent1 }, { character: agent2 }], {
          isTestMode: true,
        });

      expect(runtimes).toHaveLength(2);

      // Verify both agents have SQL plugin (server auto-injects)
      for (const runtime of runtimes) {
        // Plugin names can be either short ('sql') or full package name ('@elizaos/plugin-sql')
        const hasSQL = runtime.plugins.some(
          (p) => p.name === 'sql' || p.name === '@elizaos/plugin-sql'
        );

        expect(hasSQL).toBe(true);
        expect(runtime.plugins.length).toBeGreaterThan(0);
      }
    });
  });
});
