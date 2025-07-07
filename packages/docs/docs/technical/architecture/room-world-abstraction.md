# Room/World Abstraction and UUID System

ElizaOS implements a sophisticated abstraction layer that maps platform-specific concepts (Discord servers, Telegram groups, etc.) to universal Room and World concepts, while maintaining agent-specific perspectives through deterministic UUID generation.

## Overview

The Room/World abstraction system provides:

1. **Platform Abstraction** - Universal concepts across different platforms
2. **Agent Perspectives** - Each agent has unique UUIDs for the same entities
3. **Hierarchical Organization** - Worlds contain rooms, rooms contain conversations
4. **Isolation Boundaries** - Proper data separation between contexts

## Core Concepts

### Entity Hierarchy

```typescript
// Universal entity hierarchy
World (Discord Server, Telegram Group, etc.)
  └── Room (Discord Channel, Telegram Chat, etc.)
      └── Conversation (Message threads)
          └── Message (Individual messages)
              └── Entity (Users, Agents)
```

### Type Definitions

```typescript
// packages/core/src/types/environment.ts

interface World {
  id: UUID;
  name: string;
  description?: string;
  metadata: {
    platform?: string; // 'discord', 'telegram', etc.
    platformId?: string; // Original platform ID
    owner?: UUID; // World owner entity
    permissions?: Permission[];
    settings?: WorldSettings;
  };
  entities: UUID[]; // Entities with access to this world
  rooms: UUID[]; // Rooms within this world
  createdAt: Date;
  updatedAt: Date;
}

interface Room {
  id: UUID;
  worldId: UUID; // Parent world
  name: string;
  description?: string;
  type: ChannelType; // Channel classification
  metadata: {
    platform?: string; // Origin platform
    platformId?: string; // Original platform room ID
    permissions?: Permission[];
    settings?: RoomSettings;
  };
  participants: UUID[]; // Active participants
  createdAt: Date;
  updatedAt: Date;
}

enum ChannelType {
  SELF = 'SELF', // Agent's private channel
  DM = 'DM', // Direct message
  GROUP = 'GROUP', // Group chat
  VOICE_DM = 'VOICE_DM', // Voice direct message
  VOICE_GROUP = 'VOICE_GROUP', // Voice group chat
  FEED = 'FEED', // Social media feed
  THREAD = 'THREAD', // Threaded conversation
  WORLD = 'WORLD', // World-level channel
  FORUM = 'FORUM', // Forum-style discussion
}

interface Entity {
  id: UUID;
  name: string;
  username?: string;
  metadata: {
    platform?: string; // Origin platform
    platformId?: string; // Original platform user ID
    avatar?: string;
    bio?: string;
    roles?: string[];
    settings?: EntitySettings;
  };
  components: Component[]; // Extensible entity properties
  createdAt: Date;
  updatedAt: Date;
}
```

## UUID System Architecture

### Deterministic UUID Generation

The UUID system ensures each agent has a unique perspective on the same entities:

```typescript
// packages/core/src/utils.ts

function stringToUuid(target: string): UUID {
  // Generate deterministic UUID from string using SHA1
  const hash = crypto.createHash('sha1').update(target).digest('hex');

  // Convert to UUID v4 format
  return [
    hash.substring(0, 8),
    hash.substring(8, 12),
    '4' + hash.substring(13, 16), // Version 4 identifier
    ((parseInt(hash.substring(16, 17), 16) & 0x3) | 0x8).toString(16) + hash.substring(17, 20),
    hash.substring(20, 32),
  ].join('-') as UUID;
}

function createUniqueUuid(runtime: IAgentRuntime, baseUserId: UUID | string): UUID {
  // Agent-specific UUID swizzling
  const combinedString = `${baseUserId}:${runtime.agentId}`;
  return stringToUuid(combinedString);
}
```

### Agent Perspective System

Each agent maintains its own UUID mapping for entities:

