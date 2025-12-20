import { describe, it, expect } from 'bun:test';
import {
  createMessageMemory,
  isDocumentMetadata,
  isFragmentMetadata,
  isMessageMetadata,
  isDescriptionMetadata,
  isCustomMetadata,
  isDocumentMemory,
  isFragmentMemory,
  getMemoryText,
} from '../memory';
import {
  MemoryType,
  type Memory,
  type DocumentMetadata,
  type FragmentMetadata,
  type MessageMetadata,
  type DescriptionMetadata,
  type CustomMetadata,
  type UUID,
  type Content,
} from '../types';

describe('Memory Utilities', () => {
  const mockEntityId = '123e4567-e89b-12d3-a456-426614174000' as UUID;
  const mockRoomId = '123e4567-e89b-12d3-a456-426614174001' as UUID;
  const mockAgentId = '123e4567-e89b-12d3-a456-426614174002' as UUID;

  describe('createMessageMemory', () => {
    it('should create a message memory with required fields', () => {
      const memory = createMessageMemory({
        entityId: mockEntityId,
        roomId: mockRoomId,
        content: { text: 'Hello, world!' },
      });

      expect(memory.entityId).toBe(mockEntityId);
      expect(memory.roomId).toBe(mockRoomId);
      expect(memory.content.text).toBe('Hello, world!');
      expect(memory.metadata.type).toBe(MemoryType.MESSAGE);
      expect(memory.metadata.timestamp).toBeDefined();
      expect(memory.createdAt).toBeDefined();
    });

    it('should set scope to private when agentId is provided', () => {
      const memory = createMessageMemory({
        entityId: mockEntityId,
        roomId: mockRoomId,
        agentId: mockAgentId,
        content: { text: 'Private message' },
      });

      expect(memory.metadata.scope).toBe('private');
    });

    it('should set scope to shared when agentId is not provided', () => {
      const memory = createMessageMemory({
        entityId: mockEntityId,
        roomId: mockRoomId,
        content: { text: 'Shared message' },
      });

      expect(memory.metadata.scope).toBe('shared');
    });

    it('should include embedding if provided', () => {
      const embedding = [0.1, 0.2, 0.3];
      const memory = createMessageMemory({
        entityId: mockEntityId,
        roomId: mockRoomId,
        content: { text: 'Message with embedding' },
        embedding,
      });

      expect(memory.embedding).toEqual(embedding);
    });

    it('should use provided id if given', () => {
      const customId = '123e4567-e89b-12d3-a456-426614174003' as UUID;
      const memory = createMessageMemory({
        id: customId,
        entityId: mockEntityId,
        roomId: mockRoomId,
        content: { text: 'Message with custom id' },
      });

      expect(memory.id).toBe(customId);
    });
  });

  describe('isDocumentMetadata', () => {
    it('should return true for document metadata', () => {
      const metadata: DocumentMetadata = {
        type: MemoryType.DOCUMENT,
        timestamp: Date.now(),
      };
      expect(isDocumentMetadata(metadata)).toBe(true);
    });

    it('should return false for non-document metadata', () => {
      const metadata: MessageMetadata = {
        type: MemoryType.MESSAGE,
        timestamp: Date.now(),
        scope: 'shared',
      };
      expect(isDocumentMetadata(metadata)).toBe(false);
    });
  });

  describe('isFragmentMetadata', () => {
    it('should return true for fragment metadata', () => {
      const metadata: FragmentMetadata = {
        type: MemoryType.FRAGMENT,
        timestamp: Date.now(),
      };
      expect(isFragmentMetadata(metadata)).toBe(true);
    });

    it('should return false for non-fragment metadata', () => {
      const metadata: MessageMetadata = {
        type: MemoryType.MESSAGE,
        timestamp: Date.now(),
        scope: 'shared',
      };
      expect(isFragmentMetadata(metadata)).toBe(false);
    });
  });

  describe('isMessageMetadata', () => {
    it('should return true for message metadata', () => {
      const metadata: MessageMetadata = {
        type: MemoryType.MESSAGE,
        timestamp: Date.now(),
        scope: 'shared',
      };
      expect(isMessageMetadata(metadata)).toBe(true);
    });

    it('should return false for non-message metadata', () => {
      const metadata: DocumentMetadata = {
        type: MemoryType.DOCUMENT,
        timestamp: Date.now(),
      };
      expect(isMessageMetadata(metadata)).toBe(false);
    });
  });

  describe('isDescriptionMetadata', () => {
    it('should return true for description metadata', () => {
      const metadata: DescriptionMetadata = {
        type: MemoryType.DESCRIPTION,
        timestamp: Date.now(),
      };
      expect(isDescriptionMetadata(metadata)).toBe(true);
    });

    it('should return false for non-description metadata', () => {
      const metadata: MessageMetadata = {
        type: MemoryType.MESSAGE,
        timestamp: Date.now(),
        scope: 'shared',
      };
      expect(isDescriptionMetadata(metadata)).toBe(false);
    });
  });

  describe('isCustomMetadata', () => {
    it('should return true for custom metadata types', () => {
      const metadata: CustomMetadata = {
        type: 'CUSTOM_TYPE' as MemoryType,
        timestamp: Date.now(),
      };
      expect(isCustomMetadata(metadata)).toBe(true);
    });

    it('should return false for standard metadata types', () => {
      const metadata: MessageMetadata = {
        type: MemoryType.MESSAGE,
        timestamp: Date.now(),
        scope: 'shared',
      };
      expect(isCustomMetadata(metadata)).toBe(false);
    });
  });

  describe('isDocumentMemory', () => {
    it('should return true for document memory', () => {
      const memory: Memory = {
        id: mockEntityId,
        entityId: mockEntityId,
        roomId: mockRoomId,
        content: { text: 'Document content' },
        createdAt: Date.now(),
        metadata: {
          type: MemoryType.DOCUMENT,
          timestamp: Date.now(),
        },
        agentId: mockAgentId,
      };
      expect(isDocumentMemory(memory)).toBe(true);
    });

    it('should return false for non-document memory', () => {
      const memory: Memory = {
        id: mockEntityId,
        entityId: mockEntityId,
        roomId: mockRoomId,
        content: { text: 'Message content' },
        createdAt: Date.now(),
        metadata: {
          type: MemoryType.MESSAGE,
          timestamp: Date.now(),
          scope: 'shared',
        },
        agentId: mockAgentId,
      };
      expect(isDocumentMemory(memory)).toBe(false);
    });

    it('should return false when metadata is undefined', () => {
      const memory: Memory = {
        id: mockEntityId,
        entityId: mockEntityId,
        roomId: mockRoomId,
        content: { text: 'Content without metadata' },
        createdAt: Date.now(),
        agentId: mockAgentId,
      } as Memory;
      expect(isDocumentMemory(memory)).toBe(false);
    });
  });

  describe('isFragmentMemory', () => {
    it('should return true for fragment memory', () => {
      const memory: Memory = {
        id: mockEntityId,
        entityId: mockEntityId,
        roomId: mockRoomId,
        content: { text: 'Fragment content' },
        createdAt: Date.now(),
        metadata: {
          type: MemoryType.FRAGMENT,
          timestamp: Date.now(),
        },
        agentId: mockAgentId,
      };
      expect(isFragmentMemory(memory)).toBe(true);
    });

    it('should return false for non-fragment memory', () => {
      const memory: Memory = {
        id: mockEntityId,
        entityId: mockEntityId,
        roomId: mockRoomId,
        content: { text: 'Message content' },
        createdAt: Date.now(),
        metadata: {
          type: MemoryType.MESSAGE,
          timestamp: Date.now(),
          scope: 'shared',
        },
        agentId: mockAgentId,
      };
      expect(isFragmentMemory(memory)).toBe(false);
    });

    it('should return false when metadata is undefined', () => {
      const memory: Memory = {
        id: mockEntityId,
        entityId: mockEntityId,
        roomId: mockRoomId,
        content: { text: 'Content without metadata' },
        createdAt: Date.now(),
        agentId: mockAgentId,
      } as Memory;
      expect(isFragmentMemory(memory)).toBe(false);
    });
  });

  describe('getMemoryText', () => {
    it('should extract text from memory content', () => {
      const memory: Memory = {
        id: mockEntityId,
        entityId: mockEntityId,
        roomId: mockRoomId,
        content: { text: 'Hello, world!' },
        createdAt: Date.now(),
        metadata: {
          type: MemoryType.MESSAGE,
          timestamp: Date.now(),
          scope: 'shared',
        },
        agentId: mockAgentId,
      };
      expect(getMemoryText(memory)).toBe('Hello, world!');
    });

    it('should return default value when text is missing', () => {
      const memory: Memory = {
        id: mockEntityId,
        entityId: mockEntityId,
        roomId: mockRoomId,
        content: {} as Content,
        createdAt: Date.now(),
        metadata: {
          type: MemoryType.MESSAGE,
          timestamp: Date.now(),
          scope: 'shared',
        },
        agentId: mockAgentId,
      };
      expect(getMemoryText(memory)).toBe('');
      expect(getMemoryText(memory, 'default')).toBe('default');
    });

    it('should return custom default value when provided', () => {
      const memory: Memory = {
        id: mockEntityId,
        entityId: mockEntityId,
        roomId: mockRoomId,
        content: {} as Content,
        createdAt: Date.now(),
        metadata: {
          type: MemoryType.MESSAGE,
          timestamp: Date.now(),
          scope: 'shared',
        },
        agentId: mockAgentId,
      };
      expect(getMemoryText(memory, 'No text available')).toBe('No text available');
    });

    it('should handle undefined text in content', () => {
      const memory: Memory = {
        id: mockEntityId,
        entityId: mockEntityId,
        roomId: mockRoomId,
        content: { text: undefined } as Content,
        createdAt: Date.now(),
        metadata: {
          type: MemoryType.MESSAGE,
          timestamp: Date.now(),
          scope: 'shared',
        },
        agentId: mockAgentId,
      };
      expect(getMemoryText(memory)).toBe('');
      expect(getMemoryText(memory, 'Default')).toBe('Default');
    });
  });
});
