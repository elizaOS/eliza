/**
 * Conversation MCP tools
 * Tools for managing and analyzing conversations
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod3";
import {
  creditsService,
  InsufficientCreditsError,
  type CreditReservation,
} from "@/lib/services/credits";
import { usageService } from "@/lib/services/usage";
import { conversationsService } from "@/lib/services/conversations";
import { memoryService } from "@/lib/services/memory";
import {
  CONTEXT_RETRIEVAL_COST,
  CONVERSATION_CREATE_COST,
  CONVERSATION_SEARCH_COST,
  CONVERSATION_CLONE_COST,
  CONVERSATION_EXPORT_COST,
  CONTEXT_OPTIMIZATION_COST,
  CONVERSATION_SUMMARY_BASE_COST,
  CONVERSATION_SUMMARY_MAX_COST,
} from "@/lib/config/mcp";
import { getAuthContext } from "../lib/context";
import { jsonResponse, errorResponse } from "../lib/responses";

export function registerConversationTools(server: McpServer): void {
  // Get Conversation Context
  server.registerTool(
    "get_conversation_context",
    {
      description:
        "Retrieve enriched conversation context with memory integration. Deducts 1 credit per request.",
      inputSchema: {
        roomId: z.string().describe("Room/conversation ID"),
        depth: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .default(20)
          .describe("Number of messages to include"),
        includeMemories: z
          .boolean()
          .optional()
          .default(true)
          .describe("Include relevant saved memories"),
        format: z
          .enum(["chat", "json", "markdown"])
          .optional()
          .default("json")
          .describe("Output format"),
      },
    },
    async ({ roomId, depth = 20 }) => {
      try {
        const { user } = getAuthContext();

        let reservation: CreditReservation | null = null;
        try {
          reservation = await creditsService.reserve({
            organizationId: user.organization_id,
            amount: CONTEXT_RETRIEVAL_COST,
            userId: user.id,
            description: `MCP conversation context: ${roomId}`,
          });
        } catch (error) {
          if (error instanceof InsufficientCreditsError) {
            return errorResponse("Insufficient balance", {
              required: error.required,
            });
          }
          throw error;
        }

        let context;
        try {
          context = await memoryService.getRoomContext(
            roomId,
            user.organization_id,
            depth,
          );
        } catch (opError) {
          await reservation?.reconcile(0);
          throw opError;
        }

        await reservation?.reconcile(CONTEXT_RETRIEVAL_COST);

        await usageService.create({
          organization_id: user.organization_id,
          user_id: user.id,
          api_key_id: null,
          type: "memory",
          model: "context-retrieval",
          provider: "internal",
          input_tokens: 0,
          output_tokens: 0,
          input_cost: String(CONTEXT_RETRIEVAL_COST),
          output_cost: String(0),
          is_successful: true,
        });

        const tokenEstimate = await memoryService.estimateTokenCount(
          context.messages,
        );

        return jsonResponse({
          roomId: context.roomId,
          messageCount: context.messages.length,
          participants: context.participants.length,
          metadata: context.metadata,
          tokenEstimate,
          cost: String(CONTEXT_RETRIEVAL_COST),
          messages: context.messages.map((m) => ({
            id: m.id,
            content: m.content,
            createdAt: m.createdAt,
            entityId: m.entityId,
          })),
        });
      } catch (error) {
        return errorResponse(
          error instanceof Error
            ? error.message
            : "Failed to get conversation context",
        );
      }
    },
  );

  // Create Conversation
  server.registerTool(
    "create_conversation",
    {
      description:
        "Create a new conversation context with initial settings. Deducts 1 credit.",
      inputSchema: {
        title: z.string().min(1).describe("Conversation title"),
        model: z
          .string()
          .optional()
          .describe("Default model to use (default: gpt-4o)"),
        systemPrompt: z
          .string()
          .optional()
          .describe("System prompt for conversation"),
        settings: z
          .object({
            temperature: z.number().optional(),
            maxTokens: z.number().int().optional(),
            topP: z.number().optional(),
            frequencyPenalty: z.number().optional(),
            presencePenalty: z.number().optional(),
          })
          .optional()
          .describe("Model settings"),
      },
    },
    async ({ title, model, systemPrompt, settings }) => {
      const actualModel = model || "gpt-4o";
      try {
        const { user } = getAuthContext();

        let reservation: CreditReservation | null = null;
        try {
          reservation = await creditsService.reserve({
            organizationId: user.organization_id,
            amount: CONVERSATION_CREATE_COST,
            userId: user.id,
            description: `MCP conversation created: ${title}`,
          });
        } catch (error) {
          if (error instanceof InsufficientCreditsError) {
            return errorResponse("Insufficient balance", {
              required: error.required,
            });
          }
          throw error;
        }

        let conversation;
        try {
          conversation = await conversationsService.create({
            organization_id: user.organization_id,
            user_id: user.id,
            title,
            model: actualModel,
            settings: {
              ...settings,
              systemPrompt,
            },
          });
        } catch (opError) {
          await reservation?.reconcile(0);
          throw opError;
        }

        await reservation?.reconcile(CONVERSATION_CREATE_COST);

        await usageService.create({
          organization_id: user.organization_id,
          user_id: user.id,
          api_key_id: null,
          type: "conversation",
          model: "conversation-creation",
          provider: "internal",
          input_tokens: 0,
          output_tokens: 0,
          input_cost: String(CONVERSATION_CREATE_COST),
          output_cost: String(0),
          is_successful: true,
        });

        return jsonResponse({
          success: true,
          conversationId: conversation.id,
          title: conversation.title,
          model: conversation.model,
          cost: String(CONVERSATION_CREATE_COST),
        });
      } catch (error) {
        return errorResponse(
          error instanceof Error
            ? error.message
            : "Failed to create conversation",
        );
      }
    },
  );

  // Search Conversations
  server.registerTool(
    "search_conversations",
    {
      description:
        "Search through conversation history with filters. Deducts 2 credits per search.",
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe("Search query (semantic or keyword)"),
        model: z.array(z.string()).optional().describe("Filter by model used"),
        dateFrom: z.string().optional().describe("ISO date string (from)"),
        dateTo: z.string().optional().describe("ISO date string (to)"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .default(10)
          .describe("Maximum results"),
      },
    },
    async ({ query, limit = 10 }) => {
      try {
        const { user } = getAuthContext();

        let reservation: CreditReservation | null = null;
        try {
          reservation = await creditsService.reserve({
            organizationId: user.organization_id,
            amount: CONVERSATION_SEARCH_COST,
            userId: user.id,
            description: `MCP conversation search: ${query || "all"}`,
          });
        } catch (error) {
          if (error instanceof InsufficientCreditsError) {
            return errorResponse("Insufficient balance", {
              required: error.required,
            });
          }
          throw error;
        }

        let conversations;
        try {
          conversations = await conversationsService.listByOrganization(
            user.organization_id,
            limit,
          );
        } catch (opError) {
          await reservation?.reconcile(0);
          throw opError;
        }

        await reservation?.reconcile(CONVERSATION_SEARCH_COST);

        await usageService.create({
          organization_id: user.organization_id,
          user_id: user.id,
          api_key_id: null,
          type: "conversation",
          model: "conversation-search",
          provider: "internal",
          input_tokens: 0,
          output_tokens: 0,
          input_cost: String(CONVERSATION_SEARCH_COST),
          output_cost: String(0),
          is_successful: true,
        });

        return jsonResponse({
          conversations: conversations.map((c) => ({
            id: c.id,
            title: c.title,
            model: c.model,
            messageCount: c.message_count,
            totalCost: c.total_cost,
            lastMessageAt: c.last_message_at,
            createdAt: c.created_at,
          })),
          count: conversations.length,
          cost: String(CONVERSATION_SEARCH_COST),
        });
      } catch (error) {
        return errorResponse(
          error instanceof Error
            ? error.message
            : "Failed to search conversations",
        );
      }
    },
  );

  // Summarize Conversation
  server.registerTool(
    "summarize_conversation",
    {
      description:
        "Generate a summary of conversation history. Deducts 10-50 credits based on token usage.",
      inputSchema: {
        roomId: z.string().describe("Room/conversation ID to summarize"),
        lastN: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .default(50)
          .describe("Summarize last N messages"),
        style: z
          .enum(["brief", "detailed", "bullet-points"])
          .optional()
          .default("brief")
          .describe("Summary style"),
        includeMetadata: z
          .boolean()
          .optional()
          .default(false)
          .describe("Include participant and topic metadata"),
      },
    },
    async ({
      roomId,
      lastN = 50,
      style = "brief",
      includeMetadata = false,
    }) => {
      try {
        const { user } = getAuthContext();

        const estimatedCost = Math.min(
          CONVERSATION_SUMMARY_BASE_COST + Math.floor(lastN / 10),
          CONVERSATION_SUMMARY_MAX_COST,
        );

        let reservation: CreditReservation | null = null;
        try {
          reservation = await creditsService.reserve({
            organizationId: user.organization_id,
            amount: estimatedCost,
            userId: user.id,
            description: `MCP conversation summary: ${roomId}`,
          });
        } catch (error) {
          if (error instanceof InsufficientCreditsError) {
            return errorResponse("Insufficient balance", {
              required: error.required,
            });
          }
          throw error;
        }

        let summary;
        try {
          summary = await memoryService.summarizeConversation({
            roomId,
            organizationId: user.organization_id,
            lastN,
            style,
            includeMetadata,
          });
        } catch (opError) {
          await reservation?.reconcile(0);
          throw opError;
        }

        const actualCost = Math.min(
          CONVERSATION_SUMMARY_BASE_COST + Math.ceil(summary.tokenCount / 1000),
          CONVERSATION_SUMMARY_MAX_COST,
        );
        await reservation?.reconcile(actualCost);

        await usageService.create({
          organization_id: user.organization_id,
          user_id: user.id,
          api_key_id: null,
          type: "chat",
          model: "gpt-4o-mini",
          provider: "openai",
          input_tokens: summary.tokenCount,
          output_tokens: 0,
          input_cost: String(actualCost),
          output_cost: String(0),
          is_successful: true,
        });

        return jsonResponse({
          summary: summary.summary,
          tokenCount: summary.tokenCount,
          keyTopics: summary.keyTopics,
          participants: summary.participants,
          cost: String(actualCost),
        });
      } catch (error) {
        return errorResponse(
          error instanceof Error
            ? error.message
            : "Failed to summarize conversation",
        );
      }
    },
  );

  // Optimize Context Window
  server.registerTool(
    "optimize_context_window",
    {
      description:
        "Intelligently select the most relevant context for token-limited requests. Deducts 5 credits.",
      inputSchema: {
        roomId: z.string().describe("Room/conversation ID"),
        maxTokens: z
          .number()
          .int()
          .min(100)
          .max(100000)
          .describe("Token budget for context"),
        query: z
          .string()
          .optional()
          .describe("Current user query for relevance scoring"),
        preserveRecent: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .default(5)
          .describe("Always include N recent messages"),
      },
    },
    async ({ roomId, maxTokens, query, preserveRecent = 5 }) => {
      try {
        const { user } = getAuthContext();

        let reservation: CreditReservation | null = null;
        try {
          reservation = await creditsService.reserve({
            organizationId: user.organization_id,
            amount: CONTEXT_OPTIMIZATION_COST,
            userId: user.id,
            description: `MCP context optimization: ${roomId}`,
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

        let optimized;
        try {
          optimized = await memoryService.optimizeContextWindow(
            roomId,
            user.organization_id,
            maxTokens,
            query,
            preserveRecent,
          );
        } catch (opError) {
          await reservation?.reconcile(0);
          throw opError;
        }

        await reservation?.reconcile(CONTEXT_OPTIMIZATION_COST);

        await usageService.create({
          organization_id: user.organization_id,
          user_id: user.id,
          api_key_id: null,
          type: "memory",
          model: "context-optimization",
          provider: "internal",
          input_tokens: 0,
          output_tokens: 0,
          input_cost: String(CONTEXT_OPTIMIZATION_COST),
          output_cost: String(0),
          is_successful: true,
        });

        return jsonResponse({
          messages: optimized.messages.map((m) => ({
            id: m.id,
            content: m.content,
            createdAt: m.createdAt,
          })),
          totalTokens: optimized.totalTokens,
          messageCount: optimized.messageCount,
          relevanceScores: optimized.relevanceScores,
          cost: String(CONTEXT_OPTIMIZATION_COST),
        });
      } catch (error) {
        return errorResponse(
          error instanceof Error
            ? error.message
            : "Failed to optimize context window",
        );
      }
    },
  );

  // Export Conversation
  server.registerTool(
    "export_conversation",
    {
      description:
        "Export conversation history in various formats (json, markdown, txt). Deducts 5 credits.",
      inputSchema: {
        conversationId: z.string().describe("Conversation ID to export"),
        format: z.enum(["json", "markdown", "txt"]).describe("Export format"),
        includeMemories: z
          .boolean()
          .optional()
          .default(false)
          .describe("Include related memories"),
        includeMetadata: z
          .boolean()
          .optional()
          .default(true)
          .describe("Include conversation metadata"),
      },
    },
    async ({ conversationId, format }) => {
      try {
        const { user } = getAuthContext();

        let reservation: CreditReservation | null = null;
        try {
          reservation = await creditsService.reserve({
            organizationId: user.organization_id,
            amount: CONVERSATION_EXPORT_COST,
            userId: user.id,
            description: `MCP conversation export: ${conversationId}`,
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

        let exportData;
        try {
          exportData = await memoryService.exportConversation(
            conversationId,
            user.organization_id,
            format,
          );
        } catch (opError) {
          await reservation?.reconcile(0);
          throw opError;
        }

        await reservation?.reconcile(CONVERSATION_EXPORT_COST);

        await usageService.create({
          organization_id: user.organization_id,
          user_id: user.id,
          api_key_id: null,
          type: "conversation",
          model: "conversation-export",
          provider: "internal",
          input_tokens: 0,
          output_tokens: 0,
          input_cost: String(CONVERSATION_EXPORT_COST),
          output_cost: String(0),
          is_successful: true,
        });

        return jsonResponse({
          content: exportData.content,
          format: exportData.format,
          size: exportData.size,
          cost: String(CONVERSATION_EXPORT_COST),
        });
      } catch (error) {
        return errorResponse(
          error instanceof Error
            ? error.message
            : "Failed to export conversation",
        );
      }
    },
  );

  // Clone Conversation
  server.registerTool(
    "clone_conversation",
    {
      description:
        "Duplicate a conversation with optional modifications. Deducts 2 credits.",
      inputSchema: {
        conversationId: z.string().describe("Source conversation ID"),
        newTitle: z
          .string()
          .optional()
          .describe("New title (defaults to 'Original (Copy)')"),
        preserveMessages: z
          .boolean()
          .optional()
          .default(true)
          .describe("Copy all messages"),
        preserveMemories: z
          .boolean()
          .optional()
          .default(false)
          .describe("Copy related memories"),
        newModel: z.string().optional().describe("Change model (optional)"),
      },
    },
    async ({
      conversationId,
      newTitle,
      preserveMessages = true,
      preserveMemories = false,
      newModel,
    }) => {
      try {
        const { user } = getAuthContext();

        let reservation: CreditReservation | null = null;
        try {
          reservation = await creditsService.reserve({
            organizationId: user.organization_id,
            amount: CONVERSATION_CLONE_COST,
            userId: user.id,
            description: `MCP conversation clone: ${conversationId}`,
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

        let cloneResult;
        try {
          cloneResult = await memoryService.cloneConversation(
            conversationId,
            user.organization_id,
            user.id,
            {
              newTitle,
              preserveMessages,
              preserveMemories,
              newModel,
            },
          );
        } catch (opError) {
          await reservation?.reconcile(0);
          throw opError;
        }

        await reservation?.reconcile(CONVERSATION_CLONE_COST);

        await usageService.create({
          organization_id: user.organization_id,
          user_id: user.id,
          api_key_id: null,
          type: "conversation",
          model: "conversation-clone",
          provider: "internal",
          input_tokens: 0,
          output_tokens: 0,
          input_cost: String(CONVERSATION_CLONE_COST),
          output_cost: String(0),
          is_successful: true,
        });

        return jsonResponse({
          success: true,
          conversationId: cloneResult.conversationId,
          clonedMessageCount: cloneResult.clonedMessageCount,
          cost: String(CONVERSATION_CLONE_COST),
        });
      } catch (error) {
        return errorResponse(
          error instanceof Error
            ? error.message
            : "Failed to clone conversation",
        );
      }
    },
  );
}
