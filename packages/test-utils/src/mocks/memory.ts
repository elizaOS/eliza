/**
 * @fileoverview Mock implementations for Memory and related interfaces
 *
 * This module provides comprehensive mock implementations for memory objects,
 * content structures, and memory-related operations.
 */

import type {
  ChannelType,
  Content,
  Media,
  Memory,
  MemoryMetadata,
  MemoryType,
  UUID,
} from '@elizaos/core';
import { ContentType } from '@elizaos/core';

/**
 * Type representing overrides for Memory mock creation
 */
export type MockMemoryOverrides = Partial<Memory>;

/**
 * Type representing overrides for Content mock creation
 */
export type MockContentOverrides = Partial<Content>;

/**
 * Create a comprehensive mock Memory object with intelligent defaults
 *
 * This function provides a fully-featured memory mock that includes
 * realistic content, metadata, and proper typing.
 *
 * @param overrides - Partial object to override specific properties
 * @returns Complete mock Memory object
 *
 * @example
 * ```typescript
 * import { createMockMemory } from '@elizaos/core/test-utils';
 *
 * const mockMessage = createMockMemory({
 *   content: { text: 'Hello, world!' },
 *   entityId: 'user-123'
 * });
 * ```
 */
export function createMockMemory(overrides: MockMemoryOverrides = {}): Memory {
  const defaultContent: Content = {
    text: 'Test message content',
    source: 'test',
    ...overrides.content,
  };

  const defaultMetadata: MemoryMetadata = {
    type: 'message' as MemoryType,
    source: 'test',
    timestamp: Date.now(),
    ...overrides.metadata,
  };

  const baseMemory: Memory = {
    id: 'test-memory-id' as UUID,
    entityId: 'test-entity-id' as UUID,
    agentId: 'test-agent-id' as UUID,
    roomId: 'test-room-id' as UUID,
    worldId: 'test-world-id' as UUID,
    content: defaultContent,
    embedding: undefined,
    createdAt: Date.now(),
    unique: true,
    similarity: 1.0,
    metadata: defaultMetadata,
    ...overrides,
  };

  return baseMemory;
}

/**
 * Create a mock Content object with intelligent defaults
 *
 * @param overrides - Partial object to override specific properties
 * @returns Complete mock Content object
 *
 * @example
 * ```typescript
 * import { createMockContent } from '@elizaos/core/test-utils';
 *
 * const mockContent = createMockContent({
 *   text: 'Custom message',
 *   actions: ['SEND_MESSAGE']
 * });
 * ```
 */
export function createMockContent(overrides: MockContentOverrides = {}): Content {
  const baseContent: Content = {
    text: 'Mock content text',
    thought: 'Mock internal thought',
    actions: [],
    providers: [],
    source: 'test',
    target: undefined,
    url: undefined,
    inReplyTo: undefined,
    attachments: [],
    channelType: 'DM' as ChannelType,
    ...overrides,
  };

  return baseContent;
}

/**
 * Create a mock conversation memory (user message)
 *
 * @param text - The message text
 * @param overrides - Additional overrides
 * @returns Mock user message memory
 */
export function createMockUserMessage(text: string, overrides: MockMemoryOverrides = {}): Memory {
  return createMockMemory({
    content: {
      text,
      source: 'user',
    },
    metadata: {
      type: 'message' as MemoryType,
      source: 'user',
    },
    ...overrides,
  });
}

/**
 * Create a mock agent response memory
 *
 * @param text - The response text
 * @param thought - Optional internal thought
 * @param actions - Optional actions executed
 * @param overrides - Additional overrides
 * @returns Mock agent response memory
 */
export function createMockAgentResponse(
  text: string,
  thought?: string,
  actions: string[] = [],
  overrides: MockMemoryOverrides = {}
): Memory {
  return createMockMemory({
    entityId: 'test-agent-id' as UUID,
    content: {
      text,
      thought,
      actions,
      source: 'agent',
    },
    metadata: {
      type: 'message' as MemoryType,
      source: 'agent',
    },
    ...overrides,
  });
}

/**
 * Create a mock fact memory for knowledge storage
 *
 * @param fact - The factual claim
 * @param confidence - Confidence level (0-1)
 * @param overrides - Additional overrides
 * @returns Mock fact memory
 */
export function createMockFact(
  fact: string,
  confidence: number = 0.9,
  overrides: MockMemoryOverrides = {}
): Memory {
  return createMockMemory({
    content: {
      text: fact,
      source: 'fact_extraction',
    },
    metadata: {
      type: 'fact' as MemoryType,
      confidence,
      source: 'evaluator',
    },
    ...overrides,
  });
}

/**
 * Create a mock memory with embedding vector
 *
 * @param text - The text content
 * @param dimension - Embedding dimension (default: 1536 for OpenAI)
 * @param overrides - Additional overrides
 * @returns Mock memory with embedding
 */
export function createMockMemoryWithEmbedding(
  text: string,
  dimension: number = 1536,
  overrides: MockMemoryOverrides = {}
): Memory {
  const embedding = new Array(dimension).fill(0).map(() => Math.random());

  return createMockMemory({
    content: { text },
    embedding,
    ...overrides,
  });
}

/**
 * Create a batch of mock conversation memories
 *
 * @param count - Number of memories to create
 * @param roomId - Room ID for all memories
 * @returns Array of mock conversation memories
 */
export function createMockConversation(count: number = 5, roomId?: UUID): Memory[] {
  const memories: Memory[] = [];
  const actualRoomId = roomId || ('test-room-id' as UUID);

  for (let i = 0; i < count; i++) {
    const isUserMessage = i % 2 === 0;
    const memory = isUserMessage
      ? createMockUserMessage(`User message ${i + 1}`, { roomId: actualRoomId })
      : createMockAgentResponse(`Agent response ${i + 1}`, `Thinking about response ${i + 1}`, [], {
          roomId: actualRoomId,
        });

    // Make timestamps sequential
    memory.createdAt = Date.now() - (count - i) * 1000;
    memories.push(memory);
  }

  return memories;
}

/**
 * Create a mock Media attachment
 *
 * @param type - Media type
 * @param url - Media URL
 * @param overrides - Additional overrides
 * @returns Mock Media object
 */
export function createMockMedia(
  type: 'image' | 'video' | 'audio' | 'document' = 'image',
  url: string = 'https://example.com/test.jpg',
  overrides: Partial<Media> = {}
): Media {
  const baseContentTypes = {
    image: ContentType.IMAGE,
    video: ContentType.VIDEO,
    audio: ContentType.AUDIO,
    document: ContentType.DOCUMENT,
  };

  return {
    id: 'test-media-id' as UUID,
    url,
    title: `Test ${type}`,
    source: 'test',
    description: `Mock ${type} for testing`,
    text: `Alt text for ${type}`,
    contentType: baseContentTypes[type],
    ...overrides,
  };
}
