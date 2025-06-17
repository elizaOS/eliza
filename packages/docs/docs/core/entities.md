---
sidebar_position: 9
title: Entities System
description: Understanding ElizaOS entities - users, agents, and participants in the entity-component architecture
keywords: [entities, components, users, agents, participants, relationships, data modeling]
image: /img/entities-component-architecture.svg
---

# Entities

Entities in ElizaOS represent users, agents, or any participant that can interact within the system. They form the basis of the entity-component architecture, allowing for flexible data modeling and relationships across the platform.

![](/img/entities-component-architecture.svg)

## Entity Structure

An entity in ElizaOS has the following properties:

```typescript
interface Entity {
  /** Unique identifier */
  id: UUID;

  /** Array of names the entity is known by */
  names: string[];

  /** Optional additional metadata */
  metadata?: { [key: string]: any };

  /** Agent ID this entity is associated with */
  agentId: UUID;

  /** Optional array of components */
  components?: Component[];
}
```

| Property     | Description                                              |
| ------------ | -------------------------------------------------------- |
| `id`         | Unique identifier for the entity                         |
| `names`      | Array of names the entity is known by                    |
| `metadata`   | Additional information about the entity                  |
| `agentId`    | ID of the agent this entity is associated with           |
| `components` | Array of modular data components attached to this entity |

## Components

Components are modular pieces of data attached to entities with the following structure:

```typescript
interface Component {
  id: UUID;
  entityId: UUID;
  type: string;
  data: { [key: string]: any };
  worldId?: UUID;
  agentId: UUID;
  roomId: UUID;
  sourceEntityId?: UUID;
  createdAt: number;
}
```

| Property         | Description                                           |
| ---------------- | ----------------------------------------------------- |
| `id`             | Unique identifier for the component                   |
| `entityId`       | ID of the entity this component belongs to            |
| `type`           | Type of component (e.g., "profile", "settings")       |
| `data`           | Additional data specific to this component type       |
| `worldId`        | Optional ID of the world this component is in         |
| `agentId`        | ID of the agent managing this component               |
| `roomId`         | ID of the room this component is associated with      |
| `sourceEntityId` | Optional ID of the entity that created this component |
| `createdAt`      | Timestamp when the component was created              |

## Entity Creation and Management

### Creating an Entity

```typescript
// Create a single entity
const success = await runtime.createEntity({
  id: entityId, // Optional, will be generated if not provided
  names: ['John Doe', 'JohnD'],
  agentId: runtime.agentId,
  metadata: {
    discord: {
      id: 'discord-user-id',
      username: 'john_doe',
      name: 'John Doe',
    },
  },
});

// Create multiple entities at once
const success = await runtime.createEntities([
  { id: entity1Id, names: ['User 1'], agentId: runtime.agentId },
  { id: entity2Id, names: ['User 2'], agentId: runtime.agentId },
]);
```

### Retrieving Entities

```typescript
// Get an entity by ID
const entity = await runtime.getEntityById(entityId);

// Get multiple entities by IDs
const entities = await runtime.getEntityByIds([entityId1, entityId2]);

// Get all entities in a room
const entitiesInRoom = await runtime.getEntitiesForRoom(roomId, true); // true to include components
```

### Updating an Entity

```typescript
await runtime.updateEntity({
  id: entityId,
  names: [...entity.names, 'Johnny'],
  metadata: {
    ...entity.metadata,
    customProperty: 'value',
  },
  agentId: entity.agentId,
});
```

### Deleting an Entity

```typescript
await runtime.adapter.deleteEntity(entityId);
```

## Component Management

Components allow for flexible data modeling by attaching different types of data to entities.

### Creating a Component

```typescript
const success = await runtime.createComponent({
  id: componentId, // Will be generated if not provided
  entityId: entityId,
  agentId: runtime.agentId,
  roomId: roomId,
  worldId: worldId, // Optional
  sourceEntityId: creatorEntityId, // Optional
  type: 'profile',
  data: {
    bio: 'Software developer interested in AI',
    location: 'San Francisco',
    website: 'https://example.com',
  },
  createdAt: Date.now(),
});
```

### Retrieving Components

