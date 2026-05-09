import type { AgentRuntime, Content, Memory, UUID } from "@elizaos/core";
import { ChannelType, stringToUuid } from "@elizaos/core";
import { streamText } from "ai";
import { createHash } from "crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { dbRead } from "@/db/client";
import type { ConversationMessage } from "@/db/repositories";
import { memoryTable, participantTable } from "@/db/schemas/eliza";
import { users } from "@/db/schemas/users";
import { CacheKeys, CacheTTL } from "@/lib/cache/keys";
import { type MemoryRoomContext, memoryCache, type SearchResult } from "@/lib/cache/memory-cache";
import { AgentMode } from "@/lib/eliza/agent-mode-types";
import { runtimeFactory } from "@/lib/eliza/runtime-factory";
import { userContextService } from "@/lib/eliza/user-context";
import { getLanguageModel } from "@/lib/providers/language-model";
import { conversationsService } from "@/lib/services/conversations";
import { logger } from "@/lib/utils/logger";

/**
 * Memory service for managing Eliza agent memories and conversation summaries.
 */

export interface SaveMemoryInput {
  organizationId: string;
  roomId: string;
  entityId: string;
  content: string;
  type: "fact" | "preference" | "context" | "document";
  tags?: string[];
  metadata?: Record<string, unknown>;
  ttl?: number;
  persistent?: boolean;
}

/**
 * Result of saving a memory.
 */
export interface SaveMemoryResult {
  memoryId: string;
  storage: "redis" | "postgres" | "both";
  expiresAt?: Date;
}

/**
 * Input for retrieving memories.
 */
export interface RetrieveMemoriesInput {
  organizationId: string;
  roomId?: string;
  query?: string;
  type?: string[];
  tags?: string[];
  limit?: number;
  includeArchived?: boolean;
  sortBy?: "relevance" | "recent" | "importance";
}

/**
 * Input for deleting memories.
 */
export interface DeleteMemoryInput {
  organizationId: string;
  memoryId?: string;
  olderThan?: number;
  type?: string[];
  tags?: string[];
}

/**
 * Result of deleting memories.
 */
export interface DeleteMemoryResult {
  deletedCount: number;
  storageFreed: number;
}

/**
 * Input for summarizing a conversation.
 */
export interface SummarizeConversationInput {
  roomId: string;
  organizationId: string;
  lastN?: number;
  style?: "brief" | "detailed" | "bullet-points";
  includeMetadata?: boolean;
}

/**
 * Result of conversation summarization.
 */
export interface SummarizeConversationResult {
  summary: string;
  tokenCount: number;
  keyTopics: string[];
  participants: string[];
}

const isSummarizeConversationResult = (value: unknown): value is SummarizeConversationResult => {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.summary === "string" &&
    typeof record.tokenCount === "number" &&
    Array.isArray(record.keyTopics) &&
    record.keyTopics.every((topic) => typeof topic === "string") &&
    Array.isArray(record.participants) &&
    record.participants.every((participant) => typeof participant === "string")
  );
};

/**
 * Service for managing agent memories, conversation context, and summaries.
 */
export class MemoryService {
  private async getSystemRuntime(): Promise<AgentRuntime> {
    const context = userContextService.createSystemContext(AgentMode.CHAT);
    return runtimeFactory.createRuntimeForUser(context);
  }

  // PERFORMANCE FIX: Add method to check single room ownership efficiently
  private async checkRoomOwnership(organizationId: string, roomId: string): Promise<boolean> {
    const result = await dbRead
      .select({ exists: participantTable.roomId })
      .from(participantTable)
      .innerJoin(users, eq(participantTable.entityId, users.id))
      .where(and(eq(participantTable.roomId, roomId), eq(users.organization_id, organizationId)))
      .limit(1);

    return result.length > 0;
  }

