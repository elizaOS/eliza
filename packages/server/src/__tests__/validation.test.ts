/**
 * Unit tests for validation functions
 */

import { describe, it, expect, mock, jest } from 'bun:test';
import {
  validateChannelId,
  validateAgentId,
  validateRoomId,
  validateMemoryId,
  validateWorldId,
  getRuntime,
} from '../api/shared/validation';
import { logger } from '@elizaos/core';
import type { IAgentRuntime, UUID } from '@elizaos/core';

// Mock the logger to capture security logs
mock.module('@elizaos/core', async () => {
  const actual = await import('@elizaos/core');
  return {
    ...actual,
    logger: {
      warn: jest.fn(),
      info: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    },
  };
});

describe('Validation Functions', () => {
  beforeEach(() => {
    mock.restore();
  });

  describe('validateChannelId', () => {
    it('should validate a correct UUID', () => {
      const validUuid = '123e4567-e89b-12d3-a456-426614174000';
      const result = validateChannelId(validUuid);
      expect(result).toBe(validUuid);
    });

    it('should return null for invalid UUID format', () => {
      const invalidUuid = 'invalid-uuid';
      const result = validateChannelId(invalidUuid);
      expect(result).toBeNull();
    });

    it('should log security warning for invalid UUID with client IP', () => {
      const invalidUuid = 'invalid-uuid';
      const clientIp = '192.168.1.100';

      validateChannelId(invalidUuid, clientIp);

      expect(logger.warn).toHaveBeenCalledWith(
        `[SECURITY] Invalid channel ID attempted from ${clientIp}: ${invalidUuid}`
      );
    });

    it('should detect and reject suspicious patterns', () => {
      const suspiciousInputs = [
        '123e4567-e89b-12d3-a456-426614174000../',
        '123e4567-e89b-12d3-a456-426614174000<script>',
        '123e4567-e89b-12d3-a456-426614174000>alert',
        '123e4567-e89b-12d3-a456-426614174000"test',
        "123e4567-e89b-12d3-a456-426614174000'test",
        '123e4567-e89b-12d3-a456-426614174000\\test',
        '123e4567-e89b-12d3-a456-426614174000/test',
      ];

      suspiciousInputs.forEach((input) => {
        const result = validateChannelId(input, '192.168.1.100');
        expect(result).toBeNull();
        // These inputs are not valid UUIDs, so they get the "Invalid" message, not "Suspicious"
        expect(logger.warn).toHaveBeenCalledWith(
          `[SECURITY] Invalid channel ID attempted from 192.168.1.100: ${input}`
        );
      });
    });

    it('should not log when client IP is not provided', () => {
      const invalidUuid = 'invalid-uuid';

      validateChannelId(invalidUuid);

      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('should handle empty string', () => {
      const result = validateChannelId('');
      expect(result).toBeNull();
    });

    it('should handle null/undefined input gracefully', () => {
      const result1 = validateChannelId(null as any);
      const result2 = validateChannelId(undefined as any);
      expect(result1).toBeNull();
      expect(result2).toBeNull();
    });
  });

  describe('validateAgentId', () => {
    it('should validate a correct UUID', () => {
      const validUuid = '123e4567-e89b-12d3-a456-426614174000';
      const result = validateAgentId(validUuid);
      expect(result).toBe(validUuid);
    });

    it('should return null for invalid UUID', () => {
      const result = validateAgentId('invalid-uuid');
      expect(result).toBeNull();
    });
  });

  describe('validateRoomId', () => {
    it('should validate a correct UUID', () => {
      const validUuid = '123e4567-e89b-12d3-a456-426614174000';
      const result = validateRoomId(validUuid);
      expect(result).toBe(validUuid);
    });

    it('should return null for invalid UUID', () => {
      const result = validateRoomId('invalid-uuid');
      expect(result).toBeNull();
    });
  });

  describe('validateMemoryId', () => {
    it('should validate a correct UUID', () => {
      const validUuid = '123e4567-e89b-12d3-a456-426614174000';
      const result = validateMemoryId(validUuid);
      expect(result).toBe(validUuid);
    });

    it('should return null for invalid UUID', () => {
      const result = validateMemoryId('invalid-uuid');
      expect(result).toBeNull();
    });
  });

  describe('validateWorldId', () => {
    it('should validate a correct UUID', () => {
      const validUuid = '123e4567-e89b-12d3-a456-426614174000';
      const result = validateWorldId(validUuid);
      expect(result).toBe(validUuid);
    });

    it('should return null for invalid UUID', () => {
      const result = validateWorldId('invalid-uuid');
      expect(result).toBeNull();
    });
  });

  describe('getRuntime', () => {
    it('should return runtime when agent exists', () => {
      const mockRuntime = {
        agentId: '123e4567-e89b-12d3-a456-426614174000' as UUID,
        character: {},
        providers: [],
        actions: [],
        evaluators: [],
        services: new Map(),
      } as unknown as IAgentRuntime;
      const agentId = '123e4567-e89b-12d3-a456-426614174000' as UUID;
      const agents = new Map<UUID, IAgentRuntime>();
      agents.set(agentId, mockRuntime);

      const result = getRuntime(agents, agentId);
      expect(result).toBe(mockRuntime);
    });

    it('should throw error when agent does not exist', () => {
      const agentId = '123e4567-e89b-12d3-a456-426614174000' as UUID;
      const agents = new Map<UUID, IAgentRuntime>();

      expect(() => getRuntime(agents, agentId)).toThrow(`Agent not found: ${agentId}`);
    });

    it('should handle empty agents map', () => {
      const agentId = '123e4567-e89b-12d3-a456-426614174000' as UUID;
      const agents = new Map<UUID, IAgentRuntime>();

      expect(() => getRuntime(agents, agentId)).toThrow(`Agent not found: ${agentId}`);
    });
  });
});
