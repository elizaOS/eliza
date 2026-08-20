/**
 * Flag-gated durable memory writes for container-free Shared turns. When
 * `SHARED_MEMORY_TABLES_ENABLED === "true"`, each landed user/assistant pair
 * is mirrored into the tenant-scoped `shared_agent_memories` table with the
 * SAME storage identities the ephemeral Workerd runtime projects (agent/entity
 * uuids from the Todo storage scope when present, room/world derived from the
 * trusted conversation key) — so a later Dedicated cutover or retrieval pass
 * reads rows that line up with what the runtime actually saw. Extracted
 * knowledge (parity P4) lands in the same table under the core `facts`
 * discriminator with fact-text-derived row ids, so re-extraction replays
 * instead of duplicating. Off (the default), the store is never constructed
 * and the turn path is byte-identical to before.
 */

import { ElizaError, stringToUuid, validateUuid } from "@elizaos/core/edge";
import {
  type SharedAgentMemoriesReader,
  type SharedAgentMemoriesWriter,
  type SharedAgentMemorySearchHit,
  sharedAgentMemoriesReader,
  sharedAgentMemoriesWriter,
} from "../../../db/repositories/shared-agent-memories";
import { logger } from "../../utils/logger";
import { normalizeSharedFact, SHARED_FACTS_MEMORY_TYPE } from "./shared-facts";
import type { SharedRuntimeChannel } from "./shared-runtime-channel";
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
  /**
   * Canonical channel id selected by the authenticated request path. Caller
   * room labels are normalized and hashed before this storage scope is built.
   */
  roomKey: string;
  /** Storage uuids shared with the runtime's Todo scope, when Todos are wired. */
  storage?: SharedTodoStorageScope;
}

export interface SharedMemoryTurnPair {
  userMessage: string;
  assistantReply: string;
  /** Transport-stable ids; reused as row ids so a claim replay cannot double-write. */
  messageIds?: { user: string; assistant: string };
  messageRole?: "system" | "user";
  /** Mirrors the canonical history marker for a client-cancelled partial reply. */
  interrupted?: boolean;
  /** Trusted transport semantics projected onto durable runtime memories. */
  channel?: SharedRuntimeChannel;
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
  private readonly canonicalRoomKey: string;

  constructor(
    private readonly scope: SharedMemoryStoreScope,
    private readonly writer: SharedAgentMemoriesWriter = sharedAgentMemoriesWriter,
    private readonly reader: SharedAgentMemoriesReader = sharedAgentMemoriesReader,
    private readonly embed?: SharedMemoryEmbedConfig,
  ) {
    const canonicalRoomKey = typeof scope.roomKey === "string" ? scope.roomKey.trim() : "";
    if (!canonicalRoomKey) {
      throw new ElizaError("Shared memory store requires a trusted room key", {
        code: "SHARED_MEMORY_STORE_ROOM_KEY_MISSING",
        context: { agentKey: scope.agentKey },
      });
    }
    this.canonicalRoomKey = canonicalRoomKey;
  }

  /**
   * Tenant-scoped vector search over this store's transcript rows (P3 recall's
   * store leg). Scope pinning mirrors recordTurnPair exactly — the same
   * organization/user/agent triple — so recall can never read across tenants.
   */
  async searchByEmbedding(
    embedding: number[],
    limit: number,
  ): Promise<SharedAgentMemorySearchHit[]> {
    const agentId = this.scope.storage?.agentId ?? stringToUuid(this.scope.agentKey);
    const roomId = sharedRuntimeConversationRoomId(this.canonicalRoomKey);
    return this.reader.searchByEmbedding(
      {
        organizationId: this.scope.organizationId,
        userId: this.scope.userId,
        agentId,
      },
      roomId,
      embedding,
      limit,
    );
  }

