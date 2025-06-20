import { v4 as uuidv4 } from 'uuid';
import { Relationship, Entity, Agent, UUID } from '@elizaos/core';

// Test IDs for relationship tests
export const relationshipTestAgentId = uuidv4() as UUID;
export const relationshipTestSourceEntityId = uuidv4() as UUID;
export const relationshipTestTargetEntityId = uuidv4() as UUID;

// Test data for relationship integration tests
export const relationshipTestAgent: Agent = {
  id: relationshipTestAgentId,
  name: 'Relationship Test Agent',
  bio: 'Test agent for relationship integration tests',
  settings: {
    profile: {
      short_description: 'Test agent for relationship integration tests',
    },
  },
  createdAt: new Date().getTime(),
  updatedAt: new Date().getTime(),
};

export const relationshipTestSourceEntity: Entity = {
  id: relationshipTestSourceEntityId,
  names: ['Source Entity'],
  agentId: relationshipTestAgentId,
  components: [],
  metadata: {
    type: 'user',
  },
};

export const relationshipTestTargetEntity: Entity = {
  id: relationshipTestTargetEntityId,
  names: ['Target Entity'],
  agentId: relationshipTestAgentId,
  components: [],
  metadata: {
    type: 'user',
  },
};

// Test relationships
export const relationshipTestRelationships: Relationship[] = [
  {
    id: uuidv4() as UUID,
    sourceEntityId: relationshipTestSourceEntityId,
    targetEntityId: relationshipTestTargetEntityId,
    agentId: relationshipTestAgentId,
    tags: ['friend'],
    metadata: {
      type: 'social',
      strength: 'high',
    },
    createdAt: new Date().getTime().toString(),
  },
  {
    id: uuidv4() as UUID,
    sourceEntityId: relationshipTestTargetEntityId,
    targetEntityId: relationshipTestSourceEntityId,
    agentId: relationshipTestAgentId,
    tags: ['colleague'],
    metadata: {
      type: 'professional',
      strength: 'medium',
    },
    createdAt: new Date().getTime().toString(),
  },
];

// Helper function to create a relationship with custom tags and metadata
export const createTestRelationship = (
  sourceId: UUID,
  targetId: UUID,
  tags: string[] = [],
  metadata: Record<string, any> = {}
): Relationship => {
  return {
    id: uuidv4() as UUID,
    sourceEntityId: sourceId,
    targetEntityId: targetId,
    agentId: relationshipTestAgentId,
    tags,
    metadata,
    createdAt: new Date().getTime().toString(),
  };
};
