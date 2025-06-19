import { beforeAll, describe, expect, it, test, mock } from 'bun:test';
import { formatEntities } from '../entities';
import type { Content, Entity, IAgentRuntime, IDatabaseAdapter, Memory, UUID } from '../types';
import { formatMessages, formatTimestamp } from '../utils';

describe('Messages Library', () => {
  let runtime: IAgentRuntime & IDatabaseAdapter;
  let entities: Entity[];
  let entityId: UUID;

  beforeAll(() => {
    // Mock runtime with necessary methods
    runtime = {
      // Using mock() instead of jest.fn()
      getParticipantsForRoom: mock(),
      getEntityById: mock(),
      getRoom: mock(),
    } as unknown as IAgentRuntime & IDatabaseAdapter;

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

  // test("getEntityDetails should return entities based on roomId", async () => {
  // 	const roomId: UUID = "123e4567-e89b-12d3-a456-426614174001" as UUID;

  // 	// Using vi.mocked() type assertion instead of jest.Mock casting
  // 	vi.mocked(
  // 		runtime.getParticipantsForRoom,
  // 	).mockResolvedValue([entityId]);
  // 	vi.mocked(runtime.getEntityById).mockResolvedValue({
  // 		id: entityId,
  // 		names: ["Test User"],
  // 		agentId: "123e4567-e89b-12d3-a456-426614174001" as UUID,
  // 	});
  // 	vi.mocked(runtime.getRoom).mockResolvedValue({
  // 		id: roomId,
  // 		name: "Test Room",
  // 		participants: [entityId],
  // 		source: "test",
  // 		type: ChannelType.GROUP,
  // 		channelId: "test",
  // 		serverId: "test",
  // 		worldId: "test" as UUID,
  // 	} as Room);
  // 	vi.mocked(runtime.getEntitiesForRoom).mockResolvedValue([{
  // 		id: entityId,
  // 		names: ["Test User"],
  // 		agentId: "123e4567-e89b-12d3-a456-426614174001" as UUID,
  // 		components: []
  // 	}]);

  // 	const result = await getEntityDetails({ runtime, roomId });

  // 	expect(result.length).toBeGreaterThan(0);
  // 	expect(result[0].name).toBe("Test User");
  // });

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

  const mockMessages: Memory[] = [
    {
      id: '123e4567-e89b-12d3-a456-426614174008' as UUID,
      roomId: '123e4567-e89b-12d3-a456-426614174009' as UUID,
      entityId: mockEntities[0].id as UUID,
      createdAt: Date.now() - 5000, // 5 seconds ago
      content: {
        text: 'Hello everyone!',
        action: 'wave',
      } as Content,
      agentId: '123e4567-e89b-12d3-a456-426614174001',
    },
    {
      id: '123e4567-e89b-12d3-a456-426614174010' as UUID,
      roomId: '123e4567-e89b-12d3-a456-426614174009' as UUID,
      entityId: mockEntities[1].id as UUID,
      createdAt: Date.now() - 60000, // 1 minute ago
      content: {
        text: 'Hi Alice!',
        attachments: [
          {
            id: '123e4567-e89b-12d3-a456-426614174011' as UUID,
            title: 'Document',
            url: 'https://example.com/doc.pdf',
          },
        ],
      } as Content,
      agentId: '123e4567-e89b-12d3-a456-426614174001',
    },
  ];

  // describe("getEntityDetails", () => {
  // 	it("should retrieve actor details from database", async () => {
  // 		const mockRuntime = {
  // 			getParticipantsForRoom: vi
  // 				.fn()
  // 				.mockResolvedValue([mockEntities[0].id, mockEntities[1].id]),
  // 			getEntityById: mock().mockImplementation((id) => {
  // 				const actor = mockEntities.find((a) => a.id === id);
  // 				return Promise.resolve(actor);
  // 			}),
  // 			getRoom: mock().mockResolvedValue({
  // 				id: "123e4567-e89b-12d3-a456-426614174009" as UUID,
  // 				name: "Test Room",
  // 				participants: [mockEntities[0].id, mockEntities[1].id],
  // 				source: "test",
  // 			type: ChannelType.GROUP,
  // 			channelId: "test",
  // 			serverId: "test",
  // 				worldId: "test" as UUID,
  // 			} as Room),
  // 			getEntitiesForRoom: mock().mockResolvedValue(mockEntities),
  // 		};

  // 		const entities = await getEntityDetails({
  // 			runtime: mockRuntime as any,
  // 			roomId: "123e4567-e89b-12d3-a456-426614174009" as UUID,
  // 		});

  // 		expect(entities).toHaveLength(2);
  // 		expect(entities[0].name).toBe("Alice");
  // 		expect(entities[1].name).toBe("Bob");
  // 		expect(
  // 			mockRuntime.getParticipantsForRoom,
  // 		).toHaveBeenCalled();
  // 	});

  // 	it("should filter out null entities", async () => {
  // 		const invalidId = "123e4567-e89b-12d3-a456-426614174012" as UUID;
  // 		const mockRuntime = {
  // 			getParticipantsForRoom: vi
  // 				.fn()
  // 				.mockResolvedValue([mockEntities[0].id, invalidId]),
  // 			getEntityById: mock().mockImplementation((id) => {
  // 				const actor = mockEntities.find((a) => a.id === id);
  // 				return Promise.resolve(actor || null);
  // 			}),
  // 			getRoom: mock().mockResolvedValue({
  // 				id: "123e4567-e89b-12d3-a456-426614174009" as UUID,
  // 				name: "Test Room",
  // 				participants: [mockEntities[0].id, mockEntities[1].id],
  // 				source: "test",
  // 			type: ChannelType.GROUP,
  // 			channelId: "test",
  // 			serverId: "test",
  // 				worldId: "test" as UUID,
  // 			} as Room),
  // 			getEntitiesForRoom: mock().mockResolvedValue(mockEntities),
  // 		};

  // 		const entities = await getEntityDetails({
  // 			runtime: mockRuntime as any,
  // 			roomId: "123e4567-e89b-12d3-a456-426614174009" as UUID,
  // 		});

  // 		expect(entities).toHaveLength(1);
  // 		expect(entities[0].name).toBe("Alice");
  // 	});
  // });

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
