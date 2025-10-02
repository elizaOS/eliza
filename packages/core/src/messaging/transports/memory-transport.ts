import type { IMessageTransport, Message, MessageBusRoom, MessageBusWorld } from '../types';
import type { UUID } from '../../types/primitives';
import type { IAgentRuntime } from '../../types/runtime';

/**
 * In-memory transport for testing and browser-only deployments
 *
 * This transport keeps all messages in memory and delivers them synchronously.
 * Perfect for:
 * - Browser-only multi-agent deployments
 * - Unit testing
 * - Offline-first applications
 * - Development and debugging
 *
 * With optional persistence:
 * - Inject an IAgentRuntime to persist data to PGLite/Postgres
 * - All data survives page refresh
 * - Single database instance (no PGLite conflicts)
 * - Respects foreign key constraints (world → room → participant → message)
 */
export class MemoryTransport implements IMessageTransport {
  private subscriptions = new Map<UUID, Set<(message: Message) => void>>();
  private messages: Message[] = [];

  // Persistence support
  private runtime?: IAgentRuntime;
  private persistenceEnabled: boolean;
  private persistenceQueue: Promise<void> = Promise.resolve();

  constructor(runtime?: IAgentRuntime, enablePersistence: boolean = false) {
    this.runtime = runtime;
    this.persistenceEnabled = enablePersistence && !!runtime;
  }

  /**
   * Connect (no-op for memory transport)
   */
  async connect(): Promise<void> {
    // No-op - already "connected"
  }

  /**
   * Disconnect and clear subscriptions
   */
  async disconnect(): Promise<void> {
    this.subscriptions.clear();
  }

  /**
   * Send a message (store and deliver to subscribers)
   */
  async sendMessage(message: Message): Promise<void> {
    // Store message in memory
    this.messages.push(message);

    // Deliver to subscribers immediately (synchronous, fast)
    const callbacks = this.subscriptions.get(message.roomId);
    if (callbacks) {
      callbacks.forEach((cb) => cb(message));
    }

    // Persist to database in background (if enabled)
    if (this.persistenceEnabled && this.runtime) {
      this.persistenceQueue = this.persistenceQueue
        .then(async () => {
          await this.persistMessage(message);
        })
        .catch((err) => {
          console.error('Failed to persist message:', err);
        });
    }
  }

  /**
   * Subscribe to messages in a room
   */
  subscribe(roomId: UUID, callback: (message: Message) => void): void {
    if (!this.subscriptions.has(roomId)) {
      this.subscriptions.set(roomId, new Set());
    }
    this.subscriptions.get(roomId)!.add(callback);
  }

  /**
   * Unsubscribe from messages in a room
   */
  unsubscribe(roomId: UUID): void {
    this.subscriptions.delete(roomId);
  }

  // ====== Persistence Methods ======

  /**
   * Persist a world to the database
   * @internal Used by MessageBus
   */
  async persistWorld(world: MessageBusWorld): Promise<void> {
    if (!this.persistenceEnabled || !this.runtime) {
      return;
    }

    this.persistenceQueue = this.persistenceQueue
      .then(async () => {
        await this.runtime!.ensureWorldExists({
          id: world.id,
          name: world.name || 'Unnamed World',
          agentId: this.runtime!.agentId,
          serverId: world.serverId,
          metadata: world.metadata,
        });
      })
      .catch((err) => {
        console.error('Failed to persist world:', err);
      });
  }

  /**
   * Persist a room to the database
   * @internal Used by MessageBus
   */
  async persistRoom(room: MessageBusRoom): Promise<void> {
    if (!this.persistenceEnabled || !this.runtime) {
      return;
    }

    this.persistenceQueue = this.persistenceQueue
      .then(async () => {
        if (!room.worldId) {
          console.warn('Room missing worldId, skipping persistence');
          return;
        }

        // Ensure world exists first
        await this.runtime!.ensureWorldExists({
          id: room.worldId,
          name: 'Default World',
          agentId: this.runtime!.agentId,
          serverId: room.serverId || 'default',
        });

        // Then create room
        await this.runtime!.ensureRoomExists({
          id: room.id,
          name: room.name,
          source: room.source,
          type: room.type,
          channelId: room.channelId,
          serverId: room.serverId,
          worldId: room.worldId,
          metadata: room.metadata,
        });
      })
      .catch((err) => {
        console.error('Failed to persist room:', err);
      });
  }

  /**
   * Persist a participant to the database
   * @internal Used by MessageBus
   */
  async persistParticipant(roomId: UUID, participantId: UUID): Promise<void> {
    if (!this.persistenceEnabled || !this.runtime) {
      return;
    }

    this.persistenceQueue = this.persistenceQueue
      .then(async () => {
        // Ensure participant entity exists
        const entity = await this.runtime!.getEntityById(participantId);
        if (!entity) {
          await this.runtime!.createEntity({
            id: participantId,
            names: [`User-${participantId.substring(0, 8)}`],
            agentId: this.runtime!.agentId,
            metadata: {},
          });
        }

        // Add participant to room
        await this.runtime!.ensureParticipantInRoom(participantId, roomId);
      })
      .catch((err) => {
        console.error('Failed to persist participant:', err);
      });
  }