  private async getRoomIdsForOrganization(organizationId: string): Promise<Set<string>> {
    logger.info(`[Memory Service] getRoomIdsForOrganization called for org: ${organizationId}`);

    const results = await dbRead
      .selectDistinct({ roomId: participantTable.roomId })
      .from(participantTable)
      .innerJoin(users, eq(participantTable.entityId, users.id))
      .where(eq(users.organization_id, organizationId));

    logger.info(
      `[Memory Service] Query returned ${results.length} results:`,
      JSON.stringify(results, null, 2),
    );

    const roomIds = new Set(results.map((r) => r.roomId));
    logger.info(
      `[Memory Service] Found ${roomIds.size} rooms for organization ${organizationId}: ${Array.from(roomIds).join(", ")}`,
    );
    return roomIds;
  }

  async saveMemory(input: SaveMemoryInput): Promise<SaveMemoryResult> {
    const runtime = await this.getSystemRuntime();

    // Ensure the room exists in the database
    const roomId = input.roomId as UUID;
    const entityId = input.entityId as UUID;

    // Ensure room exists
    await runtime.ensureRoomExists({
      id: roomId,
      source: "memory",
      type: ChannelType.DM,
      channelId: input.roomId,
      serverId: stringToUuid("eliza-server") as UUID,
      worldId: stringToUuid("eliza-world") as UUID,
      agentId: runtime.agentId,
    });
    logger.debug(`[Memory Service] Ensured room exists: ${roomId}`);

    // Ensure entity exists and is participant in room
    // ensureConnection handles: createEntity (if needed) + ensureParticipantInRoom
    await runtime.ensureConnection({
      entityId,
      roomId,
      worldId: stringToUuid("eliza-world") as UUID,
      source: "memory",
      type: ChannelType.DM,
      channelId: input.roomId,
      userName: input.entityId,
    });
    logger.debug(`[Memory Service] Ensured entity and participant: ${entityId} -> ${roomId}`);

    const memory: Memory = {
      id: uuidv4() as UUID,
      roomId: roomId,
      entityId: entityId,
      agentId: runtime.agentId,
      createdAt: Date.now(),
      content: {
        text: input.content,
        type: input.type,
        tags: input.tags,
        ...input.metadata,
      },
    };

    const persistent = input.persistent !== false;

    if (persistent) {
      logger.debug(`[Memory Service] Attempting to create memory in PostgreSQL:`, {
        memoryId: memory.id,
        roomId: memory.roomId,
        entityId: memory.entityId,
        agentId: memory.agentId,
        contentLength: JSON.stringify(memory.content).length,
      });
      await runtime.createMemory(memory, "memories", true);
      logger.info(`[Memory Service] Saved memory to PostgreSQL: ${memory.id}`);
    }

    const ttl = input.ttl || CacheTTL.memory.item;
    const memoryId = memory.id!;
    const cacheKey = CacheKeys.memory.item(input.organizationId, memoryId);
    await memoryCache.cacheMemory(cacheKey, memory, ttl);

    await memoryCache.invalidateRoom(input.roomId, input.organizationId);

    return {
      memoryId: memoryId,
      storage: persistent ? "both" : "redis",
      expiresAt: input.ttl ? new Date(Date.now() + ttl * 1000) : undefined,
    };
  }

