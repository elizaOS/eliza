import { describe, it, expect } from 'bun:test';
import { MessageBus } from '../../messaging/message-bus';
import { MemoryTransport } from '../../messaging/transports/memory-transport';
import type { Message } from '../../messaging/types';
import { ChannelType } from '../../types/environment';

describe('Multi-Agent Group Chat Integration', () => {
  it('should support multiple agents in a single room (browser scenario)', async () => {
    // Simulate browser deployment with 3 agents
    const transport = new MemoryTransport();
    const messageBus = new MessageBus(transport);

    // Create a world
    messageBus.createWorld({
      id: 'local-world' as any,
      agentId: 'agent-1' as any,
      serverId: 'local',
      name: 'Local Browser World',
      rooms: [],
      metadata: {},
    });

    // Create a group room
    const roomId = 'group-room-1' as any;
    messageBus.createRoom({
      id: roomId,
      worldId: 'local-world' as any,
      agentId: 'agent-1' as any,
      name: 'Product Launch Chat',
      source: 'browser',
      type: ChannelType.GROUP,
      participants: [],
      metadata: {},
    });

    // Add participants (1 user + 3 agents)
    const userIds = ['user-alice', 'agent-support', 'agent-sales', 'agent-technical'];
    userIds.forEach((userId) => {
      messageBus.addParticipant(roomId, userId as any);
    });

    // Verify all participants are added
    const participants = messageBus.getParticipants(roomId);
    expect(participants).toHaveLength(4);

    // Track messages received by each agent
    const agentMessages = {
      'agent-support': [] as Message[],
      'agent-sales': [] as Message[],
      'agent-technical': [] as Message[],
    };

    // Each agent subscribes to the room
    Object.keys(agentMessages).forEach((agentId) => {
      messageBus.subscribeToRoom(roomId, (message) => {
        // Agents don't receive their own messages
        if (message.authorId !== (agentId as any)) {
          agentMessages[agentId as keyof typeof agentMessages].push(message);
        }
      });
    });

    // User sends a message
    const userMessage: Message = {
      id: 'msg-1' as any,
      roomId,
      worldId: 'local-world' as any,
      authorId: 'user-alice' as any,
      content: 'Can all agents help me plan our Q2 product launch?',
      metadata: { type: 'message' },
      createdAt: Date.now(),
    };

    await messageBus.sendMessage(userMessage);

    // All 3 agents should receive the message
    expect(agentMessages['agent-support']).toHaveLength(1);
    expect(agentMessages['agent-sales']).toHaveLength(1);
    expect(agentMessages['agent-technical']).toHaveLength(1);

    expect(agentMessages['agent-support'][0].content).toBe(userMessage.content);

    // Simulate agent responses
    const supportResponse: Message = {
      id: 'msg-2' as any,
      roomId,
      worldId: 'local-world' as any,
      authorId: 'agent-support' as any,
      content: 'I can help with customer support planning!',
      metadata: { type: 'message' },
      createdAt: Date.now(),
      inReplyTo: userMessage.id,
    };

    await messageBus.sendMessage(supportResponse);

    // Other agents should receive support agent's response
    expect(agentMessages['agent-sales']).toHaveLength(2);
    expect(agentMessages['agent-technical']).toHaveLength(2);
    // Support agent doesn't receive its own message
    expect(agentMessages['agent-support']).toHaveLength(1);
  });

  it('should support participant filtering', async () => {
    const messageBus = new MessageBus(new MemoryTransport());

    // Create room
    const roomId = 'room-1' as any;
    messageBus.createRoom({
      id: roomId,
      worldId: 'world-1' as any,
      agentId: 'agent-1' as any,
      name: 'Test Room',
      source: 'test',
      type: ChannelType.GROUP,
      participants: [],
      metadata: {},
    });

    // Add participants
    messageBus.addParticipant(roomId, 'agent-1' as any);
    messageBus.addParticipant(roomId, 'agent-2' as any);

    // Only agent-1 subscribes
    const agent1Messages: Message[] = [];
    messageBus.subscribeToRoom(roomId, (message) => {
      if (messageBus.isParticipant(roomId, 'agent-1' as any)) {
        agent1Messages.push(message);
      }
    });

    // Send message
    const message: Message = {
      id: 'msg-1' as any,
      roomId,
      worldId: 'world-1' as any,
      authorId: 'user-1' as any,
      content: 'Test',
      metadata: { type: 'message' },
      createdAt: Date.now(),
    };

    await messageBus.sendMessage(message);

    // Agent-1 should receive it
    expect(agent1Messages).toHaveLength(1);
  });

  it('should handle participant removal from active room', async () => {
    const messageBus = new MessageBus(new MemoryTransport());

    // Create room with participants
    const roomId = 'room-1' as any;
    messageBus.createRoom({
      id: roomId,
      worldId: 'world-1' as any,
      agentId: 'agent-1' as any,
      name: 'Test Room',
      source: 'test',
      type: ChannelType.GROUP,
      participants: ['agent-1' as any, 'agent-2' as any],
      metadata: {},
    });

    expect(messageBus.getParticipants(roomId)).toHaveLength(2);

    // Remove a participant
    messageBus.removeParticipant(roomId, 'agent-1' as any);

    expect(messageBus.getParticipants(roomId)).toHaveLength(1);
    expect(messageBus.isParticipant(roomId, 'agent-1' as any)).toBe(false);
    expect(messageBus.isParticipant(roomId, 'agent-2' as any)).toBe(true);
  });
});
