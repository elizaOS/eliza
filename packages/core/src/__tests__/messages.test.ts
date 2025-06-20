import { beforeAll, describe, expect, test, it } from 'bun:test';
import { formatEntities } from '../entities';
import { formatMessages, formatTimestamp } from '../utils';
import type { Content, Entity, Memory, UUID } from '../types';

describe('Messages Library', () => {
  let entities: Entity[];
  let entityId: UUID;

  beforeAll(() => {
    // Mock user data with proper UUID format
    entityId = '123e4567-e89b-12d3-a456-426614174000' as UUID;
    entities = [
      {
        id: entityId,
        names: ['Test User'],
        agentId: '123e4567-e89b-12d3-a456-426614174001' as UUID,
      },
    ];
  });

  test('formatEntities should format entities into a readable string', () => {
    const formattedEntities = formatEntities({ entities });

    expect(formattedEntities).toContain('Test User');
  });

  test('formatMessages should format messages into a readable string', () => {
    const messages: Memory[] = [
      {
        content: { text: 'Hello, world!' } as Content,
        entityId: entityId,
        roomId: '123e4567-e89b-12d3-a456-426614174002' as UUID,
        createdAt: new Date().getTime(),
        agentId: '' as UUID, // assuming agentId is an empty string here
      },
    ];

    const formattedMessages = formatMessages({ messages, entities });

    // Assertions
    expect(formattedMessages).toContain('Hello, world!');
    expect(formattedMessages).toContain('Test User');
  });

  test('formatTimestamp should return correct time string', () => {
    const timestamp = new Date().getTime() - 60000; // 1 minute ago
    const result = formatTimestamp(timestamp);

    // Assertions
    expect(result).toBe('1 minute ago');
  });

  test('formatMessages should include attachments if present', () => {
    const messages: Memory[] = [
      {
        content: {
          text: 'Check this attachment',
          attachments: [
            {
              id: '123e4567-e89b-12d3-a456-426614174003' as UUID,
              title: 'Image',
              url: 'http://example.com/image.jpg',
            },
          ],
        } as Content,
        entityId: entityId,
        roomId: '123e4567-e89b-12d3-a456-426614174004' as UUID,
        createdAt: new Date().getTime(),
        agentId: '' as UUID, // assuming agentId is an empty string here
      },
    ];

    const formattedMessages = formatMessages({ messages, entities });

    // Assertions
    expect(formattedMessages).toContain('Check this attachment');
    expect(formattedMessages).toContain('Attachments: [');
  });

  test('formatMessages should handle empty attachments gracefully', () => {
    const messages: Memory[] = [
      {
        content: {
          text: 'No attachments here',
        } as Content,
        entityId: entityId,
        roomId: '123e4567-e89b-12d3-a456-426614174005' as UUID,
        createdAt: new Date().getTime(),
        agentId: '' as UUID, // assuming agentId is an empty string here
      },
    ];

    const formattedMessages = formatMessages({ messages, entities });

    // Assertions
    expect(formattedMessages).toContain('No attachments here');
    expect(formattedMessages).not.toContain('Attachments');
  });
});

describe('Messages', () => {
  const mockEntities: Entity[] = [
    {
      id: '123e4567-e89b-12d3-a456-426614174006' as UUID,
      names: ['Alice'],
      agentId: '123e4567-e89b-12d3-a456-426614174001' as UUID,
    },
    {
      id: '123e4567-e89b-12d3-a456-426614174007' as UUID,
      names: ['Bob'],
      agentId: '123e4567-e89b-12d3-a456-426614174002' as UUID,
    },
  ];

  describe('formatEntities', () => {
    it('should format entities with complete details', () => {
      const formatted = formatEntities({ entities: mockEntities });
      expect(formatted).toContain('"Alice"\nID:');
      expect(formatted).toContain('"Bob"\nID:');
    });

    it('should handle entities without details', () => {
      const actorsWithoutDetails: Entity[] = [
        {
          id: '123e4567-e89b-12d3-a456-426614174013' as UUID,
          names: ['Charlie'],
          agentId: '123e4567-e89b-12d3-a456-426614174003' as UUID,
        },
      ];
      const formatted = formatEntities({ entities: actorsWithoutDetails });
      expect(formatted).toContain('"Charlie"\nID:');
    });

    it('should handle empty entities array', () => {
      const formatted = formatEntities({ entities: [] });
      expect(formatted).toBe('');
    });
  });

  describe('formatMessages', () => {
    it('should handle messages from unknown users', () => {
      const messagesWithUnknownUser: Memory[] = [
        {
          id: '123e4567-e89b-12d3-a456-426614174014' as UUID,
          roomId: '123e4567-e89b-12d3-a456-426614174009' as UUID,
          entityId: '123e4567-e89b-12d3-a456-426614174015' as UUID,
          createdAt: Date.now(),
          content: { text: 'Test message' } as Content,
          agentId: '123e4567-e89b-12d3-a456-426614174001',
        },
      ];

      const formatted = formatMessages({
        messages: messagesWithUnknownUser,
        entities: mockEntities,
      });
      expect(formatted).toContain('Unknown User: Test message');
    });

    it('should handle messages with no action', () => {
      const messagesWithoutAction: Memory[] = [
        {
          id: '123e4567-e89b-12d3-a456-426614174016' as UUID,
          roomId: '123e4567-e89b-12d3-a456-426614174009' as UUID,
          entityId: mockEntities[0].id as UUID,
          createdAt: Date.now(),
          content: { text: 'Simple message' } as Content,
          agentId: '123e4567-e89b-12d3-a456-426614174001',
        },
      ];

      const formatted = formatMessages({
        messages: messagesWithoutAction,
        entities: mockEntities,
      });
      expect(formatted).not.toContain('()');
      expect(formatted).toContain('Simple message');
    });

    it('should handle empty messages array', () => {
      const formatted = formatMessages({
        messages: [],
        entities: mockEntities,
      });
      expect(formatted).toBe('');
    });
  });

  describe('formatTimestamp', () => {
    it('should handle exact time boundaries', () => {
      const now = Date.now();
      expect(formatTimestamp(now)).toContain('just now');
    });
  });
});
