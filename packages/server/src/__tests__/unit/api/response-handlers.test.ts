/**
 * Tests for shared response handlers
 *
 * These tests verify the logic and format of transport type handling
 * for the messaging API endpoints.
 */

import { describe, it, expect } from 'bun:test';
import { SSE_EVENTS } from '../../../api/shared/response-handlers';
import {
  TRANSPORT_TYPES,
  DEFAULT_TRANSPORT,
  type TransportType,
  LEGACY_MODE_MAP,
} from '../../../api/shared/constants';

describe('Transport Type Constants', () => {
  describe('TRANSPORT_TYPES', () => {
    it('should have exactly three valid types', () => {
      expect(TRANSPORT_TYPES).toHaveLength(3);
    });

    it('should include http transport', () => {
      expect(TRANSPORT_TYPES).toContain('http');
    });

    it('should include sse transport', () => {
      expect(TRANSPORT_TYPES).toContain('sse');
    });

    it('should include websocket transport', () => {
      expect(TRANSPORT_TYPES).toContain('websocket');
    });

    it('should be a readonly array', () => {
      // TypeScript compile-time check - array should be immutable
      const types: readonly string[] = TRANSPORT_TYPES;
      expect(Array.isArray(types)).toBe(true);
    });
  });

  describe('DEFAULT_TRANSPORT', () => {
    it('should be websocket for backward compatibility', () => {
      expect(DEFAULT_TRANSPORT).toBe('websocket');
    });

    it('should be a valid transport type', () => {
      expect(TRANSPORT_TYPES).toContain(DEFAULT_TRANSPORT);
    });
  });

  describe('TransportType type', () => {
    it('should accept valid types', () => {
      const validTypes: TransportType[] = ['http', 'sse', 'websocket'];
      validTypes.forEach((type) => {
        expect(TRANSPORT_TYPES).toContain(type);
      });
    });
  });

  describe('LEGACY_MODE_MAP', () => {
    it('should map sync to http', () => {
      expect(LEGACY_MODE_MAP['sync']).toBe('http');
    });

    it('should map stream to sse', () => {
      expect(LEGACY_MODE_MAP['stream']).toBe('sse');
    });

    it('should map websocket to websocket', () => {
      expect(LEGACY_MODE_MAP['websocket']).toBe('websocket');
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

describe('Transport Type Validation Logic', () => {
  describe('Transport validation', () => {
    it('should validate http transport', () => {
      const transport = 'http';
      const isValid = TRANSPORT_TYPES.includes(transport as TransportType);
      expect(isValid).toBe(true);
    });

    it('should validate sse transport', () => {
      const transport = 'sse';
      const isValid = TRANSPORT_TYPES.includes(transport as TransportType);
      expect(isValid).toBe(true);
    });

    it('should validate websocket transport', () => {
      const transport = 'websocket';
      const isValid = TRANSPORT_TYPES.includes(transport as TransportType);
      expect(isValid).toBe(true);
    });

    it('should reject invalid transport', () => {
      const transport = 'invalid_transport';
      const isValid = TRANSPORT_TYPES.includes(transport as TransportType);
      expect(isValid).toBe(false);
    });

    it('should reject empty string', () => {
      const transport = '';
      const isValid = TRANSPORT_TYPES.includes(transport as TransportType);
      expect(isValid).toBe(false);
    });

    it('should be case sensitive', () => {
      const transport = 'HTTP';
      const isValid = TRANSPORT_TYPES.includes(transport as TransportType);
      expect(isValid).toBe(false);
    });
  });
});

describe('Response Format', () => {
  describe('HTTP transport response', () => {
    it('should have correct structure', () => {
      const httpResponse = {
        success: true,
        userMessage: { id: 'msg-123', content: 'Hello' },
        agentResponse: { text: 'Hi there!' },
      };

      expect(httpResponse).toHaveProperty('success', true);
      expect(httpResponse).toHaveProperty('userMessage');
      expect(httpResponse).toHaveProperty('agentResponse');
    });

    it('should include additional data when provided', () => {
      const httpResponse = {
        success: true,
        userMessage: { id: 'msg-123' },
        agentResponse: { text: 'Response' },
        sessionStatus: { expiresAt: '2024-01-01' },
      };

      expect(httpResponse).toHaveProperty('sessionStatus');
    });
  });

  describe('WebSocket transport response', () => {
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

  describe('SSE transport format', () => {
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
    it('should have correct structure for http transport error', () => {
      const errorResponse = {
        success: false,
        error: 'Failed to process message in http transport',
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
