/**
 * Flag-gated durable memory writes for container-free Shared turns. When
 * `SHARED_MEMORY_TABLES_ENABLED === "true"`, each landed user/assistant pair
 * is mirrored into the tenant-scoped `shared_agent_memories` table with the
 * SAME storage identities the ephemeral Workerd runtime projects (agent/entity
 * uuids from the Todo storage scope when present, room/world derived from the
 * canonical conversation key) — so public/group recall cannot cross into a
 * private room and a later Dedicated cutover reads the runtime's exact rows.
 * Off (the default), the store is never constructed.
 */

import {
  ChannelType,
  type ChannelType as ChannelTypeValue,
  stringToUuid,
  validateUuid,
} from "@elizaos/core/edge";
import {
  type SharedAgentMemoriesReader,
  type SharedAgentMemoriesWriter,
  type SharedAgentMemorySearchHit,
  sharedAgentMemoriesReader,
  sharedAgentMemoriesWriter,
} from "../../../db/repositories/shared-agent-memories";
import { logger } from "../../utils/logger";
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
  /** Canonical conversation key used by AgentRuntime for room/world isolation. */
  roomKey?: string;
  /** Storage uuids shared with the runtime's Todo scope, when Todos are wired. */
  storage?: SharedTodoStorageScope;
}

export interface SharedMemoryTurnPair {
  userMessage: string;
  assistantReply: string;
  /** Transport-stable ids; reused as row ids so a claim replay cannot double-write. */
  messageIds?: { user: string; assistant: string };
  messageRole?: "system" | "user";
  /** Exact server-authenticated transport provenance for both landed messages. */
  source?: string;
  channelType?: ChannelTypeValue;
  /** Mirrors the canonical history marker for a client-cancelled partial reply. */
  interrupted?: boolean;
}

/** Row id from a transport message id: pass through uuids, hash anything else. */
function memoryRowId(transportId: string): string {
  return validateUuid(transportId) ?? stringToUuid(transportId);
}

/**
 * Write-side embedder config: batch-embeds a turn pair's texts in ONE sidecar
 * call so recall's `isNotNull(embedding)` window actually fills. Injected by
 * the caller only while recall is enabled; absent means rows land without
 * vectors (tables-only mode stays free of sidecar traffic).
 */
export interface SharedMemoryEmbedConfig {
  embedTexts: (texts: string[]) => Promise<number[][]>;
  model: string;
}

export class SharedMemoryStore {
  constructor(
    private readonly scope: SharedMemoryStoreScope,
    private readonly writer: SharedAgentMemoriesWriter = sharedAgentMemoriesWriter,
    private readonly reader: SharedAgentMemoriesReader = sharedAgentMemoriesReader,
    private readonly embed?: SharedMemoryEmbedConfig,
  ) {}

  /**
   * Tenant- and room-scoped vector search over this store's transcript rows.
   * Scope pinning mirrors recordTurnPair exactly so recall cannot cross either
   * a tenant boundary or a private/public conversation boundary.
   */
  async searchByEmbedding(
    embedding: number[],
    limit: number,
  ): Promise<SharedAgentMemorySearchHit[]> {
    const agentId = this.scope.storage?.agentId ?? stringToUuid(this.scope.agentKey);
    const roomId = sharedRuntimeConversationRoomId(this.scope.roomKey ?? this.scope.agentKey);
    return this.reader.searchByEmbedding(
      {
        organizationId: this.scope.organizationId,
        userId: this.scope.userId,
        agentId,
      },
      embedding,
      limit,
      roomId,
    );
  }

  /**
   * Durably record one landed user/assistant pair. Writes are sequential so a
   * failure cannot leave an assistant row without its user row; failures
   * propagate to the turn commit instead of being swallowed as success.
   */
  async recordTurnPair(pair: SharedMemoryTurnPair): Promise<void> {
    const agentId = this.scope.storage?.agentId ?? stringToUuid(this.scope.agentKey);
    const entityId = this.scope.storage?.entityId ?? stringToUuid(`${this.scope.agentKey}:owner`);
    const roomKey = this.scope.roomKey ?? this.scope.agentKey;
    const roomId = sharedRuntimeConversationRoomId(roomKey);
    const worldId = sharedRuntimeWorldId(roomKey);
    const scope = {
      organizationId: this.scope.organizationId,
      userId: this.scope.userId,
      agentId,
    };
    const landedAt = Date.now();
    const source = pair.source?.trim() || "shared-runtime";
    const channelType = pair.channelType ?? ChannelType.DM;
    // One batched sidecar round-trip for both texts; an embedding failure
    // degrades to vector-less rows (recall coverage shrinks) but never loses
    // the memory write itself.
    let vectors: number[][] | undefined;
    if (this.embed) {
      try {
        vectors = await this.embed.embedTexts(
          [pair.userMessage, pair.assistantReply.trim() || pair.userMessage].map((text) => text),
        );
      } catch (error) {
        // error-policy:J4 embedding is an enhancement on the durable write;
        // its loss is visible (rows without vectors never match recall).
        logger.warn(
          `[SharedMemoryStore] turn-pair embedding failed; writing rows without vectors: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    const embeddingFields = (index: number) =>
      vectors?.[index] && this.embed
        ? { embedding: vectors[index], embeddingModel: this.embed.model }
        : {};
    await this.writer.insertMemory({
      ...(pair.messageIds ? { id: memoryRowId(pair.messageIds.user) } : {}),
      scope,
      entityId,
      roomId,
      worldId,
      type: SHARED_MEMORY_TYPE,
      content: {
        text: pair.userMessage,
        source,
        channelType,
        ...(pair.messageRole === "system" ? { role: "system" } : {}),
      },
      ...embeddingFields(0),
      createdAt: new Date(landedAt),
    });
    const assistantReply = pair.assistantReply.trim();
    if (!assistantReply) return;
    const assistant = {
      scope,
      // The assistant speaks as the agent itself, mirroring the runtime's
      // projection where assistant memories carry the agent's entity id.
      entityId: agentId,
      roomId,
      worldId,
      type: SHARED_MEMORY_TYPE,
      content: {
        text: assistantReply,
        source,
        channelType,
      },
      createdAt: new Date(landedAt + 1),
    };
    if (pair.messageIds) {
      await this.writer.mergeMessageMemory({
        ...assistant,
        ...embeddingFields(1),
        id: memoryRowId(pair.messageIds.assistant),
        interrupted: pair.interrupted === true,
      });
      return;
    }
    await this.writer.insertMemory({
      ...assistant,
      ...embeddingFields(1),
      content: {
        ...assistant.content,
        ...(pair.interrupted ? { interrupted: true } : {}),
      },
    });
  }
}

/** Store for one turn's tenant scope, or null while the flag is off. */
export function createSharedMemoryStore(
  scope: SharedMemoryStoreScope,
  embed?: SharedMemoryEmbedConfig,
): SharedMemoryStore | null {
  return sharedMemoryTablesEnabled()
    ? new SharedMemoryStore(scope, sharedAgentMemoriesWriter, sharedAgentMemoriesReader, embed)
    : null;
}
