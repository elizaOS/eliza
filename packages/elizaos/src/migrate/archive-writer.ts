/**
 * Assemble a `.eliza-agent` archive from a migrated character + memories.
 *
 * Produces a PayloadSchema-conformant {@link AgentExportPayload} containing the
 * minimal entity / room / world the memories reference, then reuses Eliza's
 * native {@link buildEncryptedArchive} (gzip + AES-256-GCM) so the output is a
 * real `.eliza-agent` that {@link importAgent} round-trips. No parallel format.
 */

import { randomUUID } from "node:crypto";
import {
  AgentStatus,
  type Character,
  ChannelType,
  type Entity,
  type Memory,
  type Room,
  Role,
  type UUID,
  type World,
} from "@elizaos/core";
import {
  type AgentExportPayload,
  buildEncryptedArchive,
} from "@elizaos/agent";

export interface BuildArchiveInput {
  agentId: UUID;
  /** Display slug used for room/world naming + sourceAgentId provenance. */
  sourceSlug: string;
  character: Character;
  /** The entity (agent) the memories belong to. */
  entityId: UUID;
  /** The room migrated memories attach to. */
  roomId: UUID;
  memories: Memory[];
}

export interface AssembledPayload {
  payload: AgentExportPayload;
  worldId: UUID;
}

/**
 * Build the export payload (DB-shaped records + characterConfig) from the
 * migrated character + memories. Pure: no crypto, no FS — easy to unit-test.
 */
export function assemblePayload(input: BuildArchiveInput): AssembledPayload {
  const now = Date.now();
  const worldId = randomUUID() as UUID;

  const world: World = {
    id: worldId,
    name: `${input.sourceSlug} (migrated)`,
    agentId: input.agentId,
    metadata: {
      type: "migration",
      description: "Imported from an OpenClaw agent home.",
      ownership: { ownerId: String(input.entityId) },
      roles: { [String(input.entityId)]: Role.OWNER },
    },
  };

  const room: Room = {
    id: input.roomId,
    name: `${input.sourceSlug} memory`,
    agentId: input.agentId,
    source: "openclaw-migration",
    type: ChannelType.SELF,
    worldId,
  };

  const entity: Entity = {
    id: input.entityId,
    names: [input.character.name ?? input.sourceSlug],
    agentId: input.agentId,
    metadata: { source: "openclaw-migration" },
  };

  // The agent DB record: identity fields live here; the richer characterConfig
  // (style/adjectives/knowledge/etc.) is merged on import.
  const agent: AgentExportPayload["agent"] = {
    id: input.agentId,
    name: input.character.name,
    username: input.character.username ?? input.sourceSlug,
    system: input.character.system,
    bio: input.character.bio,
    status: AgentStatus.ACTIVE,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };

  // characterConfig carries non-DB fields (strip secrets per the schema).
  const { secrets: _secrets, ...characterConfig } = input.character;

  const payload: AgentExportPayload = {
    version: 1,
    exportedAt: new Date(now).toISOString(),
    sourceAgentId: input.sourceSlug,
    agent,
    characterConfig,
    entities: [entity],
    memories: input.memories,
    components: [],
    rooms: [room],
    participants: [
      { entityId: String(input.entityId), roomId: String(input.roomId), userState: null },
    ],
    relationships: [],
    worlds: [world],
    tasks: [],
    logs: [],
  };

  return { payload, worldId };
}

/**
 * Assemble + encrypt into a `.eliza-agent` archive buffer.
 */
export async function buildAgentArchive(
  input: BuildArchiveInput,
  password: string,
): Promise<Buffer> {
  const { payload } = assemblePayload(input);
  return buildEncryptedArchive(payload, password);
}
