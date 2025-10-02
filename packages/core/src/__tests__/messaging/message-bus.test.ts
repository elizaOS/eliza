import { describe, it, expect, beforeEach } from 'bun:test';
import { MessageBus } from '../../messaging/message-bus';
import { MemoryTransport } from '../../messaging/transports/memory-transport';
import {
  MessageBusEvent,
  type Message,
  type MessageBusRoom,
  type MessageBusWorld,
} from '../../messaging/types';
import { ChannelType } from '../../types/environment';

describe('MessageBus', () => {
  let messageBus: MessageBus;

  beforeEach(() => {
    messageBus = new MessageBus();
  });

  describe('Room Management', () => {
    it('should create a room', () => {
      const room: MessageBusRoom = {
        id: 'room-1' as any,
        worldId: 'world-1' as any,
        agentId: 'agent-1' as any,
        name: 'Test Room',
        source: 'test',
        type: ChannelType.GROUP,
        participants: [],
        metadata: {},
      };

      messageBus.createRoom(room);
      const retrieved = messageBus.getRoom('room-1' as any);

      expect(retrieved).toEqual(room);
    });

    it('should emit room:created event', (done) => {
      const room: MessageBusRoom = {
        id: 'room-1' as any,
        worldId: 'world-1' as any,
        agentId: 'agent-1' as any,
        name: 'Test Room',
        source: 'test',
        type: ChannelType.GROUP,
        participants: [],
        metadata: {},
      };

      messageBus.on('room:created' as MessageBusEvent, (emittedRoom: MessageBusRoom) => {
        expect(emittedRoom).toEqual(room);
        done();
      });

      messageBus.createRoom(room);
    });

    it('should get all rooms', () => {
      const room1: MessageBusRoom = {
        id: 'room-1' as any,
        worldId: 'world-1' as any,
        agentId: 'agent-1' as any,
        name: 'Room 1',
        source: 'test',
        type: ChannelType.GROUP,
        participants: [],
        metadata: {},
      };

      const room2: MessageBusRoom = {
        id: 'room-2' as any,
        worldId: 'world-1' as any,
        agentId: 'agent-1' as any,
        name: 'Room 2',
        source: 'test',
        type: ChannelType.DM,
        participants: [],
        metadata: {},
      };

      messageBus.createRoom(room1);
      messageBus.createRoom(room2);

      const allRooms = messageBus.getAllRooms();
      expect(allRooms).toHaveLength(2);
      expect(allRooms).toContainEqual(room1);
      expect(allRooms).toContainEqual(room2);
    });

    it('should delete a room', () => {
      const room: MessageBusRoom = {
        id: 'room-1' as any,
        worldId: 'world-1' as any,
        agentId: 'agent-1' as any,
        name: 'Test Room',
        source: 'test',
        type: ChannelType.GROUP,
        participants: [],
        metadata: {},
      };

      messageBus.createRoom(room);
      expect(messageBus.getRoom('room-1' as any)).toBeDefined();

      messageBus.deleteRoom('room-1' as any);
      expect(messageBus.getRoom('room-1' as any)).toBeUndefined();
    });
  });

  describe('World Management', () => {
    it('should create a world', () => {
      const world: MessageBusWorld = {
        id: 'world-1' as any,
        agentId: 'agent-1' as any,
        serverId: 'server-1',
        name: 'Test World',
        rooms: [],
        metadata: {},
      };

      messageBus.createWorld(world);
      const retrieved = messageBus.getWorld('world-1' as any);

      expect(retrieved).toEqual(world);
    });

    it('should emit world:created event', (done) => {
      const world: MessageBusWorld = {
        id: 'world-1' as any,
        agentId: 'agent-1' as any,
        serverId: 'server-1',
        name: 'Test World',
        rooms: [],
        metadata: {},
      };

      messageBus.on('world:created' as MessageBusEvent, (emittedWorld: MessageBusWorld) => {
        expect(emittedWorld).toEqual(world);
        done();
      });

      messageBus.createWorld(world);
    });

    it('should get all worlds', () => {
      const world1: MessageBusWorld = {
        id: 'world-1' as any,
        agentId: 'agent-1' as any,
        serverId: 'server-1',
        name: 'World 1',
        rooms: [],
        metadata: {},
      };

      const world2: MessageBusWorld = {
        id: 'world-2' as any,
        agentId: 'agent-1' as any,
        serverId: 'server-2',
        name: 'World 2',
        rooms: [],
        metadata: {},
      };

      messageBus.createWorld(world1);
      messageBus.createWorld(world2);

      const allWorlds = messageBus.getAllWorlds();
      expect(allWorlds).toHaveLength(2);
      expect(allWorlds).toContainEqual(world1);
      expect(allWorlds).toContainEqual(world2);
    });
  });

  describe('Participant Management', () => {
    beforeEach(() => {
      const room: MessageBusRoom = {
        id: 'room-1' as any,
        worldId: 'world-1' as any,
        agentId: 'agent-1' as any,
        name: 'Test Room',
        source: 'test',
        type: ChannelType.GROUP,
        participants: [],
        metadata: {},
      };
      messageBus.createRoom(room);
    });

    it('should add a participant to a room', () => {
      messageBus.addParticipant('room-1' as any, 'user-1' as any);

      const participants = messageBus.getParticipants('room-1' as any);
      expect(participants).toContain('user-1' as any);
    });

    it('should not add duplicate participants', () => {
      messageBus.addParticipant('room-1' as any, 'user-1' as any);
      messageBus.addParticipant('room-1' as any, 'user-1' as any);

      const participants = messageBus.getParticipants('room-1' as any);
      expect(participants.filter((p) => p === ('user-1' as any)).length).toBe(1);
    });

    it('should emit participant:joined event', (done) => {
      messageBus.on('participant:joined' as MessageBusEvent, (payload: any) => {
        expect(payload.roomId).toBe('room-1');
        expect(payload.participantId).toBe('user-1');
        done();
      });

      messageBus.addParticipant('room-1' as any, 'user-1' as any);
    });

    it('should remove a participant from a room', () => {
      messageBus.addParticipant('room-1' as any, 'user-1' as any);
      messageBus.addParticipant('room-1' as any, 'user-2' as any);

      messageBus.removeParticipant('room-1' as any, 'user-1' as any);

      const participants = messageBus.getParticipants('room-1' as any);
      expect(participants).not.toContain('user-1' as any);
      expect(participants).toContain('user-2' as any);
    });

    it('should emit participant:left event', (done) => {
      messageBus.addParticipant('room-1' as any, 'user-1' as any);

      messageBus.on('participant:left' as MessageBusEvent, (payload: any) => {
        expect(payload.roomId).toBe('room-1');
        expect(payload.participantId).toBe('user-1');
        done();
      });

      messageBus.removeParticipant('room-1' as any, 'user-1' as any);
    });

    it('should check if entity is a participant', () => {
      messageBus.addParticipant('room-1' as any, 'user-1' as any);

      expect(messageBus.isParticipant('room-1' as any, 'user-1' as any)).toBe(true);
      expect(messageBus.isParticipant('room-1' as any, 'user-2' as any)).toBe(false);
    });

    it('should return empty array for non-existent room', () => {
      const participants = messageBus.getParticipants('non-existent' as any);
      expect(participants).toEqual([]);
    });
  });

  describe('Message Sending', () => {
    beforeEach(() => {
      const room: MessageBusRoom = {
        id: 'room-1' as any,
        worldId: 'world-1' as any,
        agentId: 'agent-1' as any,
        name: 'Test Room',
        source: 'test',
        type: ChannelType.GROUP,
        participants: ['user-1' as any],
        metadata: {},
      };
      messageBus.createRoom(room);
    });

    it('should send a message without transport', async () => {
      const message: Message = {
        id: 'msg-1' as any,
        roomId: 'room-1' as any,
        worldId: 'world-1' as any,
        authorId: 'user-1' as any,
        content: 'Hello, world!',
        metadata: { type: 'message' },
        createdAt: Date.now(),
      };

      let receivedMessage: Message | null = null;
      messageBus.on('message:received' as MessageBusEvent, (msg: Message) => {
        receivedMessage = msg;
      });

      await messageBus.sendMessage(message);

      expect(receivedMessage).not.toBeNull();
    });

    it('should emit message:sent event', async () => {
      const message: Message = {
        id: 'msg-1' as any,
        roomId: 'room-1' as any,
        worldId: 'world-1' as any,
        authorId: 'user-1' as any,
        content: 'Hello!',
        metadata: { type: 'message' },
        createdAt: Date.now(),
      };

      let sentMessage: Message | null = null;
      messageBus.on('message:sent' as MessageBusEvent, (msg: Message) => {
        sentMessage = msg;
      });

      await messageBus.sendMessage(message);

      expect(sentMessage).not.toBeNull();
    });

    it('should throw error when room does not exist', async () => {
      const message: Message = {
        id: 'msg-1' as any,
        roomId: 'non-existent' as any,
        worldId: 'world-1' as any,
        authorId: 'user-1' as any,
        content: 'Hello!',
        metadata: { type: 'message' },
        createdAt: Date.now(),
      };

      await expect(messageBus.sendMessage(message)).rejects.toThrow('Room non-existent not found');
    });

    it('should send message through transport if available', async () => {
      const transport = new MemoryTransport();
      const messageBusWithTransport = new MessageBus(transport);

      const room: MessageBusRoom = {
        id: 'room-1' as any,
        worldId: 'world-1' as any,
        agentId: 'agent-1' as any,
        name: 'Test Room',
        source: 'test',
        type: ChannelType.GROUP,
        participants: [],
        metadata: {},
      };
      messageBusWithTransport.createRoom(room);

      const message: Message = {
        id: 'msg-1' as any,
        roomId: 'room-1' as any,
        worldId: 'world-1' as any,
        authorId: 'user-1' as any,
        content: 'Hello via transport!',
        metadata: { type: 'message' },
        createdAt: Date.now(),
      };

      await messageBusWithTransport.sendMessage(message);

      const transportMessages = transport.getMessages();
      expect(transportMessages).toHaveLength(1);
      expect(transportMessages[0]).toEqual(message);
    });
  });

  describe('Room Subscription', () => {
    beforeEach(() => {
      const room: MessageBusRoom = {
        id: 'room-1' as any,
        worldId: 'world-1' as any,
        agentId: 'agent-1' as any,
        name: 'Test Room',
        source: 'test',
        type: ChannelType.GROUP,
        participants: [],
        metadata: {},
      };
      messageBus.createRoom(room);
    });

    it('should receive messages for subscribed room', async () => {
      const receivedMessages: Message[] = [];

      messageBus.subscribeToRoom('room-1' as any, (message) => {
        receivedMessages.push(message);
      });

      const message: Message = {
        id: 'msg-1' as any,
        roomId: 'room-1' as any,
        worldId: 'world-1' as any,
        authorId: 'user-1' as any,
        content: 'Test message',
        metadata: { type: 'message' },
        createdAt: Date.now(),
      };

      await messageBus.sendMessage(message);

      expect(receivedMessages).toHaveLength(1);
      expect(receivedMessages[0]).toEqual(message);
    });

    it('should not receive messages for other rooms', async () => {
      const room2: MessageBusRoom = {
        id: 'room-2' as any,
        worldId: 'world-1' as any,
        agentId: 'agent-1' as any,
        name: 'Other Room',
        source: 'test',
        type: ChannelType.GROUP,
        participants: [],
        metadata: {},
      };
      messageBus.createRoom(room2);

      const receivedMessages: Message[] = [];

      messageBus.subscribeToRoom('room-1' as any, (message) => {
        receivedMessages.push(message);
      });

      const message: Message = {
        id: 'msg-1' as any,
        roomId: 'room-2' as any,
        worldId: 'world-1' as any,
        authorId: 'user-1' as any,
        content: 'Message to room-2',
        metadata: { type: 'message' },
        createdAt: Date.now(),
      };

      await messageBus.sendMessage(message);

      expect(receivedMessages).toHaveLength(0);
    });
  });

  describe('Message Deletion', () => {
    it('should emit message:deleted event', (done) => {
      messageBus.on('message:deleted' as MessageBusEvent, (payload: any) => {
        expect(payload.messageId).toBe('msg-1');
        expect(payload.roomId).toBe('room-1');
        done();
      });

      messageBus.deleteMessage('msg-1' as any, 'room-1' as any);
    });
  });

  describe('Room Clearing', () => {
    it('should emit room:cleared event', (done) => {
      messageBus.on('room:cleared' as MessageBusEvent, (payload: any) => {
        expect(payload.roomId).toBe('room-1');
        done();
      });

      messageBus.clearRoom('room-1' as any);
    });
  });

  describe('Multi-Agent Group Chat', () => {
    it('should deliver message to all agents in a room', async () => {
      const room: MessageBusRoom = {
        id: 'room-1' as any,
        worldId: 'world-1' as any,
        agentId: 'agent-1' as any,
        name: 'Multi-Agent Room',
        source: 'test',
        type: ChannelType.GROUP,
        participants: ['agent-1' as any, 'agent-2' as any, 'agent-3' as any, 'user-1' as any],
        metadata: {},
      };

      messageBus.createRoom(room);

      const agent1Messages: Message[] = [];
      const agent2Messages: Message[] = [];
      const agent3Messages: Message[] = [];

      // Each agent subscribes
      messageBus.subscribeToRoom('room-1' as any, (msg) => {
        if (msg.authorId !== ('agent-1' as any)) agent1Messages.push(msg);
      });
      messageBus.subscribeToRoom('room-1' as any, (msg) => {
        if (msg.authorId !== ('agent-2' as any)) agent2Messages.push(msg);
      });
      messageBus.subscribeToRoom('room-1' as any, (msg) => {
        if (msg.authorId !== ('agent-3' as any)) agent3Messages.push(msg);
      });

      // User sends a message
      const message: Message = {
        id: 'msg-1' as any,
        roomId: 'room-1' as any,
        worldId: 'world-1' as any,
        authorId: 'user-1' as any,
        content: 'Can all agents help me?',
        metadata: { type: 'message' },
        createdAt: Date.now(),
      };

      await messageBus.sendMessage(message);

      // All agents should receive it
      expect(agent1Messages).toHaveLength(1);
      expect(agent2Messages).toHaveLength(1);
      expect(agent3Messages).toHaveLength(1);
    });
  });
});