  /**
   * Persist a message to the database
   * @internal
   */
  private async persistMessage(message: Message): Promise<void> {
    if (!this.runtime) {
      return;
    }

    // Ensure author entity exists
    const entity = await this.runtime.getEntityById(message.authorId);
    if (!entity) {
      await this.runtime.createEntity({
        id: message.authorId,
        names: [`User-${message.authorId.substring(0, 8)}`],
        agentId: this.runtime.agentId,
        metadata: {},
      });
    }

    // Convert attachments from Attachment[] to Media[] format
    const attachments = message.metadata?.attachments?.map((att) => ({
      id: att.id,
      url: att.url,
      title: att.title,
      source: message.metadata?.source,
      description: att.description,
      text: att.text,
      contentType: att.contentType as any, // Type assertion for compatibility
    }));

    // Save message to database
    await this.runtime.createMemory(
      {
        id: message.id,
        agentId: this.runtime.agentId,
        entityId: message.authorId,
        roomId: message.roomId,
        worldId: message.worldId,
        content: {
          text: message.content,
          source: message.metadata?.source,
          attachments,
          inReplyTo: message.inReplyTo,
        },
        createdAt: message.createdAt,
        metadata: message.metadata,
      },
      'messages'
    );
  }

  /**
   * Load worlds from database
   */
  async loadWorldsFromDatabase(): Promise<MessageBusWorld[]> {
    if (!this.runtime) {
      return [];
    }

    const worlds = await this.runtime.getAllWorlds();
    return worlds.map((world) => ({
      ...world,
      rooms: [], // Will be populated separately
    }));
  }

  /**
   * Load rooms from database
   */
  async loadRoomsFromDatabase(worldId?: UUID): Promise<MessageBusRoom[]> {
    if (!this.runtime) {
      return [];
    }

    const rooms = worldId
      ? await this.runtime.getRoomsByWorld(worldId)
      : (await this.runtime.getRoomsByIds([])) || [];

    if (!rooms) {
      return [];
    }

    return rooms.map((room) => ({
      ...room,
      participants: [], // Will be populated separately
    }));
  }

  /**
   * Load participants for a room from database
   */
  async loadParticipantsFromDatabase(roomId: UUID): Promise<UUID[]> {
    if (!this.runtime) {
      return [];
    }

    return await this.runtime.getParticipantsForRoom(roomId);
  }

  /**
   * Load messages from database
   */
  async loadMessagesFromDatabase(roomId?: UUID, limit: number = 100): Promise<Message[]> {
    if (!this.runtime) {
      return [];
    }

    const memories = roomId
      ? await this.runtime.getMemories({
          roomId,
          tableName: 'messages',
          count: limit,
        })
      : await this.runtime.getMemories({
          tableName: 'messages',
          count: limit,
        });

    return memories
      .filter((memory) => memory.id && memory.roomId && memory.worldId)
      .map((memory) => ({
        id: memory.id!,
        roomId: memory.roomId!,
        worldId: memory.worldId!,
        authorId: memory.entityId,
        content: memory.content.text || '',
        metadata: {
          type: 'message' as const,
          source: memory.content.source,
          attachments: (memory.content.attachments || []).map((att: any) => ({
            id: att.id || att.url,
            url: att.url,
            title: att.title,
            contentType: att.contentType,
            description: att.description,
            text: att.text,
          })),
          thought: (memory.metadata as any)?.thought,
          actions: (memory.metadata as any)?.actions,
        },
        createdAt: memory.createdAt || Date.now(),
        inReplyTo: memory.content.inReplyTo,
      }));
  }

  /**
   * Wait for all pending persistence operations to complete
   */
  async waitForPersistence(): Promise<void> {
    await this.persistenceQueue;
  }

  // ====== Test Helpers ======

  /**
   * Get all messages (for testing)
   */
  getMessages(): Message[] {
    return [...this.messages];
  }

  /**
   * Get messages for a specific room (for testing)
   */
  getMessagesForRoom(roomId: UUID): Message[] {
    return this.messages.filter((msg) => msg.roomId === roomId);
  }

  /**
   * Clear all messages and subscriptions (for testing)
   */
  clear(): void {
    this.messages = [];
    this.subscriptions.clear();
  }

  /**
   * Get subscription count (for testing)
   */
  getSubscriptionCount(): number {
    return this.subscriptions.size;
  }

  /**
   * Check if a room has subscribers (for testing)
   */
  hasSubscribers(roomId: UUID): boolean {
    return this.subscriptions.has(roomId);
  }

  /**
   * Check if persistence is enabled (for testing)
   */
  isPersistenceEnabled(): boolean {
    return this.persistenceEnabled;
  }
}
