---
sidebar_position: 9
---

# Entities

Entities in ElizaOS represent users, agents, or any participant that can interact within the system. They form the basis of the entity-component architecture, allowing for flexible data modeling and relationships across the platform.

![](/img/entities-component-architecture.svg)

## Entity Structure

An entity in ElizaOS has the following properties:

```typescript
interface Entity {
  /** Unique identifier, optional on creation */
  id?: UUID;

  /** Names of the entity */
  names: string[];

  /** Optional additional metadata */
  metadata?: { [key: string]: any };

  /** Agent ID this account is related to, for agents should be themselves */
  agentId: UUID;

  /** Optional array of components */
  components?: Component[];
}
```

| Property     | Description                                              |
| ------------ | -------------------------------------------------------- |
| `id`         | Unique identifier for the entity (optional on creation)  |
| `names`      | Array of names the entity is known by                    |
| `metadata`   | Additional information about the entity                  |
| `agentId`    | ID of the agent related to this entity                   |
| `components` | Array of modular data components attached to this entity |

## Components

Components are modular pieces of data attached to entities with the following structure:

```typescript
interface Component {
  id: UUID;
  entityId: UUID;
  agentId: UUID;
  roomId: UUID;
  worldId: UUID;
  sourceEntityId: UUID;
  type: string;
  data: {
    [key: string]: any;
  };
}
```

| Property         | Description                                       |
| ---------------- | ------------------------------------------------- |
| `id`             | Unique identifier for the component               |
| `entityId`       | ID of the entity this component belongs to        |
| `agentId`        | ID of the agent managing this component           |
| `roomId`         | ID of the room this component is associated with  |
| `worldId`        | ID of the world this component is associated with |
| `sourceEntityId` | ID of the entity that created this component      |
| `type`           | Type of component (e.g., "profile", "settings")   |
| `data`           | Additional data specific to this component type   |

## Entity Creation and Management

### Creating an Entity

```typescript
const entityId = await runtime.createEntity({
  names: ['John Doe', 'JohnD'],
  agentId: runtime.agentId,
  metadata: {
    discord: {
      username: 'john_doe',
      name: 'John Doe',
    },
  },
});
```

### Retrieving an Entity

```typescript
// Get an entity by ID
const entity = await runtime.getEntityById(entityId);

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
});
```

## Component Management

Components allow for flexible data modeling by attaching different types of data to entities.

### Creating a Component

```typescript
await runtime.createComponent({
  id: componentId,
  entityId: entityId,
  agentId: runtime.agentId,
  roomId: roomId,
  worldId: worldId,
  sourceEntityId: creatorEntityId,
  type: 'profile',
  data: {
    bio: 'Software developer interested in AI',
    location: 'San Francisco',
    website: 'https://example.com',
  },
});
```

### Retrieving Components

```typescript
// Get a specific component type
const profileComponent = await runtime.getComponent(
  entityId,
  'profile',
  worldId, // optional filter by world
  sourceEntityId // optional filter by source
);

// Get all components for an entity
const allComponents = await runtime.getComponents(entityId, worldId, sourceEntityId);
```

### Updating Components

```typescript
await runtime.updateComponent({
  id: profileComponent.id,
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

Entities can have relationships with other entities, stored in the database:

```typescript
// Create a relationship between entities
await runtime.createRelationship({
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
  ...relationship,
  metadata: {
    ...relationship.metadata,
    interactions: relationship.metadata.interactions + 1,
    lastInteraction: Date.now(),
  },
});
```

## Entity Resolution

ElizaOS includes a system for resolving entity references from messages and context. This is particularly useful for determining which entity is being referenced in a conversation.

```typescript
// Find an entity by name or reference
const entity = await findEntityByName(runtime, message, state);
```

The entity resolution system considers:

1. Exact matches by ID or username
2. Contextual matches from recent conversations
3. Relationship strength between entities
4. Role-based permissions in worlds

## Entity Details

To get formatted information about entities in a room:

```typescript
// Get detailed information about entities in a room
const entityDetails = await getEntityDetails({
  runtime,
  roomId,
});

// Format entities into a string representation
const formattedEntities = formatEntities({ entities: entitiesInRoom });
```

## Relationship with Rooms and Worlds

Entities participate in rooms and, by extension, in worlds:

```typescript
// Add an entity as a participant in a room
await runtime.addParticipant(entityId, roomId);

// Get all rooms where an entity is a participant
const entityRooms = await runtime.getRoomsForParticipant(entityId);

// Get all participants in a room
const participants = await runtime.getParticipantsForRoom(roomId);
```

When an entity is a participant in a room that belongs to a world, the entity has an implicit relationship with that world.

## Creating Unique Entity IDs

For situations where you need to create deterministic, unique IDs for entity-agent pairs:

```typescript
const uniqueId = createUniqueUuid(runtime, baseUserId);
```

This ensures that each user-agent interaction has a consistent, unique identifier.

## Best Practices

1. **Use meaningful names**: Provide descriptive names in the `names` array to make entity identification easier
2. **Structure metadata carefully**: Organize metadata by source (e.g., `discord`, `telegram`) for clarity
3. **Component segregation**: Use components to separate different aspects of entity data rather than storing everything in metadata
4. **Permission checking**: Always verify permissions before accessing components created by other entities
5. **Relationship maintenance**: Update relationship metadata regularly to reflect recent interactions
6. **Entity resolution**: Use the entity resolution system to correctly identify entities in conversations
7. **Deterministic IDs**: Use `createUniqueUuid` for consistent entity identification across sessions
