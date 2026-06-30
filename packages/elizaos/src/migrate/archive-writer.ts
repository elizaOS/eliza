/**
 * Assemble a `.eliza-agent` archive from a migrated character + memories.
 *
 * Produces a payload whose shape matches `@elizaos/agent`'s AgentExportPayload
 * (so `importAgent` accepts it), then encrypts it with the self-contained V1
 * writer. No dependency on the agent runtime.
 */

import { randomUUID } from "node:crypto";
import { buildElizaAgentArchive } from "./archive-format.js";
import type {
  MigratedCharacter,
  MigratedExportPayload,
  MigratedMemory,
  UUID,
} from "./types.js";

export interface BuildArchiveInput {
  agentId: UUID;
  /** Display slug used for room/world naming + sourceAgentId provenance. */
  sourceSlug: string;
  character: MigratedCharacter;
  /** The entity (agent) the memories belong to. */
  entityId: UUID;
  /** The room migrated memories attach to. */
  roomId: UUID;
  memories: MigratedMemory[];
}

export interface AssembledPayload {
  payload: MigratedExportPayload;
  worldId: UUID;
}

/**
 * Build the export payload (DB-shaped records + characterConfig) from the
 * migrated character + memories. Pure: no crypto, no FS - easy to unit-test.
 */
export function assemblePayload(input: BuildArchiveInput): AssembledPayload {
  const now = Date.now();
  const worldId = randomUUID() as UUID;

  const world = {
    id: worldId,
    name: `${input.sourceSlug} (migrated)`,
    agentId: input.agentId,
    metadata: {
      type: "migration",
      description: "Imported from an OpenClaw agent home.",
      ownership: { ownerId: String(input.entityId) },
      roles: { [String(input.entityId)]: "OWNER" },
    },
  };

  const room = {
    id: input.roomId,
    name: `${input.sourceSlug} memory`,
    agentId: input.agentId,
    source: "openclaw-migration",
    // ChannelType.SELF - the agent's own memory room.
    type: "SELF",
    worldId,
  };

  const entity = {
    id: input.entityId,
    names: [input.character.name ?? input.sourceSlug],
    agentId: input.agentId,
    metadata: { source: "openclaw-migration" },
  };

  // The agent DB record: identity fields live here; the richer characterConfig
  // (style/adjectives/knowledge/etc.) is merged on import.
  const agent: Record<string, unknown> = {
    id: input.agentId,
    name: input.character.name,
    username: input.character.username ?? input.sourceSlug,
    system: input.character.system,
    bio: input.character.bio,
    // AgentStatus.ACTIVE.
    status: "active",
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };

  // characterConfig carries non-DB fields (drop volatile settings if any).
  const { settings: _settings, ...characterConfig } = input.character as Record<
    string,
    unknown
  >;

  const payload: MigratedExportPayload = {
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
      {
        entityId: String(input.entityId),
        roomId: String(input.roomId),
        userState: null,
      },
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
export function buildAgentArchive(
  input: BuildArchiveInput,
  password: string,
): Buffer {
  const { payload } = assemblePayload(input);
  return buildElizaAgentArchive(payload, password);
}
