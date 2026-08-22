/**
 * GET /api/mcp/info
 *
 * Metadata endpoint for the Eliza Cloud MCP server: the advertised tool
 * inventory, pricing posture, and authentication requirements.
 *
 * The inventory is DERIVED from the platform tool registry
 * (`listPlatformCloudMcpTools`) — the same source the JSON-RPC `tools/list`
 * handler and the `tools/call` dispatcher execute — so a planner reading this
 * document can never see a tool the server would fail to run. This endpoint is
 * unauthenticated and requires no DB or env access.
 */

import { Hono } from "hono";

import { listPlatformCloudMcpTools } from "@/lib/mcp/platform-cloud-tools";
import type { AppEnv } from "@/types/cloud-worker-env";

/** Category for a `cloud.<domain>.<action>` tool name; falls back to "platform". */
export function categoryForToolName(toolName: string): string {
  const parts = toolName.split(".");
  return parts.length >= 2 && parts[1].length > 0 ? parts[1] : "platform";
}

const app = new Hono<AppEnv>();

app.get("/", (c) => {
  const tools = listPlatformCloudMcpTools().map((tool) => ({
    name: tool.name,
    description: tool.description,
    category: categoryForToolName(tool.name),
  }));
  const categories = [...new Set(tools.map((tool) => tool.category))];

  return c.json({
    name: "Eliza Cloud MCP",
    version: "1.0.0",
    description:
      "Full access to Eliza Cloud features including account and organization management, credit balance and ledger, billing for deployed resources, app and agent operations, and authenticated REST capability access via MCP.",
    transport: ["streamable-http"],
    endpoint: "/api/mcp",
    authRequired: true,
    tools,
    toolCount: tools.length,
    categories,
    pricing: {
      type: "credits",
      description:
        "Uses your organization's USD-denominated cloud-credit balance",
      creditUnit: "USD",
    },
    authentication: {
      type: "Bearer",
      header: "Authorization",
      description:
        "Requires API key in Authorization header: Bearer YOUR_API_KEY",
    },
    status: "live",
  });
});

export default app;
