import { describe, expect, it, beforeEach, mock } from 'bun:test';
import plugin from '../plugin';
import { logger } from '@elizaos/core';

// Mock logger
mock.module('@elizaos/core', () => {
  const actual = require('@elizaos/core');
  return {
    ...actual,
    logger: {
      info: mock(),
      error: mock(),
    },
  };
});

describe('Plugin Events', () => {
  beforeEach(() => {
    mock.restore();
  });

  it('should have events defined', () => {
    expect(plugin.events).toBeDefined();
    if (plugin.events) {
      expect(Object.keys(plugin.events).length).toBeGreaterThan(0);
    }
  });

  it('should handle MESSAGE_RECEIVED event', async () => {
    if (plugin.events && plugin.events.MESSAGE_RECEIVED) {
      expect(Array.isArray(plugin.events.MESSAGE_RECEIVED)).toBe(true);
      expect(plugin.events.MESSAGE_RECEIVED.length).toBeGreaterThan(0);

      const messageHandler = plugin.events.MESSAGE_RECEIVED[0];
      expect(typeof messageHandler).toBe('function');

      // Use any type to bypass strict type checking for testing
      const mockParams: any = {
        message: {
          id: 'test-id',
          content: { text: 'Hello!' },
        },
        source: 'test',
        runtime: {},
      };

      // Call the event handler
      await messageHandler(mockParams);

      // Verify log was called
      expect(logger.info).toHaveBeenCalledWith('MESSAGE_RECEIVED event received');
      expect(logger.info).toHaveBeenCalledWith(expect.any(Array));
    }
  });

  it('should handle VOICE_MESSAGE_RECEIVED event', async () => {
    if (plugin.events && plugin.events.VOICE_MESSAGE_RECEIVED) {
      expect(Array.isArray(plugin.events.VOICE_MESSAGE_RECEIVED)).toBe(true);
      expect(plugin.events.VOICE_MESSAGE_RECEIVED.length).toBeGreaterThan(0);

      const voiceHandler = plugin.events.VOICE_MESSAGE_RECEIVED[0];
      expect(typeof voiceHandler).toBe('function');

      // Use any type to bypass strict type checking for testing
      const mockParams: any = {
        message: {
          id: 'test-id',
          content: { text: 'Voice message!' },
        },
        source: 'test',
        runtime: {},
      };

      // Call the event handler
      await voiceHandler(mockParams);

      // Verify log was called
      expect(logger.info).toHaveBeenCalledWith('VOICE_MESSAGE_RECEIVED event received');
      expect(logger.info).toHaveBeenCalledWith(expect.any(Array));
    }
  });

  it('should handle WORLD_CONNECTED event', async () => {
    if (plugin.events && plugin.events.WORLD_CONNECTED) {
      expect(Array.isArray(plugin.events.WORLD_CONNECTED)).toBe(true);
      expect(plugin.events.WORLD_CONNECTED.length).toBeGreaterThan(0);

      const connectedHandler = plugin.events.WORLD_CONNECTED[0];
      expect(typeof connectedHandler).toBe('function');

      // Use any type to bypass strict type checking for testing
      const mockParams: any = {
        world: {
          id: 'test-world-id',
          name: 'Test World',
        },
        rooms: [],
        entities: [],
        source: 'test',
        runtime: {},
      };

      // Call the event handler
      await connectedHandler(mockParams);

      // Verify log was called
      expect(logger.info).toHaveBeenCalledWith('WORLD_CONNECTED event received');
      expect(logger.info).toHaveBeenCalledWith(expect.any(Array));
    }
  });

  it('should handle WORLD_JOINED event', async () => {
    if (plugin.events && plugin.events.WORLD_JOINED) {
      expect(Array.isArray(plugin.events.WORLD_JOINED)).toBe(true);
      expect(plugin.events.WORLD_JOINED.length).toBeGreaterThan(0);

      const joinedHandler = plugin.events.WORLD_JOINED[0];
      expect(typeof joinedHandler).toBe('function');

      // Use any type to bypass strict type checking for testing
      const mockParams: any = {
        world: {
          id: 'test-world-id',
          name: 'Test World',
        },
        entity: {
          id: 'test-entity-id',
          name: 'Test Entity',
        },
        rooms: [],
        entities: [],
        source: 'test',
        runtime: {},
      };

      // Call the event handler
      await joinedHandler(mockParams);

      // Verify log was called
      expect(logger.info).toHaveBeenCalledWith('WORLD_JOINED event received');
      expect(logger.info).toHaveBeenCalledWith(expect.any(Array));
    }
  });
});
