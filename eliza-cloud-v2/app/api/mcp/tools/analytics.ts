/**
 * Analytics and discovery tools
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod3";
import { analyticsService } from "@/lib/services/analytics";
import { charactersService } from "@/lib/services/characters/characters";
import { userMcpsService } from "@/lib/services/user-mcps";
import { getAuthContext } from "../lib/context";
import { jsonResponse, errorResponse } from "../lib/responses";

export function registerAnalyticsTools(server: McpServer): void {
  server.registerTool(
    "get_analytics",
    {
      description: "Get organization analytics. FREE tool.",
      inputSchema: {
        period: z
          .enum(["day", "week", "month"])
          .optional()
          .default("week")
          .describe("Time period"),
      },
    },
    async ({ period }) => {
      try {
        const { user } = getAuthContext();
        const now = new Date();
        const startDate = new Date(now);
        if (period === "day") {
          startDate.setDate(now.getDate() - 1);
        } else if (period === "week") {
          startDate.setDate(now.getDate() - 7);
        } else {
          startDate.setMonth(now.getMonth() - 1);
        }

        const analytics = await analyticsService.getUsageStats(
          user.organization_id,
          { startDate, endDate: now },
        );

        return jsonResponse({ success: true, analytics });
      } catch (error) {
        return errorResponse(
          error instanceof Error ? error.message : "Failed to get analytics",
        );
      }
    },
  );

  server.registerTool(
    "stream_credit_updates",
    {
      description:
        "Get SSE stream URL for real-time credit updates. FREE tool.",
      inputSchema: {},
    },
    async () => {
      try {
        const { user } = getAuthContext();
        const baseUrl =
          process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
        const sseUrl = `${baseUrl}/api/mcp/stream?eventType=credits&resourceId=${user.organization_id}`;

        return jsonResponse({
          success: true,
          sseUrl,
          organizationId: user.organization_id,
          eventTypes: ["balance_update", "transaction", "low_balance_alert"],
        });
      } catch (error) {
        return errorResponse(
          error instanceof Error ? error.message : "Failed to generate SSE URL",
        );
      }
    },
  );

  server.registerTool(
    "discover_services",
    {
      description:
        "Discover services (agents, MCPs, apps) from Eliza Cloud. " +
        "Use this to find services to interact with. FREE tool.",
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe("Search query to filter by name or description"),
        types: z
          .array(z.enum(["agent", "mcp", "a2a", "app"]))
          .optional()
          .describe("Types of services to find"),
        categories: z
          .array(z.string())
          .optional()
          .describe("Filter by categories"),
        tags: z.array(z.string()).optional().describe("Filter by tags"),
        x402Only: z
          .boolean()
          .optional()
          .describe("Only return services with x402 payment support"),
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
    async ({ query, types, categories, x402Only, limit }) => {
      try {
        const baseUrl =
          process.env.NEXT_PUBLIC_APP_URL || "https://elizacloud.ai";
        const services: Array<{
          id: string;
          name: string;
          description: string;
          type: string;
          source: string;
          endpoint?: string;
          mcpEndpoint?: string;
          a2aEndpoint?: string;
          x402Support: boolean;
        }> = [];

        const searchTypes = types ?? ["agent", "mcp"];

        // Search agents
        if (searchTypes.includes("agent")) {
          let chars = await charactersService.listPublic();
          if (query) {
            const q = query.toLowerCase();
            chars = chars.filter(
              (c) =>
                c.name.toLowerCase().includes(q) ||
                (typeof c.bio === "string" &&
                  c.bio.toLowerCase().includes(q)) ||
                (Array.isArray(c.bio) &&
                  c.bio.some((b) => b.toLowerCase().includes(q))),
            );
          }
          if (categories?.length) {
            chars = chars.filter((c) => categories.includes(c.category ?? ""));
          }
          chars = chars.slice(0, limit ?? 20);
          for (const char of chars) {
            services.push({
              id: char.id,
              name: char.name,
              description: Array.isArray(char.bio)
                ? char.bio.join(" ")
                : char.bio,
              type: "agent",
              source: "local",
              a2aEndpoint: `${baseUrl}/api/agents/${char.id}/a2a`,
              mcpEndpoint: `${baseUrl}/api/agents/${char.id}/mcp`,
              x402Support: false,
            });
          }
        }

        // Search MCPs
        if (searchTypes.includes("mcp")) {
          let mcps = await userMcpsService.listPublic({
            category: categories?.[0],
            search: query,
            limit: limit,
          });
          if (x402Only) {
            mcps = mcps.filter((m) => m.x402_enabled);
          }
          for (const mcp of mcps) {
            services.push({
              id: mcp.id,
              name: mcp.name,
              description: mcp.description,
              type: "mcp",
              source: "local",
              mcpEndpoint: userMcpsService.getEndpointUrl(mcp, baseUrl),
              x402Support: mcp.x402_enabled,
            });
          }
        }

        return jsonResponse({
          success: true,
          count: services.length,
          services: services.slice(0, limit),
        });
      } catch (error) {
        return errorResponse(
          error instanceof Error ? error.message : "Discovery failed",
        );
      }
    },
  );
}
