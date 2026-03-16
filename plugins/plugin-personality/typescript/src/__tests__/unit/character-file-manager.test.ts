import { describe, it, expect, beforeEach } from 'bun:test';
import { CharacterFileManager } from '../../services/character-file-manager';
import type { IAgentRuntime } from '@elizaos/core';

describe('CharacterFileManager', () => {
  let fileManager: CharacterFileManager;
  let mockRuntime: IAgentRuntime;

  beforeEach(() => {
    mockRuntime = {
      getSetting: () => null,
      character: {
        bio: ['Original bio'],
        topics: ['topic1', 'topic2'],
        name: 'TestAgent',
      },
      agentId: 'test-agent-id',
    } as any;
    fileManager = new CharacterFileManager(mockRuntime);
  });

  it('should validate valid modifications', () => {
    const modification = {
      bio: ['New bio line'],
      topics: ['new topic'],
    };

    const result = fileManager.validateModification(modification);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should reject modifications with XSS attempts', () => {
    const modification = {
      bio: ['<script>alert("xss")</script>'],
      topics: ['javascript:void(0)'],
    };

    const result = fileManager.validateModification(modification);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Invalid bio: failed validation rules');
  });

  it('should reject modifications exceeding limits', () => {
    const modification = {
      bio: new Array(21).fill('Too many bio elements'),
      topics: new Array(51).fill('Too many topics'),
    };

    const result = fileManager.validateModification(modification);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Too many bio elements - maximum 20 allowed');
    expect(result.errors).toContain('Too many topics - maximum 50 allowed');
  });

  it('should reject empty string values', () => {
    const modification = {
      bio: ['', 'Valid bio'],
      topics: ['valid topic', ''],
    };

    const result = fileManager.validateModification(modification);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Invalid bio: failed validation rules');
  });

  it('should accept edge case of maximum allowed elements', () => {
    const modification = {
      bio: new Array(20).fill('Valid bio element'),
      topics: new Array(50).fill('validtopic'),
    };

    const result = fileManager.validateModification(modification);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should validate system prompt modifications', () => {
    const validSystem = {
      system: 'You are a helpful assistant that provides accurate information.',
    };

    const invalidSystem = {
      system: '<script>alert("xss")</script>',
    };

    const shortSystem = {
      system: 'Too short',
    };

    expect(fileManager.validateModification(validSystem).valid).toBe(true);
    expect(fileManager.validateModification(invalidSystem).valid).toBe(false);
    expect(fileManager.validateModification(shortSystem).valid).toBe(false);
  });
});

describe('CharacterFileManager static methods', () => {
  it('should have correct service type', () => {
    expect(CharacterFileManager.serviceType).toBe('CHARACTER_MANAGEMENT');
  });
});
