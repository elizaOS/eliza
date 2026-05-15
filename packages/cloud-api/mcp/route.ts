/**
 * /api/mcp — Eliza Cloud platform MCP (streamable-http).
 *
 * When `ELIZA_CLOUD_PLATFORM_MCP_UPSTREAM_URL` is set to an HTTPS MCP endpoint,
 * requests are proxied there. Otherwise the Worker serves a local JSON-RPC MCP
 * surface for Cloud account, billing, app, agent, container, and admin tools.
 */

import { Hono } from "hono";

import { forwardMcpUpstreamRequest } from "@/lib/mcp/mcp-upstream-forward";
import {
  callPlatformCloudMcpTool,
  listPlatformCloudMcpTools,
} from "@/lib/mcp/platform-cloud-tools";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

const PLATFORM_UPSTREAM_ENV = "ELIZA_CLOUD_PLATFORM_MCP_UPSTREAM_URL";

const app = new Hono<AppEnv>();

function getPlatformUpstream(c: AppContext): string | null {
  const raw = c.env[PLATFORM_UPSTREAM_ENV];
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

function jsonRpcResult(id: unknown, result: unknown) {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    result,
  };
}

function jsonRpcError(id: unknown, code: number, message: string) {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message },
  };
}

async function handleJsonRpc(c: AppContext, message: unknown) {
  const request = message as {
    id?: unknown;
    method?: string;
    params?: {
      name?: string;
      arguments?: unknown;
    };
  };

  switch (request.method) {
    case "initialize":
      return jsonRpcResult(request.id, {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: {
          name: "eliza-cloud-platform",
          version: "1.0.0",
        },
      });
    case "ping":
      return jsonRpcResult(request.id, {});
    case "tools/list":
      return jsonRpcResult(request.id, {
        tools: listPlatformCloudMcpTools(),
      });
    case "tools/call": {
      const toolName = request.params?.name;
      if (!toolName) return jsonRpcError(request.id, -32602, "params.name is required");
      try {
        const result = await callPlatformCloudMcpTool(c, toolName, request.params?.arguments ?? {});
        return jsonRpcResult(request.id, result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return jsonRpcError(request.id, -32000, message);
      }
    }
    default:
      return jsonRpcError(request.id, -32601, `Unsupported MCP method: ${request.method}`);
  }
}

app.get("/", (c) =>
  getPlatformUpstream(c)
    ? forwardMcpUpstreamRequest(c.req.raw, getPlatformUpstream(c)!)
    : c.json({
        success: true,
        name: "eliza-cloud-platform",
        protocol: "mcp",
        transport: "streamable-http",
        tools: listPlatformCloudMcpTools().map((tool) => tool.name),
      }),
);

app.post("/", async (c) => {
  const upstream = getPlatformUpstream(c);
  if (upstream) {
    return forwardMcpUpstreamRequest(c.req.raw, upstream);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(jsonRpcError(null, -32700, "Invalid JSON"), 400);
  }

  const messages = Array.isArray(body) ? body : [body];
  const results = await Promise.all(messages.map((message) => handleJsonRpc(c, message)));
  return c.json(Array.isArray(body) ? results : results[0]);
});

app.all("*", (c) => {
  const upstream = getPlatformUpstream(c);
  if (upstream) return forwardMcpUpstreamRequest(c.req.raw, upstream);
  return c.json({ success: false, error: "MCP method/path not supported" }, 405);
});

export default app;
