import { EventEmitter } from 'events';
import type {
  MessageBusRoom,
  MessageBusWorld,
  Message,
  IMessageTransport,
  MessageBusEvent,
  MessageDeletedPayload,
  RoomClearedPayload,
  ParticipantJoinedPayload,
  ParticipantLeftPayload,
} from './types';
import type { UUID } from '../types/primitives';

/**
 * Pure JavaScript MessageBus - works in browser AND server
 * Zero Node.js/Bun-specific dependencies (EventEmitter is universal)
 *
 * This is the core messaging infrastructure that replaces the old
 * MessageBusService. It provides:
 * - In-memory room/world/participant management
 * - Event-driven message routing
 * - Pluggable transport layer (Memory, WebSocket, HTTP)
 * - Browser compatibility
 * - Optional database persistence (via runtime injection)
 */
export class MessageBus extends EventEmitter {
  private transport?: IMessageTransport;
  private rooms = new Map<UUID, MessageBusRoom>();
  private worlds = new Map<UUID, MessageBusWorld>();

  constructor(transport?: IMessageTransport) {
    super();
    this.transport = transport;
  }

  /**
   * Check if transport supports persistence
   */
  private supportsP(): boolean {
    return (
      this.transport !== undefined &&
      'persistWorld' in this.transport &&
      typeof (this.transport as any).persistWorld === 'function'
    );
  }

  /**
   * Connect to the underlying transport
   */
  async connect(): Promise<void> {
    if (this.transport) {
      await this.transport.connect();
    }
  }

  /**
   * Disconnect from the transport
   */
  async disconnect(): Promise<void> {
    if (this.transport) {
      await this.transport.disconnect();
    }
  }

  /**
   * Send a message to a room
   */
  async sendMessage(message: Message): Promise<void> {
    // Validate room exists
    if (!this.rooms.has(message.roomId)) {
      throw new Error(`Room ${message.roomId} not found`);
    }

    // Emit locally first (synchronous for immediate UI updates)
    this.emit('message:sent' as MessageBusEvent, message);

    // Send via transport if available (async for network)
    if (this.transport) {
      await this.transport.sendMessage(message);
    } else {
      // In browser-only mode without transport, emit received immediately
      this.emit('message:received' as MessageBusEvent, message);
    }
  }

  /**
   * Handle incoming message from transport
   */
  receiveMessage(message: Message): void {
    this.emit('message:received' as MessageBusEvent, message);
  }

  /**
   * Subscribe to messages in a room
   */
  subscribeToRoom(roomId: UUID, callback: (message: Message) => void): void {
    // Local subscription
    this.on('message:received' as MessageBusEvent, (message: Message) => {
      if (message.roomId === roomId) {
        callback(message);
      }
    });

    // Transport subscription
    if (this.transport) {
      this.transport.subscribe(roomId, callback);
    }
  }

  /**
   * Create or register a room
   */
  createRoom(room: MessageBusRoom): void {
    this.rooms.set(room.id, room);
    this.emit('room:created' as MessageBusEvent, room);

    // Persist to database if transport supports it
    if (this.supportsP()) {
      (this.transport as any).persistRoom(room).catch((err: Error) => {
        console.error('Failed to persist room:', err);
      });
    }
  }

  /**
   * Get a room by ID
   */
  getRoom(roomId: UUID): MessageBusRoom | undefined {
    return this.rooms.get(roomId);
  }

  /**
   * Get all rooms
   */
  getAllRooms(): MessageBusRoom[] {
    return Array.from(this.rooms.values());
  }

  /**
   * Create or register a world
   */
  createWorld(world: MessageBusWorld): void {
    this.worlds.set(world.id, world);
    this.emit('world:created' as MessageBusEvent, world);

    // Persist to database if transport supports it
    if (this.supportsP()) {
      (this.transport as any).persistWorld(world).catch((err: Error) => {
        console.error('Failed to persist world:', err);
      });
    }
  }

  /**
   * Get a world by ID
   */
  getWorld(worldId: UUID): MessageBusWorld | undefined {
    return this.worlds.get(worldId);
  }

  /**
   * Get all worlds
   */
  getAllWorlds(): MessageBusWorld[] {
    return Array.from(this.worlds.values());
  }

  /**
   * Add a participant to a room
   */
  addParticipant(roomId: UUID, participantId: UUID): void {
    const room = this.rooms.get(roomId);
    if (room && !room.participants.includes(participantId)) {
      room.participants.push(participantId);
      const payload: ParticipantJoinedPayload = { roomId, participantId };
      this.emit('participant:joined' as MessageBusEvent, payload);

      // Persist to database if transport supports it
      if (this.supportsP()) {
        (this.transport as any).persistParticipant(roomId, participantId).catch((err: Error) => {
          console.error('Failed to persist participant:', err);
        });
      }
    }
  }

  /**
   * Remove a participant from a room
   */
  removeParticipant(roomId: UUID, participantId: UUID): void {
    const room = this.rooms.get(roomId);
    if (room) {
      room.participants = room.participants.filter((id) => id !== participantId);
      const payload: ParticipantLeftPayload = { roomId, participantId };
      this.emit('participant:left' as MessageBusEvent, payload);
    }
  }

  /**
   * Get all participants in a room
   */
  getParticipants(roomId: UUID): UUID[] {
    return this.rooms.get(roomId)?.participants || [];
  }

  /**
   * Check if an entity is a participant in a room
   */
  isParticipant(roomId: UUID, participantId: UUID): boolean {
    return this.getParticipants(roomId).includes(participantId);
  }

  /**
   * Clear all messages in a room
   */
  clearRoom(roomId: UUID): void {
    const payload: RoomClearedPayload = { roomId };
    this.emit('room:cleared' as MessageBusEvent, payload);
  }

  /**
   * Delete a specific message
   */
  deleteMessage(messageId: UUID, roomId?: UUID): void {
    const payload: MessageDeletedPayload = { messageId, roomId };
    this.emit('message:deleted' as MessageBusEvent, payload);
  }

  /**
   * Update a message
   */
  updateMessage(message: Message): void {
    this.emit('message:updated' as MessageBusEvent, message);
  }

  /**
   * Delete a room
   */
  deleteRoom(roomId: UUID): void {
    this.rooms.delete(roomId);
  }

  /**
   * Delete a world
   */
  deleteWorld(worldId: UUID): void {
    this.worlds.delete(worldId);
  }

  /**
   * Load state from database (if persistence is enabled)
   * Useful for browser refresh - restores all worlds, rooms, participants, messages
   */
  async loadFromDatabase(): Promise<void> {
    if (!this.supportsP()) {
      return;
    }

    const transport = this.transport as any;

    // Load worlds
    const worlds = await transport.loadWorldsFromDatabase();
    worlds.forEach((world: MessageBusWorld) => {
      this.worlds.set(world.id, world);
    });

    // Load rooms
    const rooms = await transport.loadRoomsFromDatabase();
    for (const room of rooms) {
      // Load participants for each room
      const participants = await transport.loadParticipantsFromDatabase(room.id);
      const roomWithParticipants: MessageBusRoom = {
        ...room,
        participants,
      };
      this.rooms.set(room.id, roomWithParticipants);
    }

    // Note: Messages are loaded on-demand by agents via runtime.getMemories()
  }

  /**
   * Wait for all pending persistence operations to complete
   * Useful for testing and ensuring data is fully persisted before shutdown
   */
  async waitForPersistence(): Promise<void> {
    if (this.supportsP()) {
      await (this.transport as any).waitForPersistence();
    }
  }
}