  async retrieveMemories(input: RetrieveMemoriesInput): Promise<SearchResult[]> {
    logger.info(
      `[Memory Service] retrieveMemories called with input:`,
      JSON.stringify(
        {
          organizationId: input.organizationId,
          roomId: input.roomId,
          query: input.query,
          limit: input.limit,
          type: input.type,
          tags: input.tags,
        },
        null,
        2,
      ),
    );

    const runtime = await this.getSystemRuntime();
    logger.info(`[Memory Service] Runtime initialized, agentId: ${runtime.agentId}`);

    if (input.query) {
      const queryHash = this.hashQuery(input.query, input);
      const cached = await memoryCache.getSearchResults(queryHash);
      if (cached) {
        logger.debug(
          `[Memory Service] Cache HIT for search query: ${input.query.substring(0, 50)}`,
        );
        return cached;
      }
    }

    let memories: Memory[] = [];

    // PERFORMANCE FIX: Use efficient single-room check when roomId is provided
    // instead of fetching all room IDs for the organization
    if (input.roomId) {
      logger.info(`[Memory Service] Checking room ownership for roomId ${input.roomId}`);

      const hasAccess = await this.checkRoomOwnership(input.organizationId, input.roomId);

      if (!hasAccess) {
        logger.warn(
          `[Memory Service] Room ${input.roomId} does not belong to organization ${input.organizationId}`,
        );
        return [];
      }

      logger.info(`[Memory Service] Room ${input.roomId} is allowed, fetching memories`);

      if (input.query) {
        const embedding = new Array(1536).fill(0);
        logger.info(`[Memory Service] Calling searchMemories with roomId: ${input.roomId}`);
        memories = await runtime.searchMemories({
          embedding,
          tableName: "memories",
          limit: input.limit || 10,
          roomId: input.roomId as UUID,
          match_threshold: 0.7,
        });
      } else {
        logger.info(`[Memory Service] Querying database directly for roomId: ${input.roomId}`);

        const results = await dbRead
          .select()
          .from(memoryTable)
          .where(
            and(eq(memoryTable.roomId, input.roomId), eq(memoryTable.agentId, runtime.agentId)),
          )
          .orderBy(desc(memoryTable.createdAt))
          .limit(input.limit || 10);

        memories = results.map(
          (row) =>
            ({
              id: row.id as UUID,
              type: row.type,
              createdAt: new Date(row.createdAt).getTime(),
              content: row.content,
              entityId: row.entityId as UUID,
              agentId: row.agentId as UUID,
              roomId: row.roomId as UUID,
              worldId: row.worldId as UUID | undefined,
              unique: row.unique,
            }) as Memory,
        );
      }

      logger.info(`[Memory Service] Database query returned ${memories.length} memories`);
    } else {
      logger.info(`[Memory Service] No specific roomId, fetching from all allowed rooms`);

      // Fetch all room IDs for the organization when no specific room is requested
      const allowedRoomIds = await this.getRoomIdsForOrganization(input.organizationId);

      logger.info(`[Memory Service] Allowed room IDs size: ${allowedRoomIds.size}`);

      if (allowedRoomIds.size === 0) {
        logger.warn(`[Memory Service] No rooms found for organization ${input.organizationId}`);
        return [];
      }

      const limit = input.limit || 10;
      const roomIdArray = Array.from(allowedRoomIds);

      // PERFORMANCE FIX: Use single batched query with IN clause instead of N+1 queries
      // This reduces N database round-trips to just 1
      const results = await dbRead
        .select()
        .from(memoryTable)
        .where(
          and(inArray(memoryTable.roomId, roomIdArray), eq(memoryTable.agentId, runtime.agentId)),
        )
        .orderBy(desc(memoryTable.createdAt))
        .limit(limit);

      memories = results.map(
        (row) =>
          ({
            id: row.id as UUID,
            type: row.type,
            createdAt: new Date(row.createdAt).getTime(),
            content: row.content,
            entityId: row.entityId as UUID,
            agentId: row.agentId as UUID,
            roomId: row.roomId as UUID,
            worldId: row.worldId as UUID | undefined,
            unique: row.unique,
          }) as Memory,
      );

      logger.info(
        `[Memory Service] Batched query returned ${memories.length} memories from ${roomIdArray.length} rooms`,
      );
    }

    const filteredMemories = memories;

    const results: SearchResult[] = filteredMemories.map((memory) => ({
      memory,
      score: 1.0,
      context: [],
    }));

    if (input.query) {
      const queryHash = this.hashQuery(input.query, input);
      await memoryCache.cacheSearchResults(queryHash, results, CacheTTL.memory.search);
    }

    logger.info(
      `[Memory Service] Retrieved ${results.length} memories (filtered from ${memories.length}) for query`,
    );
    return results;
  }

