/** Fixture agent/entity/relationship records for the relationship-store integration tests. */
import type { Agent, Entity, Metadata, Relationship, UUID } from "@elizaos/core";
import { v4 as uuidv4 } from "uuid";

export const relationshipTestAgentId = uuidv4() as UUID;
export const relationshipTestSourceEntityId = uuidv4() as UUID;
export const relationshipTestTargetEntityId = uuidv4() as UUID;

export const relationshipTestAgent: Agent = {
  id: relationshipTestAgentId,
  name: "Relationship Test Agent",
  bio: "Test agent for relationship integration tests",
  settings: {
    profile: {
      short_description: "Test agent for relationship integration tests",
    },
  },
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

export const relationshipTestSourceEntity: Entity = {
  id: relationshipTestSourceEntityId,
  names: ["Source Entity"],
  agentId: relationshipTestAgentId,
  components: [],
  metadata: {
    type: "user",
  },
};

export const relationshipTestTargetEntity: Entity = {
  id: relationshipTestTargetEntityId,
  names: ["Target Entity"],
  agentId: relationshipTestAgentId,
  components: [],
  metadata: {
    type: "user",
  },
};

export const relationshipTestRelationships: Relationship[] = [
  {
    id: uuidv4() as UUID,
    sourceEntityId: relationshipTestSourceEntityId,
    targetEntityId: relationshipTestTargetEntityId,
    agentId: relationshipTestAgentId,
    tags: ["friend"],
    metadata: {
      type: "social",
      strength: "high",
    },
    createdAt: Date.now().toString(),
  },
  {
    id: uuidv4() as UUID,
    sourceEntityId: relationshipTestTargetEntityId,
    targetEntityId: relationshipTestSourceEntityId,
    agentId: relationshipTestAgentId,
    tags: ["colleague"],
    metadata: {
      type: "professional",
      strength: "medium",
    },
    createdAt: Date.now().toString(),
  },
];

export const createTestRelationship = (
  sourceId: UUID,
  target: UUID,
  tags: string[] = [],
  metadata: Metadata = {}
): Relationship => {
  return {
    id: uuidv4() as UUID,
    sourceEntityId: sourceId,
    targetEntityId: target,
    agentId: relationshipTestAgentId,
    tags,
    metadata,
    createdAt: Date.now().toString(),
  };
};
