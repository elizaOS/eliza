/**
 * MCP Server management tools
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod3";
import { userMcpsService } from "@/lib/services/user-mcps";
import { getAuthContext } from "../lib/context";
import { jsonResponse, errorResponse } from "../lib/responses";

export function registerMcpTools(server: McpServer): void {
  server.registerTool(
    "list_mcps",
    {
      description: "List MCP servers. FREE tool.",
      inputSchema: {
        scope: z
          .enum(["own", "public"])
          .optional()
          .default("own")
          .describe("Scope"),
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
    async ({ scope, limit }) => {
      try {
        const { user } = getAuthContext();
        const mcps =
          scope === "public"
            ? await userMcpsService.listPublic({ limit })
            : await userMcpsService.listByOrganization(user.organization_id, {
                limit,
                offset: 0,
              });

        return jsonResponse({
          success: true,
          mcps: mcps.map((m) => ({
            id: m.id,
            name: m.name,
            slug: m.slug,
            status: m.status,
          })),
          total: mcps.length,
        });
      } catch (error) {
        return errorResponse(
          error instanceof Error ? error.message : "Failed to list MCPs",
        );
      }
    },
  );

  server.registerTool(
    "create_mcp",
    {
      description: "Create a new MCP server. FREE tool.",
      inputSchema: {
        name: z.string().min(1).max(100).describe("MCP name"),
        slug: z
          .string()
          .min(1)
          .max(50)
          .regex(/^[a-z0-9-]+$/)
          .describe("URL slug"),
        description: z.string().min(1).max(1000).describe("Description"),
      },
    },
    async ({ name, slug, description }) => {
      try {
        const { user } = getAuthContext();
        const mcp = await userMcpsService.create({
          organizationId: user.organization_id,
          userId: user.id,
          name,
          slug,
          description,
        });

        return jsonResponse({ success: true, mcpId: mcp.id, slug: mcp.slug });
      } catch (error) {
        return errorResponse(
          error instanceof Error ? error.message : "Failed to create MCP",
        );
      }
    },
  );

  server.registerTool(
    "delete_mcp",
    {
      description: "Delete an MCP server. FREE tool.",
      inputSchema: {
        mcpId: z.string().uuid().describe("MCP ID to delete"),
      },
    },
    async ({ mcpId }) => {
      try {
        const { user } = getAuthContext();
        await userMcpsService.delete(mcpId, user.organization_id);
        return jsonResponse({ success: true, mcpId });
      } catch (error) {
        return errorResponse(
          error instanceof Error ? error.message : "Failed to delete MCP",
        );
      }
    },
  );
}
