import { describe, expect, it, beforeAll, afterAll, spyOn } from 'bun:test';
import plugin from '../plugin';
import { logger } from '@elizaos/core';

describe('Plugin Events', () => {
  // Use spyOn like all other tests in the codebase
  beforeAll(() => {
    spyOn(logger, 'info');
    spyOn(logger, 'error');
    spyOn(logger, 'warn');
    spyOn(logger, 'debug');
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

      // Verify logger was called with correct Pino-style structured logging
      expect(logger.info).toHaveBeenCalledWith('MESSAGE_RECEIVED event received');
      expect(logger.info).toHaveBeenCalledWith(
        { keys: expect.any(Array) },
        'MESSAGE_RECEIVED param keys'
      );
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

      // Verify logger was called with correct Pino-style structured logging
      expect(logger.info).toHaveBeenCalledWith('VOICE_MESSAGE_RECEIVED event received');
      expect(logger.info).toHaveBeenCalledWith(
        { keys: expect.any(Array) },
        'VOICE_MESSAGE_RECEIVED param keys'
      );
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

      // Verify logger was called with correct Pino-style structured logging
      expect(logger.info).toHaveBeenCalledWith('WORLD_CONNECTED event received');
      expect(logger.info).toHaveBeenCalledWith(
        { keys: expect.any(Array) },
        'WORLD_CONNECTED param keys'
      );
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

      // Verify logger was called with correct Pino-style structured logging
      expect(logger.info).toHaveBeenCalledWith('WORLD_JOINED event received');
      expect(logger.info).toHaveBeenCalledWith(
        { keys: expect.any(Array) },
        'WORLD_JOINED param keys'
      );
    }
  });
});