  async deleteMemory(input: DeleteMemoryInput): Promise<DeleteMemoryResult> {
    const runtime = await this.getSystemRuntime();
    let deletedCount = 0;

    if (input.memoryId) {
      await runtime.deleteMemory(input.memoryId as UUID);
      await memoryCache.invalidateMemory(input.memoryId);
      deletedCount = 1;
    }

    logger.info(
      `[Memory Service] Deleted ${deletedCount} memories for org ${input.organizationId}`,
    );

    return {
      deletedCount,
      storageFreed: deletedCount * 1024,
    };
  }

  async getRoomContext(
    roomId: string,
    organizationId: string,
    depth: number = 20,
  ): Promise<MemoryRoomContext> {
    const cached = await memoryCache.getRoomContext(roomId, organizationId);
    if (cached && cached.depth >= depth) {
      logger.debug(`[Memory Service] Cache HIT for room context: ${roomId}`);
      return cached;
    }

    const runtime = await this.getSystemRuntime();

    const memories = await runtime.getMemoriesByRoomIds({
      tableName: "messages",
      roomIds: [roomId as UUID],
      limit: depth,
    });

    const participants = await runtime.getParticipantsForRoom(roomId as UUID);

    const rooms = await runtime.getRoomsByIds([roomId as UUID]);
    const room = rooms && rooms.length > 0 ? rooms[0] : null;

    const context: MemoryRoomContext = {
      roomId,
      messages: memories,
      participants,
      metadata: room?.metadata || {},
      depth,
      timestamp: new Date(),
    };

    await memoryCache.cacheRoomContext(
      roomId,
      organizationId,
      context,
      CacheTTL.memory.roomContext,
    );

    logger.info(`[Memory Service] Retrieved room context: ${roomId} (${memories.length} messages)`);
    return context;
  }

  async summarizeConversation(
    input: SummarizeConversationInput,
  ): Promise<SummarizeConversationResult> {
    const cacheKey = `${input.roomId}:${input.lastN}:${input.style}`;
    const cached = await memoryCache.getMemory(
      CacheKeys.memory.conversationSummary(input.organizationId, cacheKey),
    );
    if (cached) {
      logger.debug(`[Memory Service] Cache HIT for conversation summary: ${input.roomId}`);
      // Type guard to ensure cached content matches SummarizeConversationResult
      const cachedContent = cached.content;
      if (isSummarizeConversationResult(cachedContent)) {
        return cachedContent;
      }
      // If cached content doesn't match expected structure, continue to generate new summary
    }

    const context = await this.getRoomContext(
      input.roomId,
      input.organizationId,
      input.lastN || 50,
    );

    const summaryPrompt = this.buildSummaryPrompt(context, input.style || "brief");

    const result = await streamText({
      model: getLanguageModel("gpt-5-mini"),
      prompt: summaryPrompt,
    });

    let fullText = "";
    for await (const delta of result.textStream) {
      fullText += delta;
    }

    const usage = await result.usage;

    const summary: SummarizeConversationResult = {
      summary: fullText,
      tokenCount: usage?.totalTokens || 0,
      keyTopics: this.extractTopics(fullText),
      participants: context.participants.map((p) => p.toString()),
    };

    // Convert summary to Memory content format
    const summaryContent: Content = {
      summary: summary.summary,
      tokenCount: summary.tokenCount,
      keyTopics: summary.keyTopics,
      participants: summary.participants,
    };

    const summaryMemory: Memory = {
      id: uuidv4() as UUID,
      roomId: input.roomId as UUID,
      entityId: context.participants[0] || ("system" as UUID),
      agentId: (await this.getSystemRuntime()).agentId,
      createdAt: Date.now(),
      content: summaryContent,
    };

    await memoryCache.cacheMemory(
      CacheKeys.memory.conversationSummary(input.organizationId, cacheKey),
      summaryMemory,
      CacheTTL.memory.conversationSummary,
    );

    logger.info(
      `[Memory Service] Generated conversation summary: ${input.roomId} (${usage?.totalTokens} tokens)`,
    );
    return summary;
  }