```typescript
// packages/core/src/entities.ts

class EntityManager {
  constructor(private runtime: IAgentRuntime) {}

  // Get agent-specific UUID for an entity
  async getEntityId(platformId: string, platform: string): Promise<UUID> {
    // Create deterministic UUID based on platform and agent
    const baseId = `${platform}:${platformId}`;
    return createUniqueUuid(this.runtime, baseId);
  }

  // Ensure entity exists with agent-specific perspective
  async ensureEntityExists(entityData: {
    platformId: string;
    platform: string;
    name: string;
    username?: string;
    metadata?: any;
  }): Promise<Entity> {
    const entityId = await this.getEntityId(entityData.platformId, entityData.platform);

    // Check if entity already exists
    const existing = await this.runtime.databaseAdapter.getEntity({ id: entityId });
    if (existing) {
      return existing;
    }

    // Create new entity with agent-specific UUID
    const entity: Entity = {
      id: entityId,
      name: entityData.name,
      username: entityData.username,
      metadata: {
        platform: entityData.platform,
        platformId: entityData.platformId,
        ...entityData.metadata,
      },
      components: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await this.runtime.databaseAdapter.createEntity(entity);
    return entity;
  }
}
```

## Platform Mapping

### Discord Integration

```typescript
// packages/plugin-discord/src/environment.ts

class DiscordEnvironmentManager {
  async mapDiscordToWorld(guild: Guild): Promise<World> {
    const worldId = stringToUuid(`discord:guild:${guild.id}`);

    return {
      id: worldId,
      name: guild.name,
      description: guild.description || undefined,
      metadata: {
        platform: 'discord',
        platformId: guild.id,
        owner: await this.getGuildOwnerEntityId(guild.ownerId),
        permissions: await this.mapGuildPermissions(guild),
        settings: {
          memberCount: guild.memberCount,
          features: guild.features,
          verificationLevel: guild.verificationLevel,
        },
      },
      entities: await this.getGuildMemberEntityIds(guild),
      rooms: await this.getGuildChannelRoomIds(guild),
      createdAt: guild.createdAt,
      updatedAt: new Date(),
    };
  }

  async mapDiscordToRoom(channel: GuildChannel | DMChannel, worldId?: UUID): Promise<Room> {
    const roomId = stringToUuid(`discord:channel:${channel.id}`);

    return {
      id: roomId,
      worldId: worldId || stringToUuid(`discord:guild:${channel.guild?.id || 'dm'}`),
      name: channel.name || 'Direct Message',
      description: 'description' in channel ? channel.description : undefined,
      type: this.mapChannelType(channel),
      metadata: {
        platform: 'discord',
        platformId: channel.id,
        permissions: await this.mapChannelPermissions(channel),
        settings: {
          nsfw: 'nsfw' in channel ? channel.nsfw : false,
          rateLimitPerUser: 'rateLimitPerUser' in channel ? channel.rateLimitPerUser : 0,
        },
      },
      participants: await this.getChannelParticipantEntityIds(channel),
      createdAt: channel.createdAt,
      updatedAt: new Date(),
    };
  }

  private mapChannelType(channel: GuildChannel | DMChannel): ChannelType {
    if (channel.type === ChannelType.DM) return ChannelType.DM;
    if (channel.type === ChannelType.GROUP_DM) return ChannelType.GROUP;
    if (channel.type === ChannelType.GUILD_VOICE) return ChannelType.VOICE_GROUP;
    if (channel.type === ChannelType.GUILD_TEXT) return ChannelType.GROUP;
    if (channel.type === ChannelType.GUILD_FORUM) return ChannelType.FORUM;
    return ChannelType.GROUP; // Default fallback
  }
}
```

### Telegram Integration