  /**
   * Newest-first fact texts previously extracted for this tenant scope
   * (parity P4). Rows whose content carries no text are skipped rather than
   * rendered as empty bullets.
   */
  async listFacts(limit: number): Promise<string[]> {
    const agentId = this.scope.storage?.agentId ?? stringToUuid(this.scope.agentKey);
    const rows = await this.reader.listRecentByType(
      {
        organizationId: this.scope.organizationId,
        userId: this.scope.userId,
        agentId,
      },
      SHARED_FACTS_MEMORY_TYPE,
      limit,
    );
    return rows
      .map((row) => (row.content as { text?: unknown })?.text)
      .filter((text): text is string => typeof text === "string" && text.trim().length > 0);
  }

  /**
   * Durably record extracted facts under the core `facts` discriminator.
   * Facts are deliberately AGENT-scoped, not room-scoped: knowledge learned in
   * one conversation must surface in the agent's other conversations, so
   * facts rows keep the agent-key-derived room/world identity while transcript
   * rows carry the trusted conversation room. Because room-pinned semantic
   * recall filters on the conversation room, facts rows never leak into the
   * transcript recall window; they surface only through `listFacts`. Row ids
   * derive from the normalized fact text, so re-extracting a known fact
   * replays the same id and no-ops instead of accumulating duplicates.
   * Embeddings, when configured, land in one batched sidecar call and degrade
   * to vector-less rows on failure — the knowledge write itself is never lost
   * to the sidecar.
   */
  async recordFacts(facts: string[]): Promise<void> {
    const renderable = facts.map((fact) => fact.trim()).filter((fact) => fact.length > 0);
    if (renderable.length === 0) return;
    const agentId = this.scope.storage?.agentId ?? stringToUuid(this.scope.agentKey);
    const entityId = this.scope.storage?.entityId ?? stringToUuid(`${this.scope.agentKey}:owner`);
    const roomId = sharedRuntimeConversationRoomId(this.scope.agentKey);
    const worldId = sharedRuntimeWorldId(this.scope.agentKey);
    const scope = {
      organizationId: this.scope.organizationId,
      userId: this.scope.userId,
      agentId,
    };
    let vectors: number[][] | undefined;
    if (this.embed) {
      try {
        vectors = await this.embed.embedTexts(renderable);
      } catch (error) {
        // error-policy:J4 embedding is an enhancement on the durable write;
        // its loss is visible (rows without vectors never match recall).
        logger.warn(
          `[SharedMemoryStore] facts embedding failed; writing rows without vectors: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    const landedAt = Date.now();
    for (const [index, fact] of renderable.entries()) {
      await this.writer.insertMemory({
        id: stringToUuid(`${this.scope.agentKey}:fact:${normalizeSharedFact(fact)}`),
        scope,
        entityId,
        roomId,
        worldId,
        type: SHARED_FACTS_MEMORY_TYPE,
        content: { text: fact, source: "shared-facts-extraction" },
        ...(vectors?.[index] && this.embed
          ? { embedding: vectors[index], embeddingModel: this.embed.model }
          : {}),
        createdAt: new Date(landedAt + index),
      });
    }
  }

  /**
   * Durably record one landed user/assistant pair. Writes are sequential so a
   * failure cannot leave an assistant row without its user row; failures
   * propagate to the turn commit instead of being swallowed as success.
   */
  async recordTurnPair(pair: SharedMemoryTurnPair): Promise<void> {
    const agentId = this.scope.storage?.agentId ?? stringToUuid(this.scope.agentKey);
    const entityId = this.scope.storage?.entityId ?? stringToUuid(`${this.scope.agentKey}:owner`);
    const roomId = sharedRuntimeConversationRoomId(this.canonicalRoomKey);
    const worldId = sharedRuntimeWorldId(this.canonicalRoomKey);
    const scope = {
      organizationId: this.scope.organizationId,
      userId: this.scope.userId,
      agentId,
    };
    const landedAt = Date.now();
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
        source: pair.channel?.source ?? "shared-runtime",
        channelType: pair.channel?.type ?? "DM",
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
        source: pair.channel?.source ?? "shared-runtime",
        channelType: pair.channel?.type ?? "DM",
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
