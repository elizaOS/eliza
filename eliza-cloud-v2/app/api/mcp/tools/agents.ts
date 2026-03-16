/**
 * Agent MCP tools
 * Tools for managing and interacting with elizaOS agents
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod3";
import { logger } from "@/lib/utils/logger";
import {
  creditsService,
  InsufficientCreditsError,
  type CreditReservation,
} from "@/lib/services/credits";
import { usageService } from "@/lib/services/usage";
import { contentModerationService } from "@/lib/services/content-moderation";
import { characterDeploymentDiscoveryService as agentDiscoveryService } from "@/lib/services/deployments/discovery";
import { agentService } from "@/lib/services/agents/agents";
import { charactersService } from "@/lib/services/characters/characters";
import {
  AGENT_CHAT_MIN_COST,
  AGENT_CHAT_INPUT_TOKEN_COST,
  AGENT_CHAT_OUTPUT_TOKEN_COST,
} from "@/lib/config/mcp";
import { getAuthContext } from "../lib/context";
import { jsonResponse, errorResponse } from "../lib/responses";

export function registerAgentTools(server: McpServer): void {
  // Chat with Agent
  server.registerTool(
    "chat_with_agent",
    {
      description:
        "Send a message to your deployed elizaOS agent and receive a response. Supports streaming via SSE. Charges $0.0001-$0.01 based on token usage.",
      inputSchema: {
        message: z
          .string()
          .min(1)
          .max(4000)
          .describe("Message to send to the agent"),
        roomId: z
          .string()
          .uuid()
          .optional()
          .describe(
            "Existing conversation room ID (creates new if not provided)",
          ),
        entityId: z
          .string()
          .optional()
          .describe("User identifier (defaults to authenticated user)"),
        streaming: z
          .boolean()
          .optional()
          .default(false)
          .describe("Enable streaming response via SSE"),
      },
    },
    async ({ message, roomId, entityId, streaming = false }) => {
      try {
        const { user } = getAuthContext();

        if (await contentModerationService.shouldBlockUser(user.id)) {
          return errorResponse("Account suspended due to policy violations");
        }

        contentModerationService.moderateInBackground(
          message,
          user.id,
          roomId,
          (result) => {
            logger.warn("[MCP] chat_with_agent moderation violation", {
              userId: user.id,
              categories: result.flaggedCategories,
              action: result.action,
            });
          },
        );

        const estimatedInputTokens = Math.ceil(message.length / 4);
        const estimatedCost = Math.max(
          AGENT_CHAT_MIN_COST,
          Math.ceil(estimatedInputTokens * AGENT_CHAT_INPUT_TOKEN_COST),
        );

        let reservation: CreditReservation | null = null;
        try {
          reservation = await creditsService.reserve({
            organizationId: user.organization_id,
            amount: estimatedCost * 2,
            userId: user.id,
            description: "MCP chat with agent",
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

        let actualRoomId;
        let response;
        try {
          actualRoomId =
            roomId ||
            (await agentService.getOrCreateRoom(
              entityId || user.id,
              user.organization_id,
            ));

          response = await agentService.sendMessage({
            roomId: actualRoomId,
            entityId: entityId || user.id,
            message,
            organizationId: user.organization_id,
            streaming,
          });
        } catch (opError) {
          await reservation?.reconcile(0);
          throw opError;
        }

        const actualCost = Math.ceil(
          (response.usage?.inputTokens || estimatedInputTokens) *
            AGENT_CHAT_INPUT_TOKEN_COST +
            (response.usage?.outputTokens || 0) * AGENT_CHAT_OUTPUT_TOKEN_COST,
        );

        await reservation?.reconcile(actualCost);

        await usageService.create({
          organization_id: user.organization_id,
          user_id: user.id,
          type: "mcp_tool",
          model: response.usage?.model || "eliza-agent",
          provider: "eliza",
          input_tokens: response.usage?.inputTokens || 0,
          output_tokens: response.usage?.outputTokens || 0,
          input_cost: String(actualCost),
          output_cost: String(0),
          is_successful: true,
          error_message: null,
          metadata: { tool: "chat_with_agent", room_id: actualRoomId },
        });

        return jsonResponse({
          success: true,
          response: response.content,
          roomId: actualRoomId,
          messageId: response.messageId,
          timestamp: response.timestamp,
          creditsUsed: actualCost,
          ...(streaming &&
            response.streaming && {
              streamUrl: response.streaming.sseUrl,
            }),
          usage: response.usage,
        });
      } catch (error) {
        return errorResponse(
          error instanceof Error ? error.message : "Failed to chat with agent",
        );
      }
    },
  );

  // List Agents
  server.registerTool(
    "list_agents",
    {
      description:
        "List all available agents, characters, and deployed elizaOS instances. FREE tool.",
      inputSchema: {
        filters: z
          .object({
            deployed: z.boolean().optional(),
            template: z.boolean().optional(),
            owned: z.boolean().optional(),
          })
          .optional(),
        includeStats: z.boolean().optional().default(false),
      },
    },
    async ({ filters, includeStats = false }) => {
      try {
        const { user } = getAuthContext();

        const result = await agentDiscoveryService.listCharacters(
          user.organization_id,
          user.id,
          filters,
          includeStats,
        );

        return jsonResponse({
          success: true,
          agents: result.characters,
          total: result.total,
          cached: result.cached,
        });
      } catch (error) {
        return errorResponse(
          error instanceof Error ? error.message : "Failed to list agents",
        );
      }
    },
  );

  // Subscribe Agent Events
  server.registerTool(
    "subscribe_agent_events",
    {
      description: "Get SSE stream URL for real-time agent events. FREE tool.",
      inputSchema: {
        roomId: z.string().uuid(),
      },
    },
    async ({ roomId }) => {
      try {
        const baseUrl =
          process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
        const sseUrl = `${baseUrl}/api/mcp/stream?eventType=agent&resourceId=${roomId}`;

        return jsonResponse({
          success: true,
          sseUrl,
          roomId,
          eventTypes: [
            "message_received",
            "response_started",
            "response_chunk",
            "response_complete",
            "error",
          ],
        });
      } catch (error) {
        return errorResponse(
          error instanceof Error ? error.message : "Failed to generate SSE URL",
        );
      }
    },
  );

  // Create Agent
  server.registerTool(
    "create_agent",
    {
      description: "Create a new agent/character. Cost: FREE",
      inputSchema: {
        name: z.string().describe("Agent name"),
        bio: z.union([z.string(), z.array(z.string())]).describe("Agent bio"),
        system: z.string().optional().describe("System prompt"),
        category: z
          .string()
          .optional()
          .default("assistant")
          .describe("Agent category"),
        tags: z.array(z.string()).optional().describe("Agent tags"),
      },
    },
    async ({ name, bio, system, category, tags }) => {
      try {
        const { user } = getAuthContext();

        const character = await charactersService.create({
          organization_id: user.organization_id,
          user_id: user.id,
          name,
          bio: Array.isArray(bio) ? bio : [bio],
          system: system || null,
          category: category || "assistant",
          tags: tags || [],
          character_data: {},
          source: "mcp",
        });

        return jsonResponse({
          success: true,
          agentId: character.id,
          name: character.name,
        });
      } catch (error) {
        return errorResponse(
          error instanceof Error ? error.message : "Failed to create agent",
        );
      }
    },
  );

  // Update Agent
  server.registerTool(
    "update_agent",
    {
      description: "Update an existing agent/character. Cost: FREE",
      inputSchema: {
        agentId: z.string().describe("Agent ID to update"),
        name: z.string().optional().describe("New agent name"),
        bio: z
          .union([z.string(), z.array(z.string())])
          .optional()
          .describe("New agent bio"),
        system: z.string().optional().describe("New system prompt"),
        category: z.string().optional().describe("New category"),
        tags: z.array(z.string()).optional().describe("New tags"),
      },
    },
    async ({ agentId, name, bio, system, category, tags }) => {
      try {
        const { user } = getAuthContext();

        const updates: Record<string, unknown> = {};
        if (name) updates.name = name;
        if (bio) updates.bio = Array.isArray(bio) ? bio : [bio];
        if (system !== undefined) updates.system = system;
        if (category) updates.category = category;
        if (tags) updates.tags = tags;

        const updated = await charactersService.updateForUser(
          agentId,
          user.id,
          updates,
        );
        if (!updated) throw new Error("Agent not found or not owned by user");

        return jsonResponse({ success: true, agentId });
      } catch (error) {
        return errorResponse(
          error instanceof Error ? error.message : "Failed to update agent",
        );
      }
    },
  );

  // Delete Agent
  server.registerTool(
    "delete_agent",
    {
      description: "Delete an agent/character. Cost: FREE",
      inputSchema: {
        agentId: z.string().describe("Agent ID to delete"),
      },
    },
    async ({ agentId }) => {
      try {
        const { user } = getAuthContext();

        const deleted = await charactersService.deleteForUser(agentId, user.id);
        if (!deleted) throw new Error("Agent not found or not owned by user");

        return jsonResponse({ success: true, agentId });
      } catch (error) {
        return errorResponse(
          error instanceof Error ? error.message : "Failed to delete agent",
        );
      }
    },
  );
}
