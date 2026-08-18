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
  SHARED_AGENT_MEMORY_EMBEDDING_BACKFILL_BATCH_SIZE,
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
/** Prevent one post-response maintenance job from monopolizing Worker lifetime. */
export const SHARED_MEMORY_BACKFILL_MAX_BATCHES = 16;
export const SHARED_MEMORY_BACKFILL_DEADLINE_MS = 20_000;

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
  /** Mirrors the canonical history marker for a client-cancelled partial reply. */
  interrupted?: boolean;
}

/** Row id from a transport message id: pass through uuids, hash anything else. */
function memoryRowId(transportId: string): string {
  return validateUuid(transportId) ?? stringToUuid(transportId);
}

/**
 * Write-side embedder config: batch-embeds a turn pair's texts in ONE provider
 * call so recall's `isNotNull(embedding)` window actually fills. Injected by
 * the caller only while recall is enabled; absent means rows land without
 * vectors (tables-only mode stays free of embedding traffic). `model` is the
 * complete vector-space fingerprint, not only the upstream model name.
 */
export interface SharedMemoryEmbedConfig {
  embedTexts: (texts: string[]) => Promise<number[][]>;
  model: string;
}

export type SharedMemoryEmbeddingScheduler = (work: Promise<void>) => void;

export class SharedMemoryStore {
  constructor(
    private readonly scope: SharedMemoryStoreScope,
    private readonly writer: SharedAgentMemoriesWriter = sharedAgentMemoriesWriter,
    private readonly reader: SharedAgentMemoriesReader = sharedAgentMemoriesReader,
    private readonly embed?: SharedMemoryEmbedConfig,
    private readonly deferEmbedding?: SharedMemoryEmbeddingScheduler,
  ) {}

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
    return this.reader.searchByEmbedding(
      {
        organizationId: this.scope.organizationId,
        userId: this.scope.userId,
        agentId,
      },
      embedding,
      limit,
      this.embed?.model,
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
    const roomId = sharedRuntimeConversationRoomId(this.scope.agentKey);
    const worldId = sharedRuntimeWorldId(this.scope.agentKey);
    const scope = {
      organizationId: this.scope.organizationId,
      userId: this.scope.userId,
      agentId,
    };
    const landedAt = Date.now();
    const assistantReply = pair.assistantReply.trim();
    const embeddingTexts = [pair.userMessage, ...(assistantReply ? [assistantReply] : [])];
    // Without a Worker scheduler, retain the durable non-Worker contract and
    // resolve vectors before the insert. Under waitUntil, rows land first and
    // enrichment runs after the response so provider latency cannot hold the
    // terminal frame.
    let vectors: number[][] | undefined;
    if (this.embed && !this.deferEmbedding) {
      try {
        vectors = await this.embed.embedTexts(embeddingTexts);
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
    const userWrite = await this.writer.insertMemory({
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
      ...embeddingFields(0),
      createdAt: new Date(landedAt),
    });
    let assistantMemoryId: string | undefined;
    if (!assistantReply) {
      if (this.embed && this.deferEmbedding) {
        this.scheduleEmbeddingEnrichment(scope, [userWrite.id], embeddingTexts);
      }
      return;
    }
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
        source: "shared-runtime",
        channelType: "DM",
      },
      createdAt: new Date(landedAt + 1),
    };
    if (pair.messageIds) {
      const assistantWrite = await this.writer.mergeMessageMemory({
        ...assistant,
        ...embeddingFields(1),
        id: memoryRowId(pair.messageIds.assistant),
        interrupted: pair.interrupted === true,
      });
      assistantMemoryId = assistantWrite.id;
    } else {
      const assistantWrite = await this.writer.insertMemory({
        ...assistant,
        ...embeddingFields(1),
        content: {
          ...assistant.content,
          ...(pair.interrupted ? { interrupted: true } : {}),
        },
      });
      assistantMemoryId = assistantWrite.id;
    }
    if (this.embed && this.deferEmbedding) {
      this.scheduleEmbeddingEnrichment(scope, [userWrite.id, assistantMemoryId], embeddingTexts);
    }
  }

