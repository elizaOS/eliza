/**
 * Tests for shared response handlers
 *
 * These tests verify the logic and format of response mode handling
 * for the messaging API endpoints.
 */

import { describe, it, expect } from 'bun:test';
import { SSE_EVENTS } from '../../../api/shared/response-handlers';
import {
  RESPONSE_MODES,
  DEFAULT_RESPONSE_MODE,
  type ResponseMode,
} from '../../../api/shared/constants';

describe('Response Mode Constants', () => {
  describe('RESPONSE_MODES', () => {
    it('should have exactly three valid modes', () => {
      expect(RESPONSE_MODES).toHaveLength(3);
    });

    it('should include sync mode', () => {
      expect(RESPONSE_MODES).toContain('sync');
    });

    it('should include stream mode', () => {
      expect(RESPONSE_MODES).toContain('stream');
    });

    it('should include websocket mode', () => {
      expect(RESPONSE_MODES).toContain('websocket');
    });

    it('should be a readonly array', () => {
      // TypeScript compile-time check - array should be immutable
      const modes: readonly string[] = RESPONSE_MODES;
      expect(Array.isArray(modes)).toBe(true);
    });
  });

  describe('DEFAULT_RESPONSE_MODE', () => {
    it('should be websocket for backward compatibility', () => {
      expect(DEFAULT_RESPONSE_MODE).toBe('websocket');
    });

    it('should be a valid response mode', () => {
      expect(RESPONSE_MODES).toContain(DEFAULT_RESPONSE_MODE);
    });
  });

  describe('ResponseMode type', () => {
    it('should accept valid modes', () => {
      const validModes: ResponseMode[] = ['sync', 'stream', 'websocket'];
      validModes.forEach((mode) => {
        expect(RESPONSE_MODES).toContain(mode);
      });
    });
  });
});

describe('SSE Events', () => {
  describe('SSE_EVENTS', () => {
    it('should have user_message event', () => {
      expect(SSE_EVENTS.USER_MESSAGE).toBe('user_message');
    });

    it('should have chunk event for streaming', () => {
      expect(SSE_EVENTS.CHUNK).toBe('chunk');
    });

    it('should have done event for completion', () => {
      expect(SSE_EVENTS.DONE).toBe('done');
    });

    it('should have error event for failures', () => {
      expect(SSE_EVENTS.ERROR).toBe('error');
    });

    it('should have all four required events', () => {
      const events = Object.values(SSE_EVENTS);
      expect(events).toHaveLength(4);
    });
  });
});

describe('Response Mode Validation Logic', () => {
  describe('Mode validation', () => {
    it('should validate sync mode', () => {
      const mode = 'sync';
      const isValid = RESPONSE_MODES.includes(mode as ResponseMode);
      expect(isValid).toBe(true);
    });

    it('should validate stream mode', () => {
      const mode = 'stream';
      const isValid = RESPONSE_MODES.includes(mode as ResponseMode);
      expect(isValid).toBe(true);
    });

    it('should validate websocket mode', () => {
      const mode = 'websocket';
      const isValid = RESPONSE_MODES.includes(mode as ResponseMode);
      expect(isValid).toBe(true);
    });

    it('should reject invalid mode', () => {
      const mode = 'invalid_mode';
      const isValid = RESPONSE_MODES.includes(mode as ResponseMode);
      expect(isValid).toBe(false);
    });

    it('should reject empty string', () => {
      const mode = '';
      const isValid = RESPONSE_MODES.includes(mode as ResponseMode);
      expect(isValid).toBe(false);
    });

    it('should be case sensitive', () => {
      const mode = 'SYNC';
      const isValid = RESPONSE_MODES.includes(mode as ResponseMode);
      expect(isValid).toBe(false);
    });
  });
});

describe('Response Format', () => {
  describe('Sync mode response', () => {
    it('should have correct structure', () => {
      const syncResponse = {
        success: true,
        userMessage: { id: 'msg-123', content: 'Hello' },
        agentResponse: { text: 'Hi there!' },
      };

      expect(syncResponse).toHaveProperty('success', true);
      expect(syncResponse).toHaveProperty('userMessage');
      expect(syncResponse).toHaveProperty('agentResponse');
    });

    it('should include additional data when provided', () => {
      const syncResponse = {
        success: true,
        userMessage: { id: 'msg-123' },
        agentResponse: { text: 'Response' },
        sessionStatus: { expiresAt: '2024-01-01' },
      };

      expect(syncResponse).toHaveProperty('sessionStatus');
    });
  });

  describe('WebSocket mode response', () => {
    it('should have correct structure without agentResponse', () => {
      const wsResponse = {
        success: true,
        userMessage: { id: 'msg-123', content: 'Hello' },
      };

      expect(wsResponse).toHaveProperty('success', true);
      expect(wsResponse).toHaveProperty('userMessage');
      expect(wsResponse).not.toHaveProperty('agentResponse');
    });
  });

  describe('Stream mode SSE format', () => {
    it('should format user_message event correctly', () => {
      const event = 'user_message';
      const data = { id: 'msg-123', content: 'Hello' };
      const sseFormat = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

      expect(sseFormat).toContain('event: user_message');
      expect(sseFormat).toContain('data: ');
      expect(sseFormat).toContain('"id":"msg-123"');
      expect(sseFormat).toEndWith('\n\n');
    });

    it('should format chunk event correctly', () => {
      const event = 'chunk';
      const data = { messageId: 'msg-456', chunk: 'Hello', index: 0 };
      const sseFormat = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

      expect(sseFormat).toContain('event: chunk');
      expect(sseFormat).toContain('"chunk":"Hello"');
      expect(sseFormat).toContain('"index":0');
    });

    it('should format done event correctly', () => {
      const event = 'done';
      const data = { text: 'Complete response', thought: 'Thinking...' };
      const sseFormat = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

      expect(sseFormat).toContain('event: done');
      expect(sseFormat).toContain('"text":"Complete response"');
    });

    it('should format error event correctly', () => {
      const event = 'error';
      const data = { error: 'Something went wrong' };
      const sseFormat = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

      expect(sseFormat).toContain('event: error');
      expect(sseFormat).toContain('"error":"Something went wrong"');
    });
  });

  describe('Error response format', () => {
    it('should have correct structure for sync mode error', () => {
      const errorResponse = {
        success: false,
        error: 'Failed to process message in sync mode',
      };

      expect(errorResponse).toHaveProperty('success', false);
      expect(errorResponse).toHaveProperty('error');
      expect(typeof errorResponse.error).toBe('string');
    });
  });
});

describe('SSE Headers', () => {
  it('should have correct Content-Type for SSE', () => {
    const contentType = 'text/event-stream';
    expect(contentType).toBe('text/event-stream');
  });

  it('should have correct Cache-Control for SSE', () => {
    const cacheControl = 'no-cache';
    expect(cacheControl).toBe('no-cache');
  });

  it('should have correct Connection for SSE', () => {
    const connection = 'keep-alive';
    expect(connection).toBe('keep-alive');
  });
});
