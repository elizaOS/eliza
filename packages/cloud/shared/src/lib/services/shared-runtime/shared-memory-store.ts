/**
 * Flag-gated durable memory writes for container-free Shared turns. When
 * `SHARED_MEMORY_TABLES_ENABLED === "true"`, each landed user/assistant pair
 * is mirrored into the tenant-scoped `shared_agent_memories` table with the
 * SAME storage identities the ephemeral Workerd runtime projects (agent/entity
 * uuids from the Todo storage scope when present, room/world derived from the
 * agent key) — so a later Dedicated cutover or retrieval pass reads rows that
 * line up with what the runtime actually saw. Off (the default), the store is
 * never constructed and the turn path is byte-identical to before.
 */

import { stringToUuid, validateUuid } from "@elizaos/core/edge";
import {
  type SharedAgentMemoriesWriter,
  sharedAgentMemoriesWriter,
} from "../../../db/repositories/shared-agent-memories";
import {
  type SharedTodoStorageScope,
  sharedRuntimeConversationRoomId,
  sharedRuntimeWorldId,
} from "./shared-runtime-storage-identity";

/** Core memories table-name discriminator the Shared runtime projects turns into. */
const SHARED_MEMORY_TYPE = "messages";

export function sharedMemoryTablesEnabled(
  raw: string | undefined = process.env.SHARED_MEMORY_TABLES_ENABLED,
): boolean {
  return raw === "true";
}

export interface SharedMemoryStoreScope {
  /** Owning tenant; both come from the server-resolved agent row, never a client. */
  organizationId: string;
  userId: string;
  /** Logical Shared agent id (`agent.id`), the seed for storage identities. */
  agentKey: string;
  /** Storage uuids shared with the runtime's Todo scope, when Todos are wired. */
  storage?: SharedTodoStorageScope;
}

export interface SharedMemoryTurnPair {
  userMessage: string;
  assistantReply: string;
  /** Transport-stable ids; reused as row ids so a claim replay cannot double-write. */
  messageIds?: { user: string; assistant: string };
  messageRole?: "system" | "user";
}

/** Row id from a transport message id: pass through uuids, hash anything else. */
function memoryRowId(transportId: string): string {
  return validateUuid(transportId) ?? stringToUuid(transportId);
}

export class SharedMemoryStore {
  constructor(
    private readonly scope: SharedMemoryStoreScope,
    private readonly writer: SharedAgentMemoriesWriter = sharedAgentMemoriesWriter,
  ) {}

  /**
   * Durably record one landed user/assistant pair. Writes are sequential so a
   * failure cannot leave an assistant row without its user row; failures
   * propagate to the turn commit instead of being swallowed as success.
   */
  async recordTurnPair(pair: SharedMemoryTurnPair): Promise<void> {
    const agentId = this.scope.storage?.agentId ?? stringToUuid(this.scope.agentKey);
    const entityId = this.scope.storage?.entityId ?? stringToUuid(`${this.scope.agentKey}:owner`);
    const roomId = sharedRuntimeConversationRoomId(this.scope.agentKey);
    const worldId = sharedRuntimeWorldId(this.scope.agentKey);
    const scope = {
      organizationId: this.scope.organizationId,
      userId: this.scope.userId,
      agentId,
    };
    const landedAt = Date.now();
    await this.writer.insertMemory({
      ...(pair.messageIds ? { id: memoryRowId(pair.messageIds.user) } : {}),
      scope,
      entityId,
      roomId,
      worldId,
      type: SHARED_MEMORY_TYPE,
      content: {
        text: pair.userMessage,
        source: "shared-runtime",
        channelType: "DM",
        ...(pair.messageRole === "system" ? { role: "system" } : {}),
      },
      createdAt: new Date(landedAt),
    });
    await this.writer.insertMemory({
      ...(pair.messageIds ? { id: memoryRowId(pair.messageIds.assistant) } : {}),
      scope,
      // The assistant speaks as the agent itself, mirroring the runtime's
      // projection where assistant memories carry the agent's entity id.
      entityId: agentId,
      roomId,
      worldId,
      type: SHARED_MEMORY_TYPE,
      content: {
        text: pair.assistantReply,
        source: "shared-runtime",
        channelType: "DM",
      },
      createdAt: new Date(landedAt + 1),
    });
  }
}

/** Store for one turn's tenant scope, or null while the flag is off. */
export function createSharedMemoryStore(scope: SharedMemoryStoreScope): SharedMemoryStore | null {
  return sharedMemoryTablesEnabled() ? new SharedMemoryStore(scope) : null;
}
