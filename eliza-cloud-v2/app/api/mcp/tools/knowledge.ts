/**
 * Knowledge and gallery tools
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod3";
import { memoryService } from "@/lib/services/memory";
import { generationsService } from "@/lib/services/generations";
import { getAuthContext } from "../lib/context";
import { jsonResponse, errorResponse } from "../lib/responses";

export function registerKnowledgeTools(server: McpServer): void {
  server.registerTool(
    "query_knowledge",
    {
      description:
        "Query the knowledge base using semantic search. Cost: varies by result count",
      inputSchema: {
        query: z.string().describe("Search query"),
        characterId: z
          .string()
          .optional()
          .describe("Filter by character/agent ID"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .default(5)
          .describe("Max results"),
      },
    },
    async ({ query, characterId, limit }) => {
      try {
        const { user } = getAuthContext();

        const results = await memoryService.retrieveMemories({
          organizationId: user.organization_id,
          query,
          roomId: characterId,
          limit,
          sortBy: "relevance",
        });

        return jsonResponse({
          success: true,
          results: results.map((r) => ({
            content: r.memory.content?.text || String(r.memory.content),
            score: r.score,
            id: r.memory.id,
          })),
          count: results.length,
        });
      } catch (error) {
        return errorResponse(
          error instanceof Error ? error.message : "Failed to query knowledge",
        );
      }
    },
  );

  server.registerTool(
    "list_gallery",
    {
      description: "List all generated media (images and videos). FREE tool.",
      inputSchema: {
        type: z
          .enum(["image", "video"])
          .optional()
          .describe("Filter by media type"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .default(20)
          .describe("Max results"),
      },
    },
    async ({ type, limit }) => {
      try {
        const { user } = getAuthContext();

        let generations = await generationsService.listByOrganization(
          user.organization_id,
          limit,
        );
        if (type) {
          generations = generations.filter((g) => g.type === type);
        }

        return jsonResponse({
          success: true,
          media: generations.map((g) => ({
            id: g.id,
            type: g.type,
            url: g.storage_url || g.content || "",
            prompt: g.prompt || "",
            status: g.status,
            createdAt: g.created_at,
          })),
          total: generations.length,
        });
      } catch (error) {
        return errorResponse(
          error instanceof Error ? error.message : "Failed to list gallery",
        );
      }
    },
  );
}
