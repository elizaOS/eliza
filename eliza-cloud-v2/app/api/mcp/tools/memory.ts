/**
 * Memory MCP tools
 * Tools for saving, retrieving, deleting, and analyzing memories
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod3";
import DOMPurify from "isomorphic-dompurify";
import {
  creditsService,
  InsufficientCreditsError,
  type CreditReservation,
} from "@/lib/services/credits";
import { usageService } from "@/lib/services/usage";
import { memoryService } from "@/lib/services/memory";
import {
  MEMORY_SAVE_COST,
  MEMORY_RETRIEVAL_COST_PER_ITEM,
  MEMORY_RETRIEVAL_MAX_COST,
  MEMORY_ANALYSIS_COST,
} from "@/lib/config/mcp";
import { getAuthContext } from "../lib/context";
import { jsonResponse, errorResponse } from "../lib/responses";

export function registerMemoryTools(server: McpServer): void {
  // Save Memory
  server.registerTool(
    "save_memory",
    {
      description:
        "Save important information to long-term memory with semantic tagging. Deducts 1 credit per save.",
      inputSchema: {
        content: z
          .string()
          .min(1)
          .max(10000)
          .describe("The memory content to save"),
        type: z
          .enum(["fact", "preference", "context", "document"])
          .describe("Type of memory being saved"),
        tags: z
          .array(z.string())
          .optional()
          .describe("Optional tags for categorization"),
        metadata: z
          .record(z.unknown())
          .optional()
          .describe("Additional metadata"),
        ttl: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Optional TTL in seconds (Redis only)"),
        persistent: z
          .boolean()
          .optional()
          .default(true)
          .describe("Store in PostgreSQL (default: true)"),
        roomId: z
          .string()
          .describe("Room ID to associate memory with (required)"),
      },
    },
    async ({
      content,
      type,
      tags,
      metadata,
      ttl,
      persistent = true,
      roomId,
    }) => {
      try {
        const { user } = getAuthContext();

        if (!roomId) {
          return errorResponse(
            "roomId is required. Memory must be associated with a room/conversation.",
          );
        }

        // Sanitize content to prevent stored XSS
        const sanitizedContent = DOMPurify.sanitize(content, {
          ALLOWED_TAGS: [],
          ALLOWED_ATTR: [],
          KEEP_CONTENT: true,
        });

        // Validate metadata size (max 5KB)
        if (metadata) {
          const metadataSize = JSON.stringify(metadata).length;
          const MAX_METADATA_SIZE = 5 * 1024;

          if (metadataSize > MAX_METADATA_SIZE) {
            return errorResponse("Metadata too large", {
              maxSize: MAX_METADATA_SIZE,
              actualSize: metadataSize,
            });
          }
        }

        // Validate and sanitize tags
        let sanitizedTags = tags;
        if (tags && tags.length > 0) {
          if (tags.length > 20) {
            return errorResponse("Too many tags", {
              maxTags: 20,
              provided: tags.length,
            });
          }

          sanitizedTags = tags
            .map((tag: string) =>
              DOMPurify.sanitize(tag, {
                ALLOWED_TAGS: [],
                ALLOWED_ATTR: [],
                KEEP_CONTENT: true,
              })
                .trim()
                .substring(0, 50),
            )
            .filter((tag: string) => tag.length > 0);
        }

        // Reserve credits BEFORE operation
        let reservation: CreditReservation | null = null;
        try {
          reservation = await creditsService.reserve({
            organizationId: user.organization_id,
            amount: MEMORY_SAVE_COST,
            userId: user.id,
            description: `MCP memory save: ${type}`,
          });
        } catch (error) {
          if (error instanceof InsufficientCreditsError) {
            return errorResponse("Insufficient balance", {
              required: error.required,
            });
          }
          throw error;
        }

        let result: Awaited<ReturnType<typeof memoryService.saveMemory>>;
        try {
          result = await memoryService.saveMemory({
            organizationId: user.organization_id,
            roomId,
            entityId: user.id,
            content: sanitizedContent,
            type,
            tags: sanitizedTags,
            metadata,
            ttl,
            persistent,
          });
        } catch (saveError) {
          await reservation?.reconcile(0);
          throw saveError;
        }

        await reservation?.reconcile(MEMORY_SAVE_COST);

        await usageService.create({
          organization_id: user.organization_id,
          user_id: user.id,
          api_key_id: null,
          type: "memory",
          model: "memory-storage",
          provider: "internal",
          input_tokens: 0,
          output_tokens: 0,
          input_cost: String(MEMORY_SAVE_COST),
          output_cost: String(0),
          is_successful: true,
        });

        return jsonResponse({
          success: true,
          memoryId: result.memoryId,
          storage: result.storage,
          expiresAt: result.expiresAt?.toISOString(),
          cost: String(MEMORY_SAVE_COST),
        });
      } catch (error) {
        return errorResponse(
          error instanceof Error ? error.message : "Failed to save memory",
        );
      }
    },
  );

  // Retrieve Memories
  server.registerTool(
    "retrieve_memories",
    {
      description:
        "Search and retrieve memories using semantic search or filters. Deducts 0.1 credit per memory retrieved (max 5 credits).",
      inputSchema: {
        query: z.string().optional().describe("Semantic search query"),
        roomId: z
          .string()
          .optional()
          .describe("Filter to specific room/conversation"),
        type: z.array(z.string()).optional().describe("Filter by memory type"),
        tags: z.array(z.string()).optional().describe("Filter by tags"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .default(10)
          .describe("Maximum results to return"),
        sortBy: z
          .enum(["relevance", "recent", "importance"])
          .optional()
          .default("relevance")
          .describe("Sort order"),
      },
    },
    async ({ query, roomId, type, tags, limit = 10, sortBy = "relevance" }) => {
      try {
        const { user } = getAuthContext();

        // Reserve max credits BEFORE retrieval
        let reservation: CreditReservation | null = null;
        try {
          reservation = await creditsService.reserve({
            organizationId: user.organization_id,
            amount: MEMORY_RETRIEVAL_MAX_COST,
            userId: user.id,
            description: "MCP memory retrieval",
          });
        } catch (error) {
          if (error instanceof InsufficientCreditsError) {
            return errorResponse("Insufficient balance", {
              required: error.required,
            });
          }
          throw error;
        }

        const sortOrder =
          sortBy === "relevance" ||
          sortBy === "recent" ||
          sortBy === "importance"
            ? sortBy
            : "relevance";

        let memories: Awaited<
          ReturnType<typeof memoryService.retrieveMemories>
        >;
        try {
          memories = await memoryService.retrieveMemories({
            organizationId: user.organization_id,
            query,
            roomId,
            type,
            tags,
            limit,
            sortBy: sortOrder,
          });
        } catch (retrieveError) {
          await reservation?.reconcile(0);
          throw retrieveError;
        }

        // Calculate actual cost and reconcile
        const actualCost = Math.min(
          Math.ceil(memories.length * MEMORY_RETRIEVAL_COST_PER_ITEM),
          MEMORY_RETRIEVAL_MAX_COST,
        );
        await reservation?.reconcile(actualCost);

        if (actualCost > 0) {
          await usageService.create({
            organization_id: user.organization_id,
            user_id: user.id,
            api_key_id: null,
            type: "memory",
            model: "memory-retrieval",
            provider: "internal",
            input_tokens: 0,
            output_tokens: 0,
            input_cost: String(actualCost),
            output_cost: String(0),
            is_successful: true,
          });
        }

        return jsonResponse({
          memories: memories.map((m) => ({
            id: m.memory.id,
            content: m.memory.content,
            score: m.score,
            createdAt: m.memory.createdAt,
          })),
          count: memories.length,
          cost: String(actualCost),
        });
      } catch (error) {
        return errorResponse(
          error instanceof Error
            ? error.message
            : "Failed to retrieve memories",
        );
      }
    },
  );

  // Delete Memory
  server.registerTool(
    "delete_memory",
    {
      description:
        "Remove a specific memory or bulk delete by filters. No credit cost.",
      inputSchema: {
        memoryId: z
          .string()
          .optional()
          .describe("Specific memory ID to delete"),
        olderThan: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Delete memories older than N days"),
        type: z.array(z.string()).optional().describe("Delete by type"),
        tags: z.array(z.string()).optional().describe("Delete by tags"),
      },
    },
    async ({ memoryId, olderThan, type, tags }) => {
      try {
        const { user } = getAuthContext();

        const result = await memoryService.deleteMemory({
          organizationId: user.organization_id,
          memoryId,
          olderThan,
          type,
          tags,
        });

        await usageService.create({
          organization_id: user.organization_id,
          user_id: user.id,
          api_key_id: null,
          type: "memory",
          model: "memory-deletion",
          provider: "internal",
          input_tokens: 0,
          output_tokens: 0,
          input_cost: String(0),
          output_cost: String(0),
          is_successful: true,
        });

        return jsonResponse({
          success: true,
          deletedCount: result.deletedCount,
          storageFreed: result.storageFreed,
        });
      } catch (error) {
        return errorResponse(
          error instanceof Error ? error.message : "Failed to delete memory",
        );
      }
    },
  );

  // Analyze Memory Patterns
  server.registerTool(
    "analyze_memory_patterns",
    {
      description:
        "Analyze user/org memory patterns for insights (topics, sentiment, entities, timeline). Deducts 20 credits.",
      inputSchema: {
        analysisType: z
          .enum(["topics", "sentiment", "entities", "timeline"])
          .describe("Type of analysis to perform"),
        timeRange: z
          .object({
            from: z.string().describe("ISO date string"),
            to: z.string().describe("ISO date string"),
          })
          .optional()
          .describe("Time range for analysis"),
        groupBy: z
          .enum(["day", "week", "month"])
          .optional()
          .describe("Grouping for timeline analysis"),
      },
    },
    async ({ analysisType }) => {
      try {
        const { user } = getAuthContext();

        // Reserve credits BEFORE operation
        let reservation: CreditReservation | null = null;
        try {
          reservation = await creditsService.reserve({
            organizationId: user.organization_id,
            amount: MEMORY_ANALYSIS_COST,
            userId: user.id,
            description: `MCP memory analysis: ${analysisType}`,
          });
        } catch (error) {
          if (error instanceof InsufficientCreditsError) {
            return errorResponse("Insufficient balance", {
              required: error.required,
              available: error.available,
            });
          }
          throw error;
        }

        let analysis;
        try {
          analysis = await memoryService.analyzeMemoryPatterns(
            user.organization_id,
            analysisType,
          );
        } catch (opError) {
          await reservation?.reconcile(0);
          throw opError;
        }

        await reservation?.reconcile(MEMORY_ANALYSIS_COST);

        await usageService.create({
          organization_id: user.organization_id,
          user_id: user.id,
          api_key_id: null,
          type: "memory",
          model: "memory-analysis",
          provider: "internal",
          input_tokens: 0,
          output_tokens: 0,
          input_cost: String(MEMORY_ANALYSIS_COST),
          output_cost: String(0),
          is_successful: true,
        });

        return jsonResponse({
          analysisType: analysis.analysisType,
          insights: analysis.insights,
          data: analysis.data,
          chartData: analysis.chartData,
          cost: String(MEMORY_ANALYSIS_COST),
        });
      } catch (error) {
        return errorResponse(
          error instanceof Error
            ? error.message
            : "Failed to analyze memory patterns",
        );
      }
    },
  );
}