```typescript
// packages/plugin-telegram/src/environment.ts

class TelegramEnvironmentManager {
  async mapTelegramToWorld(chat: Chat): Promise<World> {
    const worldId = stringToUuid(`telegram:chat:${chat.id}`);

    return {
      id: worldId,
      name: chat.title || `Chat ${chat.id}`,
      description: chat.description,
      metadata: {
        platform: 'telegram',
        platformId: chat.id.toString(),
        settings: {
          type: chat.type,
          memberCount:
            'all_members_are_administrators' in chat
              ? chat.all_members_are_administrators
              : undefined,
          inviteLink: 'invite_link' in chat ? chat.invite_link : undefined,
        },
      },
      entities: await this.getChatMemberEntityIds(chat),
      rooms: [worldId], // Telegram chats are typically single-room
      createdAt: new Date(), // Telegram doesn't provide creation time
      updatedAt: new Date(),
    };
  }

  async mapTelegramToRoom(chat: Chat, worldId?: UUID): Promise<Room> {
    const roomId = stringToUuid(`telegram:chat:${chat.id}`);

    return {
      id: roomId,
      worldId: worldId || roomId, // Self-contained for Telegram
      name: chat.title || `Chat ${chat.id}`,
      description: chat.description,
      type: this.mapChatType(chat),
      metadata: {
        platform: 'telegram',
        platformId: chat.id.toString(),
        settings: {
          type: chat.type,
          username: 'username' in chat ? chat.username : undefined,
        },
      },
      participants: await this.getChatMemberEntityIds(chat),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  private mapChatType(chat: Chat): ChannelType {
    switch (chat.type) {
      case 'private':
        return ChannelType.DM;
      case 'group':
        return ChannelType.GROUP;
      case 'supergroup':
        return ChannelType.GROUP;
      case 'channel':
        return ChannelType.FEED;
      default:
        return ChannelType.GROUP;
    }
  }
}
```

## Environment Context Management

### World Creation and Management

```typescript
// packages/core/src/environment.ts

class WorldManager {
  constructor(private runtime: IAgentRuntime) {}

  async ensureWorldExists(worldData: {
    platformId: string;
    platform: string;
    name: string;
    description?: string;
    metadata?: any;
  }): Promise<World> {
    const worldId = stringToUuid(`${worldData.platform}:world:${worldData.platformId}`);

    // Check if world already exists
    const existing = await this.runtime.databaseAdapter.getWorld({ id: worldId });
    if (existing) {
      return existing;
    }

    // Create new world
    const world: World = {
      id: worldId,
      name: worldData.name,
      description: worldData.description,
      metadata: {
        platform: worldData.platform,
        platformId: worldData.platformId,
        ...worldData.metadata,
      },
      entities: [],
      rooms: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await this.runtime.databaseAdapter.createWorld(world);
    return world;
  }

  async addEntityToWorld(worldId: UUID, entityId: UUID): Promise<void> {
    const world = await this.runtime.databaseAdapter.getWorld({ id: worldId });
    if (world && !world.entities.includes(entityId)) {
      world.entities.push(entityId);
      world.updatedAt = new Date();
      await this.runtime.databaseAdapter.updateWorld(world);
    }
  }

  async addRoomToWorld(worldId: UUID, roomId: UUID): Promise<void> {
    const world = await this.runtime.databaseAdapter.getWorld({ id: worldId });
    if (world && !world.rooms.includes(roomId)) {
      world.rooms.push(roomId);
      world.updatedAt = new Date();
      await this.runtime.databaseAdapter.updateWorld(world);
    }
  }
}
```

### Room Context Management