  private hashQuery(query: string, filters: Partial<RetrieveMemoriesInput>): string {
    const hash = createHash("md5").update(JSON.stringify({ query, filters })).digest("hex");
    return hash.substring(0, 16);
  }

  private buildSummaryPrompt(context: MemoryRoomContext, style: string): string {
    const messages = context.messages
      .slice(0, 50)
      .map((m) => `${m.entityId}: ${m.content.text}`)
      .join("\n");

    const styleInstructions = {
      brief: "Provide a concise 2-3 sentence summary.",
      detailed: "Provide a comprehensive summary with key points and discussion flow.",
      "bullet-points": "Provide a bulleted list of the main topics discussed.",
    };

    return `Summarize the following conversation in ${style} style. ${styleInstructions[style as keyof typeof styleInstructions] || styleInstructions.brief}

Conversation:
${messages}

Summary:`;
  }

  private extractTopics(text: string): string[] {
    const words = text
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 4);
    const wordCounts = new Map<string, number>();

    for (const word of words) {
      wordCounts.set(word, (wordCounts.get(word) || 0) + 1);
    }

    return Array.from(wordCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map((e) => e[0]);
  }

  async estimateTokenCount(messages: Memory[]): Promise<number> {
    const totalText = messages.map((m) => m.content.text || "").join(" ");
    return Math.ceil(totalText.length / 4);
  }

  async optimizeContextWindow(
    roomId: string,
    organizationId: string,
    maxTokens: number,
    query?: string,
    preserveRecent: number = 5,
  ): Promise<{
    messages: Memory[];
    totalTokens: number;
    messageCount: number;
    relevanceScores: Array<{ messageId: string; score: number }>;
  }> {
    const context = await this.getRoomContext(roomId, organizationId, 100);

    const recentMessages = context.messages.slice(0, preserveRecent);
    const olderMessages = context.messages.slice(preserveRecent);

    const selectedMessages = [...recentMessages];
    let currentTokens = await this.estimateTokenCount(recentMessages);

    const relevanceScores: Array<{ messageId: string; score: number }> = [];

    if (query) {
      for (const msg of olderMessages) {
        const msgText = msg.content.text || "";
        const score = this.calculateRelevanceScore(msgText, query);
        relevanceScores.push({
          messageId: msg.id?.toString() || "",
          score,
        });
      }

      relevanceScores.sort((a, b) => b.score - a.score);

      for (const scoreItem of relevanceScores) {
        const msg = olderMessages.find((m) => m.id?.toString() === scoreItem.messageId);
        if (msg) {
          const msgTokens = await this.estimateTokenCount([msg]);
          if (currentTokens + msgTokens <= maxTokens) {
            selectedMessages.push(msg);
            currentTokens += msgTokens;
          } else {
            break;
          }
        }
      }
    } else {
      for (const msg of olderMessages) {
        const msgTokens = await this.estimateTokenCount([msg]);
        if (currentTokens + msgTokens <= maxTokens) {
          selectedMessages.push(msg);
          currentTokens += msgTokens;
        } else {
          break;
        }
      }
    }

    logger.info(
      `[Memory Service] Optimized context: ${selectedMessages.length}/${context.messages.length} messages, ${currentTokens}/${maxTokens} tokens`,
    );

    return {
      messages: selectedMessages,
      totalTokens: currentTokens,
      messageCount: selectedMessages.length,
      relevanceScores,
    };
  }