  private scheduleEmbeddingEnrichment(
    scope: { organizationId: string; userId: string; agentId: string },
    memoryIds: string[],
    texts: string[],
  ): void {
    if (!this.embed || !this.deferEmbedding) return;
    const embed = this.embed;
    const work = (async () => {
      try {
        const embeddings = await embed.embedTexts(texts);
        if (embeddings.length !== memoryIds.length) {
          throw new Error(
            `embedding count mismatch: received ${embeddings.length}, expected ${memoryIds.length}`,
          );
        }
        await Promise.all(
          memoryIds.map((id, index) =>
            this.writer.setMemoryEmbedding({
              id,
              scope,
              contentText: texts[index] ?? "",
              embedding: embeddings[index] ?? [],
              embeddingModel: embed.model,
            }),
          ),
        );
      } catch (error) {
        // error-policy:J4 transcript durability is already complete. Keep the
        // row vectorless and surface the loss; never fabricate or mislabel it.
        logger.warn(
          `[SharedMemoryStore] deferred embedding enrichment failed; rows remain vectorless: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return;
      }
      try {
        await this.backfillLegacyEmbeddings(scope, embed);
      } catch (error) {
        // error-policy:J4 current-space rows are already durable and enriched.
        // Leave legacy rows excluded from search and retry the bounded batch on
        // a later turn rather than extending or failing the user response.
        logger.warn(
          `[SharedMemoryStore] legacy embedding backfill failed; incompatible rows remain excluded: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    })();
    this.deferEmbedding(work);
  }

  /**
   * Repairs one bounded oldest-first batch after live-turn enrichment. This is
   * deliberately inside the already-deferred job: incompatible vectors are
   * excluded from search immediately, but migration can never extend response
   * TTFT or the terminal stream frame.
   */
  private async backfillLegacyEmbeddings(
    scope: { organizationId: string; userId: string; agentId: string },
    embed: SharedMemoryEmbedConfig,
  ): Promise<void> {
    const startedAt = Date.now();
    let batches = 0;
    let migrated = 0;
    while (
      batches < SHARED_MEMORY_BACKFILL_MAX_BATCHES &&
      Date.now() - startedAt < SHARED_MEMORY_BACKFILL_DEADLINE_MS
    ) {
      const candidates = await this.reader.listEmbeddingBackfillCandidates(
        scope,
        embed.model,
        SHARED_AGENT_MEMORY_EMBEDDING_BACKFILL_BATCH_SIZE,
      );
      if (candidates.length === 0) break;
      const embeddings = await embed.embedTexts(
        candidates.map((candidate) => candidate.contentText),
      );
      if (embeddings.length !== candidates.length) {
        throw new Error(
          `embedding backfill count mismatch: received ${embeddings.length}, expected ${candidates.length}`,
        );
      }
      const updates = await Promise.all(
        candidates.map((candidate, index) =>
          this.writer.setMemoryEmbedding({
            id: candidate.id,
            scope,
            contentText: candidate.contentText,
            embedding: embeddings[index] ?? [],
            embeddingModel: embed.model,
          }),
        ),
      );
      const updated = updates.filter(Boolean).length;
      migrated += updated;
      batches += 1;
      // A content-race/no-op remains durably eligible (or was cleared by the
      // winning writer). Stop this job so it cannot spin on one row; a later
      // turn starts a fresh oldest-first audit.
      if (updated !== candidates.length) break;
      if (candidates.length < SHARED_AGENT_MEMORY_EMBEDDING_BACKFILL_BATCH_SIZE) break;
    }
    if (migrated > 0) {
      logger.info(
        `[SharedMemoryStore] re-embedded ${migrated} legacy embedding rows as ${embed.model} across ${batches} bounded batch(es)`,
      );
    }
  }
}

/** Store for one turn's tenant scope, or null while the flag is off. */
export function createSharedMemoryStore(
  scope: SharedMemoryStoreScope,
  embed?: SharedMemoryEmbedConfig,
  deferEmbedding?: SharedMemoryEmbeddingScheduler,
): SharedMemoryStore | null {
  return sharedMemoryTablesEnabled()
    ? new SharedMemoryStore(
        scope,
        sharedAgentMemoriesWriter,
        sharedAgentMemoriesReader,
        embed,
        deferEmbedding,
      )
    : null;
}