```typescript
class RoomManager {
  constructor(private runtime: IAgentRuntime) {}

  async ensureRoomExists(roomData: {
    platformId: string;
    platform: string;
    worldId: UUID;
    name: string;
    type: ChannelType;
    metadata?: any;
  }): Promise<Room> {
    const roomId = stringToUuid(`${roomData.platform}:room:${roomData.platformId}`);

    const existing = await this.runtime.databaseAdapter.getRoom({ id: roomId });
    if (existing) {
      return existing;
    }

    const room: Room = {
      id: roomId,
      worldId: roomData.worldId,
      name: roomData.name,
      type: roomData.type,
      metadata: {
        platform: roomData.platform,
        platformId: roomData.platformId,
        ...roomData.metadata,
      },
      participants: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await this.runtime.databaseAdapter.createRoom(room);

    // Add room to world
    const worldManager = new WorldManager(this.runtime);
    await worldManager.addRoomToWorld(roomData.worldId, roomId);

    return room;
  }

  async addParticipantToRoom(roomId: UUID, entityId: UUID): Promise<void> {
    const room = await this.runtime.databaseAdapter.getRoom({ id: roomId });
    if (room && !room.participants.includes(entityId)) {
      room.participants.push(entityId);
      room.updatedAt = new Date();
      await this.runtime.databaseAdapter.updateRoom(room);
    }
  }

  async removeParticipantFromRoom(roomId: UUID, entityId: UUID): Promise<void> {
    const room = await this.runtime.databaseAdapter.getRoom({ id: roomId });
    if (room) {
      room.participants = room.participants.filter((id) => id !== entityId);
      room.updatedAt = new Date();
      await this.runtime.databaseAdapter.updateRoom(room);
    }
  }
}
```

## Component System

### Entity Components

```typescript
// packages/core/src/types/component.ts

interface Component {
  id: UUID;
  type: ComponentType;
  entityId: UUID;
  data: any;
  metadata?: {
    source?: string;
    platform?: string;
    updatedAt: Date;
    [key: string]: any;
  };
}

enum ComponentType {
  PROFILE = 'profile', // User profile data
  PERMISSIONS = 'permissions', // Access permissions
  PREFERENCES = 'preferences', // User preferences
  ACTIVITY = 'activity', // Activity tracking
  RELATIONSHIPS = 'relationships', // Social connections
  CUSTOM = 'custom', // Custom component types
}

class ComponentManager {
  constructor(private runtime: IAgentRuntime) {}

  async addComponent(
    entityId: UUID,
    component: Omit<Component, 'id' | 'entityId'>
  ): Promise<Component> {
    const componentId = stringToUuid(`${entityId}:${component.type}:${Date.now()}`);

    const fullComponent: Component = {
      id: componentId,
      entityId,
      ...component,
      metadata: {
        ...component.metadata,
        updatedAt: new Date(),
      },
    };

    await this.runtime.databaseAdapter.createComponent(fullComponent);
    return fullComponent;
  }

  async getEntityComponents(entityId: UUID, type?: ComponentType): Promise<Component[]> {
    return this.runtime.databaseAdapter.getComponents({
      entityId,
      type,
    });
  }

  async updateComponent(componentId: UUID, data: any): Promise<void> {
    const component = await this.runtime.databaseAdapter.getComponent({ id: componentId });
    if (component) {
      component.data = { ...component.data, ...data };
      component.metadata = {
        ...component.metadata,
        updatedAt: new Date(),
      };
      await this.runtime.databaseAdapter.updateComponent(component);
    }
  }
}
```

## Memory Context Integration

### Context-Aware Memory Storage

```typescript
class ContextualMemoryManager {
  constructor(private runtime: IAgentRuntime) {}

  async createMemoryWithContext(
    content: Content,
    context: {
      entityId: UUID;
      worldId?: UUID;
      roomId?: UUID;
      type: MemoryType;
      scope: 'private' | 'room' | 'shared';
    }
  ): Promise<Memory> {
    const memory: Memory = {
      id: stringToUuid(`${context.entityId}:${Date.now()}`),
      entityId: context.entityId,
      worldId: context.worldId,
      roomId: context.roomId,
      content,
      type: context.type,
      metadata: {
        scope: context.scope,
        source: content.source || 'unknown',
        timestamp: Date.now(),
      },
    };

    // Apply agent-specific UUID swizzling for agent's perspective
    const agentMemory = this.swizzleMemoryForAgent(memory);

    await this.runtime.memory.create(agentMemory);
    return agentMemory;
  }

  private swizzleMemoryForAgent(memory: Memory): Memory {
    // Create agent-specific view of the memory
    return {
      ...memory,
      id: createUniqueUuid(this.runtime, memory.id),
      entityId: createUniqueUuid(this.runtime, memory.entityId),
      worldId: memory.worldId ? createUniqueUuid(this.runtime, memory.worldId) : undefined,
      roomId: memory.roomId ? createUniqueUuid(this.runtime, memory.roomId) : undefined,
    };
  }

  async searchMemoriesInContext(
    query: string,
    context: {
      worldId?: UUID;
      roomId?: UUID;
      scope?: 'private' | 'room' | 'shared';
    }
  ): Promise<Memory[]> {
    const embedding = await this.runtime.embed(query);

    return this.runtime.memory.searchMemoriesByEmbedding(embedding, {
      match_threshold: 0.7,
      count: 10,
      tableName: 'memories',
      worldId: context.worldId,
      roomId: context.roomId,
    });
  }
}
```