  async exportConversation(
    conversationId: string,
    organizationId: string,
    format: "json" | "markdown" | "txt",
  ): Promise<{
    content: string;
    size: number;
    format: string;
  }> {
    const conversation = await conversationsService.getWithMessages(conversationId);

    if (!conversation) {
      throw new Error("Conversation not found");
    }

    let content = "";

    switch (format) {
      case "json":
        content = JSON.stringify(
          {
            id: conversation.id,
            title: conversation.title,
            model: conversation.model,
            createdAt: conversation.created_at,
            messages: conversation.messages.map((m: ConversationMessage) => ({
              id: m.id,
              role: m.role,
              content: m.content,
              tokens: m.tokens,
              cost: m.cost,
              createdAt: m.created_at,
            })),
            metadata: {
              messageCount: conversation.message_count,
              totalCost: conversation.total_cost,
            },
          },
          null,
          2,
        );
        break;

      case "markdown":
        content = `# ${conversation.title}\n\n`;
        content += `**Model**: ${conversation.model}\n`;
        content += `**Created**: ${conversation.created_at}\n`;
        content += `**Messages**: ${conversation.message_count}\n\n`;
        content += `---\n\n`;

        for (const msg of conversation.messages) {
          content += `## ${msg.role}\n\n`;
          content += `${msg.content}\n\n`;
          content += `_Tokens: ${msg.tokens || 0} | Cost: ${msg.cost || 0} credits_\n\n`;
          content += `---\n\n`;
        }
        break;

      case "txt":
        content = `Conversation: ${conversation.title}\n`;
        content += `Model: ${conversation.model}\n`;
        content += `Created: ${conversation.created_at}\n`;
        content += `\n${"=".repeat(80)}\n\n`;

        for (const msg of conversation.messages) {
          content += `[${msg.role.toUpperCase()}]\n`;
          content += `${msg.content}\n`;
          content += `\n${"-".repeat(80)}\n\n`;
        }
        break;
    }

    logger.info(`[Memory Service] Exported conversation ${conversationId} as ${format}`);

    return {
      content,
      size: content.length,
      format,
    };
  }

  async cloneConversation(
    conversationId: string,
    organizationId: string,
    userId: string,
    options: {
      newTitle?: string;
      preserveMessages?: boolean;
      preserveMemories?: boolean;
      newModel?: string;
    },
  ): Promise<{
    conversationId: string;
    clonedMessageCount: number;
  }> {
    const sourceConversation = await conversationsService.getWithMessages(conversationId);

    if (!sourceConversation) {
      throw new Error("Source conversation not found");
    }

    const newConversation = await conversationsService.create({
      organization_id: organizationId,
      user_id: userId,
      title: options.newTitle || `${sourceConversation.title} (Copy)`,
      model: options.newModel || sourceConversation.model,
      settings: sourceConversation.settings,
    });

    let clonedMessageCount = 0;

    if (options.preserveMessages && sourceConversation.messages.length > 0) {
      for (const msg of sourceConversation.messages) {
        await conversationsService.addMessage(
          newConversation.id,
          msg.role,
          msg.content,
          msg.sequence_number,
          {
            tokens: msg.tokens,
            cost: msg.cost,
          },
        );
        clonedMessageCount++;
      }
    }

    logger.info(
      `[Memory Service] Cloned conversation ${conversationId} to ${newConversation.id} with ${clonedMessageCount} messages`,
    );

    return {
      conversationId: newConversation.id,
      clonedMessageCount,
    };
  }

