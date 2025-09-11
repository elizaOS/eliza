import { describe, test, expect, beforeEach } from 'bun:test';
import { ElizaOS, type ElizaOSConfig } from '../ElizaOS';
import type { Character, Plugin } from '@elizaos/core';

describe('ElizaOS', () => {
  describe('constructor', () => {
    test('should create instance with default config', () => {
      const eliza = new ElizaOS();
      
      expect(eliza).toBeDefined();
      expect((eliza as any).config).toBeDefined();
    });

    test('should create instance with custom config', () => {
      const config: ElizaOSConfig = {
        port: 8080,
        dataDir: '/custom/data',
        postgresUrl: 'postgres://localhost/test'
      };

      const eliza = new ElizaOS(config);
      
      expect(eliza).toBeDefined();
      expect((eliza as any).config).toEqual(config);
    });

    test('should accept characters in config', () => {
      const character: Character = {
        name: 'TestCharacter',
        bio: 'A test character',
        system: 'Test system'
      } as Character;

      const config: ElizaOSConfig = {
        characters: [character]
      };

      const eliza = new ElizaOS(config);
      
      expect((eliza as any).config.characters).toHaveLength(1);
      expect((eliza as any).config.characters[0].name).toBe('TestCharacter');
    });

    test('should accept plugins in config', () => {
      const plugin: Plugin = {
        name: 'test-plugin',
        description: 'Test plugin',
        actions: [],
        services: []
      };

      const config: ElizaOSConfig = {
        plugins: [plugin, '@elizaos/plugin-bootstrap']
      };

      const eliza = new ElizaOS(config);
      
      expect((eliza as any).config.plugins).toHaveLength(2);
      expect((eliza as any).config.plugins[0]).toBe(plugin);
      expect((eliza as any).config.plugins[1]).toBe('@elizaos/plugin-bootstrap');
    });
  });

  describe('ElizaOS components', () => {
    test('should have AgentManager', () => {
      const eliza = new ElizaOS();
      
      expect((eliza as any).agentManager).toBeDefined();
    });

    test('should have ConfigManager', () => {
      const eliza = new ElizaOS();
      
      expect((eliza as any).configManager).toBeDefined();
    });

    test('should have AgentServer', () => {
      const eliza = new ElizaOS();
      
      expect((eliza as any).server).toBeDefined();
    });

    test('should maintain agents map', () => {
      const eliza = new ElizaOS();
      
      expect((eliza as any).agents).toBeDefined();
      expect((eliza as any).agents).toBeInstanceOf(Map);
    });
  });

  describe('ElizaOS configuration scenarios', () => {
    test('should handle empty configuration', () => {
      const eliza = new ElizaOS({});
      
      expect(eliza).toBeDefined();
      expect((eliza as any).config).toEqual({});
    });

    test('should handle port configuration', () => {
      const eliza = new ElizaOS({ port: 3001 });
      
      expect((eliza as any).config.port).toBe(3001);
    });

    test('should handle database configuration', () => {
      const config: ElizaOSConfig = {
        dataDir: '/data/eliza',
        postgresUrl: 'postgres://user:pass@host/db'
      };

      const eliza = new ElizaOS(config);
      
      expect((eliza as any).config.dataDir).toBe('/data/eliza');
      expect((eliza as any).config.postgresUrl).toBe('postgres://user:pass@host/db');
    });

    test('should handle multiple characters', () => {
      const char1: Character = {
        name: 'Agent1',
        bio: 'First agent'
      } as Character;

      const char2: Character = {
        name: 'Agent2', 
        bio: 'Second agent'
      } as Character;

      const config: ElizaOSConfig = {
        characters: [char1, char2]
      };

      const eliza = new ElizaOS(config);
      
      expect((eliza as any).config.characters).toHaveLength(2);
      expect((eliza as any).config.characters[0].name).toBe('Agent1');
      expect((eliza as any).config.characters[1].name).toBe('Agent2');
    });

    test('should handle mixed plugin types', () => {
      const customPlugin: Plugin = {
        name: 'custom',
        description: 'Custom plugin',
        actions: [],
        services: []
      };

      const config: ElizaOSConfig = {
        plugins: [
          customPlugin,
          '@elizaos/plugin-bootstrap',
          '@elizaos/plugin-sql'
        ]
      };

      const eliza = new ElizaOS(config);
      
      expect((eliza as any).config.plugins).toHaveLength(3);
      expect((eliza as any).config.plugins[0]).toBe(customPlugin);
      expect((eliza as any).config.plugins[1]).toBe('@elizaos/plugin-bootstrap');
      expect((eliza as any).config.plugins[2]).toBe('@elizaos/plugin-sql');
    });
  });
});