## Cross-Platform Entity Resolution

### Entity Linking

```typescript
class EntityLinkingManager {
  constructor(private runtime: IAgentRuntime) {}

  async linkEntitiesAcrossPlatforms(
    primaryEntityId: UUID,
    secondaryEntityId: UUID,
    linkType: 'same_person' | 'alias' | 'bot_account'
  ): Promise<void> {
    // Create bidirectional link between entities
    await this.createEntityLink(primaryEntityId, secondaryEntityId, linkType);
    await this.createEntityLink(secondaryEntityId, primaryEntityId, linkType);
  }

  private async createEntityLink(
    fromEntityId: UUID,
    toEntityId: UUID,
    linkType: string
  ): Promise<void> {
    const component: Omit<Component, 'id' | 'entityId'> = {
      type: ComponentType.RELATIONSHIPS,
      data: {
        linkedEntity: toEntityId,
        linkType,
        strength: 1.0,
        verified: false,
      },
      metadata: {
        source: 'entity_linking',
        updatedAt: new Date(),
      },
    };

    const componentManager = new ComponentManager(this.runtime);
    await componentManager.addComponent(fromEntityId, component);
  }

  async resolveEntityAliases(entityId: UUID): Promise<UUID[]> {
    const componentManager = new ComponentManager(this.runtime);
    const relationships = await componentManager.getEntityComponents(
      entityId,
      ComponentType.RELATIONSHIPS
    );

    return relationships
      .filter((comp) => comp.data.linkType === 'alias' || comp.data.linkType === 'same_person')
      .map((comp) => comp.data.linkedEntity);
  }
}
```

## Performance Optimizations

### UUID Caching

```typescript
class UUIDCache {
  private cache = new Map<string, UUID>();
  private readonly maxSize = 10000;

  getOrCreateUUID(key: string, generator: () => UUID): UUID {
    if (this.cache.has(key)) {
      return this.cache.get(key)!;
    }

    const uuid = generator();

    // Manage cache size
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }

    this.cache.set(key, uuid);
    return uuid;
  }

  invalidate(key: string): void {
    this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }
}
```

### Batch Entity Operations

```typescript
class BatchEntityManager {
  constructor(private runtime: IAgentRuntime) {}

  async createEntitiesBatch(entities: Omit<Entity, 'id'>[]): Promise<Entity[]> {
    const created: Entity[] = [];

    // Process in batches to avoid overwhelming the database
    const batchSize = 50;
    for (let i = 0; i < entities.length; i += batchSize) {
      const batch = entities.slice(i, i + batchSize);
      const batchResults = await this.processBatch(batch);
      created.push(...batchResults);
    }

    return created;
  }

  private async processBatch(entities: Omit<Entity, 'id'>[]): Promise<Entity[]> {
    const promises = entities.map(async (entityData) => {
      const entityId = stringToUuid(`${entityData.name}:${Date.now()}`);
      const entity: Entity = {
        id: entityId,
        ...entityData,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      await this.runtime.databaseAdapter.createEntity(entity);
      return entity;
    });

    return Promise.all(promises);
  }
}
```

This Room/World abstraction system provides ElizaOS with platform-agnostic entity management while maintaining proper isolation and agent-specific perspectives through deterministic UUID generation.