  async analyzeMemoryPatterns(
    organizationId: string,
    analysisType: "topics" | "sentiment" | "entities" | "timeline",
  ): Promise<{
    analysisType: string;
    insights: string[];
    data: Record<string, unknown>;
    chartData?: Array<{ label: string; value: number }>;
  }> {
    const memories = await this.retrieveMemories({
      organizationId,
      limit: 100,
    });

    const memoriesText = memories.map((m) => m.memory.content.text || "").join("\n");

    let insights: string[] = [];
    let data: Record<string, unknown> = {};
    let chartData: Array<{ label: string; value: number }> = [];

    switch (analysisType) {
      case "topics": {
        const topics = this.extractTopics(memoriesText);
        insights = [
          `Identified ${topics.length} key topics from ${memories.length} memories`,
          `Most frequent: ${topics.slice(0, 3).join(", ")}`,
        ];
        data = { topics };
        chartData = topics.map((topic, idx) => ({
          label: topic,
          value: topics.length - idx,
        }));
        break;
      }

      case "timeline": {
        const timelineData = memories.map((m) => ({
          date: new Date(m.memory.createdAt || Date.now()),
          type: m.memory.content.type || "unknown",
        }));

        const groupedByDay = new Map<string, number>();
        for (const item of timelineData) {
          const day = item.date.toISOString().split("T")[0];
          groupedByDay.set(day, (groupedByDay.get(day) || 0) + 1);
        }

        chartData = Array.from(groupedByDay.entries()).map(([label, value]) => ({ label, value }));

        insights = [
          `Analyzed ${memories.length} memories over ${groupedByDay.size} days`,
          `Peak activity: ${Math.max(...Array.from(groupedByDay.values()))} memories in a single day`,
        ];
        data = { timelineData: Object.fromEntries(groupedByDay) };
        break;
      }

      case "entities": {
        const words = memoriesText
          .toLowerCase()
          .split(/\W+/)
          .filter((w) => w.length > 3);
        const wordCounts = new Map<string, number>();
        for (const word of words) {
          wordCounts.set(word, (wordCounts.get(word) || 0) + 1);
        }

        const topEntities = Array.from(wordCounts.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10);

        chartData = topEntities.map(([label, value]) => ({ label, value }));
        insights = [
          `Extracted ${topEntities.length} key entities`,
          `Total unique words: ${wordCounts.size}`,
        ];
        data = { entities: Object.fromEntries(topEntities) };
        break;
      }

      case "sentiment": {
        const positiveWords = ["good", "great", "excellent", "happy", "love"];
        const negativeWords = ["bad", "terrible", "hate", "sad", "poor"];

        let positiveCount = 0;
        let negativeCount = 0;

        const lowerText = memoriesText.toLowerCase();
        for (const word of positiveWords) {
          positiveCount += (lowerText.match(new RegExp(word, "g")) || []).length;
        }
        for (const word of negativeWords) {
          negativeCount += (lowerText.match(new RegExp(word, "g")) || []).length;
        }

        const neutralCount = memories.length - positiveCount - negativeCount;

        chartData = [
          { label: "Positive", value: positiveCount },
          { label: "Neutral", value: neutralCount },
          { label: "Negative", value: negativeCount },
        ];

        insights = [
          `Sentiment distribution: ${positiveCount} positive, ${neutralCount} neutral, ${negativeCount} negative`,
          positiveCount > negativeCount
            ? "Overall positive sentiment detected"
            : "Overall negative sentiment detected",
        ];
        data = {
          positive: positiveCount,
          neutral: neutralCount,
          negative: negativeCount,
        };
        break;
      }
    }

    logger.info(`[Memory Service] Analyzed ${memories.length} memories for ${analysisType}`);

    return {
      analysisType,
      insights,
      data,
      chartData,
    };
  }

  private calculateRelevanceScore(text: string, query: string): number {
    const textLower = text.toLowerCase();
    const queryLower = query.toLowerCase();
    const queryWords = queryLower.split(/\s+/);

    let score = 0;
    for (const word of queryWords) {
      if (textLower.includes(word)) {
        score += 1;
      }
    }

    if (textLower.includes(queryLower)) {
      score += 5;
    }

    return score;
  }
}

export const memoryService = new MemoryService();