```typescript
// Get a specific component type for an entity
const profileComponent = await runtime.getComponent(
  entityId,
  'profile',
  worldId, // optional filter by world
  sourceEntityId // optional filter by source
);

// Get all components for an entity
const allComponents = await runtime.getComponents(
  entityId,
  worldId, // optional filter by world
  sourceEntityId // optional filter by source
);
```

### Updating Components

```typescript
await runtime.updateComponent({
  ...profileComponent,
  data: {
    ...profileComponent.data,
    bio: 'Updated bio information',
  },
});
```

### Deleting Components

```typescript
await runtime.deleteComponent(componentId);
```

## Entity Relationships

Entities can have relationships with other entities:

```typescript
// Create a relationship between entities
const success = await runtime.createRelationship({
  sourceEntityId: entityId1,
  targetEntityId: entityId2,
  tags: ['friend', 'collaborator'],
  metadata: {
    interactions: 5,
    lastInteraction: Date.now(),
  },
});

// Get relationships for an entity
const relationships = await runtime.getRelationships({
  entityId: entityId1,
  tags: ['friend'], // optional filter by tags
});

// Get a specific relationship
const relationship = await runtime.getRelationship({
  sourceEntityId: entityId1,
  targetEntityId: entityId2,
});

// Update a relationship
await runtime.updateRelationship({
  id: relationship.id,
  sourceEntityId: relationship.sourceEntityId,
  targetEntityId: relationship.targetEntityId,
  agentId: relationship.agentId,
  tags: relationship.tags,
  metadata: {
    ...relationship.metadata,
    interactions: relationship.metadata.interactions + 1,
    lastInteraction: Date.now(),
  },
  createdAt: relationship.createdAt,
});
```

## Entity Names and Search

ElizaOS provides methods to search for entities by their names:

```typescript
// Get entities by exact names
const entities = await runtime.adapter.getEntitiesByNames({
  names: ['John Doe', 'Jane Smith'],
  agentId: runtime.agentId,
});

// Search entities by name with fuzzy matching
const searchResults = await runtime.adapter.searchEntitiesByName({
  query: 'john',
  agentId: runtime.agentId,
  limit: 10, // optional, defaults to 10
});
```

## Entities and Room Participation

Entities participate in rooms through the participant system:

```typescript
// Add an entity as a participant in a room
const success = await runtime.addParticipant(entityId, roomId);

// Add multiple entities to a room at once
const success = await runtime.addParticipantsRoom([entityId1, entityId2], roomId);

// Remove an entity from a room
const success = await runtime.removeParticipant(entityId, roomId);

// Get all rooms where an entity is a participant
const roomIds = await runtime.getRoomsForParticipant(entityId);

// Get all participants in a room
const participantIds = await runtime.getParticipantsForRoom(roomId);

// Get participant details for an entity
const participants = await runtime.getParticipantsForEntity(entityId);
```

### Participant User States

Participants can have states within rooms:

```typescript
// Get participant state in a room
const state = await runtime.getParticipantUserState(roomId, entityId);
// Returns: 'FOLLOWED' | 'MUTED' | null

// Set participant state
await runtime.setParticipantUserState(roomId, entityId, 'FOLLOWED');
await runtime.setParticipantUserState(roomId, entityId, 'MUTED');
await runtime.setParticipantUserState(roomId, entityId, null); // Clear state
```

## Creating Unique Entity IDs

For deterministic entity ID generation based on agent and user identifiers:

```typescript
import { createUniqueUuid } from '@elizaos/core';

// Create a unique ID for an entity-agent pair
const uniqueEntityId = createUniqueUuid(agentId, userId);
```

This ensures consistent entity IDs across sessions for the same user-agent combination.

## Best Practices

1. **Entity ID Management**: Use `createUniqueUuid` for consistent entity identification across sessions when you have stable user identifiers
2. **Name Arrays**: Store multiple variations of names (e.g., username, display name) to improve entity resolution
3. **Metadata Organization**: Structure metadata by source platform (e.g., `discord`, `telegram`) for clarity
4. **Component Types**: Use consistent component type names across your application for easier querying
5. **Relationship Tracking**: Update relationship metadata to reflect interaction patterns and frequency
6. **Bulk Operations**: Use `createEntities` and `addParticipantsRoom` for better performance when handling multiple entities
7. **Room Participation**: Always ensure entities are properly added as participants before they interact in rooms
8. **Component Lifecycle**: Clean up components when they're no longer needed to maintain database efficiency
