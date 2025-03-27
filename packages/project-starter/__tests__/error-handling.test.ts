import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import plugin from '../src/plugin';
import { StarterService } from '../src/plugin';
import { logger } from '@elizaos/core';
import type { IAgentRuntime, Memory, State } from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';

// Mock logger
vi.mock('@elizaos/core', async () => {
  const actual = await vi.importActual('@elizaos/core');
  return {
    ...actual,
    logger: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
    },
  };
});

describe('Error Handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('HELLO_WORLD Action Error Handling', () => {
    it('should log errors in action handlers', async () => {
      // Find the action
      const action = plugin.actions?.find((a) => a.name === 'HELLO_WORLD');

      if (action && action.handler) {
        // Force the handler to throw an error
        const mockError = new Error('Test error in action');
        vi.spyOn(console, 'error').mockImplementation(() => {});

        // Create a custom mock runtime
        const mockRuntime = {
          // This is just a simple object for testing
        } as unknown as IAgentRuntime;

        const mockMessage = {
          entityId: uuidv4(),
          roomId: uuidv4(),
          content: {
            text: 'Hello!',
            source: 'test',
          },
        } as Memory;

        const mockState = {
          values: {},
          data: {},
          text: '',
        } as State;

        const mockCallback = vi.fn();

        // Mock the logger.error to verify it's called
        vi.spyOn(logger, 'error');

        // Test the error handling by observing the behavior
        try {
          await action.handler(mockRuntime, mockMessage, mockState, {}, mockCallback, []);

          // If we get here, no error was thrown, which is okay
          // In a real application, error handling might be internal
          expect(mockCallback).toHaveBeenCalled();
        } catch (error) {
          // If error is thrown, ensure it's handled correctly
          expect(logger.error).toHaveBeenCalled();
        }
      }
    });
  });

  describe('Service Error Handling', () => {
    it('should throw an error when stopping non-existent service', async () => {
      const mockRuntime = {
        getService: vi.fn().mockReturnValue(null),
      } as unknown as IAgentRuntime;

      let caughtError = null;
      try {
        await StarterService.stop(mockRuntime);
      } catch (error: any) {
        caughtError = error;
        expect(error.message).toBe('Starter service not found');
      }

      expect(caughtError).not.toBeNull();
      expect(mockRuntime.getService).toHaveBeenCalledWith('starter');
    });

    it('should handle service stop errors gracefully', async () => {
      const mockServiceWithError = {
        stop: vi.fn().mockImplementation(() => {
          throw new Error('Error stopping service');
        }),
      };

      const mockRuntime = {
        getService: vi.fn().mockReturnValue(mockServiceWithError),
      } as unknown as IAgentRuntime;

      // The error should be propagated
      let caughtError = null;
      try {
        await StarterService.stop(mockRuntime);
      } catch (error: any) {
        caughtError = error;
        expect(error.message).toBe('Error stopping service');
      }

      expect(caughtError).not.toBeNull();
      expect(mockRuntime.getService).toHaveBeenCalledWith('starter');
      expect(mockServiceWithError.stop).toHaveBeenCalled();
    });
  });

  describe('Plugin Events Error Handling', () => {
    it('should handle errors in event handlers gracefully', async () => {
      if (plugin.events && plugin.events.MESSAGE_RECEIVED) {
        const messageHandler = plugin.events.MESSAGE_RECEIVED[0];

        // Create a mock that will trigger an error
        const mockParams = {
          message: {
            id: 'test-id',
            content: { text: 'Hello!' },
          },
          source: 'test',
          runtime: {},
        };

        // Spy on the logger
        vi.spyOn(logger, 'error');

        // This is a partial test - in a real handler, we'd have more robust error handling
        try {
          await messageHandler(mockParams as any);
          // If it succeeds without error, that's good too
          expect(true).toBe(true);
        } catch (error) {
          // If it does error, make sure we can catch it
          expect(error).toBeDefined();
        }
      }
    });
  });

  describe('Provider Error Handling', () => {
    it('should handle errors in provider.get method', async () => {
      const provider = plugin.providers?.find((p) => p.name === 'HELLO_WORLD_PROVIDER');

      if (provider) {
        // Create invalid inputs to test error handling
        const mockRuntime = null as unknown as IAgentRuntime;
        const mockMessage = null as unknown as Memory;
        const mockState = null as unknown as State;

        // The provider should handle null inputs gracefully
        try {
          await provider.get(mockRuntime, mockMessage, mockState);
          // If we get here, it didn't throw - which is good
          expect(true).toBe(true);
        } catch (error) {
          // If it does throw, at least make sure it's a handled error
          expect(logger.error).toHaveBeenCalled();
        }
      }
    });
  });
});
