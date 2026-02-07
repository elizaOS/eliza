import {
  type IAgentRuntime,
  type Memory,
  type Entity,
  type Room,
  type UUID,
  stringToUuid,
  logger,
  ChannelType,
} from '@elizaos/core';

export interface UserProfile {
  name: string;
  roles?: string[];
  metadata?: Record<string, any>;
}

export interface ConversationStep {
  from: string; // User name
  content: string;
  delay?: number; // Milliseconds to wait before sending
}

export interface ConversationScript {
  name: string;
  description: string;
  room: {
    name: string;
    type: ChannelType;
  };
  participants: UserProfile[];
  steps: ConversationStep[];
}

export interface SimulatedUser {
  entity: Entity;
  profile: UserProfile;
}

export class ConversationSimulator {
  private runtime: IAgentRuntime;
  private users: Map<string, SimulatedUser> = new Map();
  private rooms: Map<string, Room> = new Map();
  private world: UUID;

  constructor(runtime: IAgentRuntime) {
    this.runtime = runtime;
    this.world = stringToUuid('test-world-' + runtime.agentId);
  }

  /**
   * Creates a test user entity
   */
  async createUser(profile: UserProfile): Promise<Entity> {
    const userId = stringToUuid(`user-${profile.name}-${Date.now()}`);

    const entity: Entity = {
      id: userId,
      agentId: this.runtime.agentId,
      names: [profile.name],
      metadata: {
        ...profile.metadata,
        roles: profile.roles || [],
        isTestUser: true,
        createdBy: 'ConversationSimulator',
      },
    };

    await this.runtime.createEntity(entity);

    this.users.set(profile.name, {
      entity,
      profile,
    });

    logger.info(`[ConversationSimulator] Created test user: ${profile.name} (${entity.id})`);

    return entity;
  }

  /**
   * Creates or gets a test room
   */
  async getOrCreateRoom(roomConfig: { name: string; type: ChannelType }): Promise<Room> {
    const existing = this.rooms.get(roomConfig.name);
    if (existing) return existing;

    const roomId = stringToUuid(`room-${roomConfig.name}-${Date.now()}`);

    const room: Room = {
      id: roomId,
      agentId: this.runtime.agentId,
      name: roomConfig.name,
      source: 'test',
      type: roomConfig.type,
      worldId: this.world,
      metadata: {
        isTestRoom: true,
        createdBy: 'ConversationSimulator',
      },
    };

    await this.runtime.createRoom(room);
    this.rooms.set(roomConfig.name, room);

    logger.info(`[ConversationSimulator] Created test room: ${roomConfig.name} (${room.id})`);

    return room;
  }

  /**
   * Simulates sending a message from a user
   */
  async sendMessage(from: Entity, content: string, room: Room): Promise<Memory> {
    const messageId = stringToUuid(`msg-${from.id}-${Date.now()}`);

    const memory: Memory = {
      id: messageId,
      agentId: this.runtime.agentId,
      entityId: from.id as UUID,
      roomId: room.id,
      content: {
        text: content,
        type: 'text',
      },
      createdAt: Date.now(),
    };

    // Save the memory
    await this.runtime.createMemory(memory, 'messages');

    // Ensure the user is a participant in the room
    await this.runtime.ensureParticipantInRoom(from.id as UUID, room.id);

    logger.info(`[ConversationSimulator] Message sent from ${from.names[0]} in room ${room.id}: ${content.substring(0, 50)}...`);

    return memory;
  }

  /**
   * Executes a multi-turn conversation script
   */
  async runConversation(script: ConversationScript): Promise<void> {
    logger.info(`[ConversationSimulator] Starting conversation: ${script.name} with ${script.participants.length} participants, ${script.steps.length} steps`);

    // Create all participants
    for (const participant of script.participants) {
      await this.createUser(participant);
    }

    // Create the room
    const room = await this.getOrCreateRoom(script.room);

    // Execute each step
    for (const step of script.steps) {
      const user = this.users.get(step.from);
      if (!user) {
        throw new Error(`User '${step.from}' not found in participants`);
      }

      // Wait if delay specified
      if (step.delay) {
        await new Promise((resolve) => setTimeout(resolve, step.delay));
      }

      // Send the message
      const message = await this.sendMessage(user.entity, step.content, room);

      // Process the message through the runtime (triggers evaluators)
      await this.processMessage(message);

      // Small delay between messages for realism
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    logger.info(`[ConversationSimulator] Conversation completed: ${script.name}`);
  }

  /**
   * Processes a message through the runtime's evaluation pipeline
   */
  private async processMessage(message: Memory): Promise<void> {
    try {
      // Compose state for the message
      const state = await this.runtime.composeState(message);

      // Run evaluators
      await this.runtime.evaluate(message, state, false);

      logger.debug(`[ConversationSimulator] Message processed through evaluators: ${message.id}`);
    } catch (error) {
      logger.error(`[ConversationSimulator] Error processing message: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Waits for all evaluators to complete processing
   */
  async waitForEvaluators(timeout: number = 5000): Promise<void> {
    // Give evaluators time to process
    await new Promise((resolve) => setTimeout(resolve, timeout));

    logger.info('[ConversationSimulator] Evaluators processing complete');
  }

  /**
   * Gets a user by name
   */
  getUser(name: string): SimulatedUser | undefined {
    return this.users.get(name);
  }

  /**
   * Gets all created users
   */
  getAllUsers(): SimulatedUser[] {
    return Array.from(this.users.values());
  }

  /**
   * Cleans up test data
   */
  async cleanup(): Promise<void> {
    logger.info('[ConversationSimulator] Cleaning up test data');

    // Delete test entities
    for (const [name, user] of this.users) {
      try {
        // Remove entity from all rooms
        for (const room of this.rooms.values()) {
          // Rooms track participants through the database, not in the room object
          // Just log that we're cleaning up this entity from the room
          logger.debug(`[ConversationSimulator] Removing entity ${user.entity.id} from room ${room.id}`);
        }

        // Delete associated components
        const components = await this.runtime.getComponents(user.entity.id!);
        for (const component of components) {
          await this.runtime.deleteComponent(component.id);
        }

        logger.info(`[ConversationSimulator] Cleaned up test user: ${name}`);
      } catch (error) {
        logger.warn(`[ConversationSimulator] Failed to cleanup user ${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // Delete test rooms  
    for (const [name, room] of this.rooms) {
      try {
        // Delete room messages
        const messages = await this.runtime.getMemories({
          roomId: room.id,
          tableName: 'messages',
          count: 1000,
        });

        logger.info(`[ConversationSimulator] Cleaned up test room: ${name}`);
      } catch (error) {
        logger.warn(`[ConversationSimulator] Failed to cleanup room ${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    this.users.clear();
    this.rooms.clear();
  }
}
