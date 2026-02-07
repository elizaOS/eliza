/**
 * Notion MCP Server - Pages, Databases, Blocks
 *
 * Standalone MCP endpoint for Notion tools with per-org OAuth.
 * Config: { "type": "streamable-http", "url": "/api/mcps/notion/streamable-http" }
 */

import type { NextRequest } from "next/server";
import { logger } from "@/lib/utils/logger";
import { oauthService } from "@/lib/services/oauth";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { authContextStorage } from "@/app/api/mcp/lib/context";
import { checkRateLimitRedis } from "@/lib/middleware/rate-limit-redis";

export const maxDuration = 60;

interface McpHandlerResponse {
  status: number;
  headers?: Headers;
  text?: () => Promise<string>;
}

function isMcpHandlerResponse(resp: unknown): resp is McpHandlerResponse {
  return typeof resp === "object" && resp !== null && typeof (resp as McpHandlerResponse).status === "number";
}

let mcpHandler: ((req: Request) => Promise<Response>) | null = null;

async function getNotionMcpHandler() {
  if (mcpHandler) return mcpHandler;

  const { createMcpHandler } = await import("mcp-handler");
  const { z } = await import("zod3");

  async function getNotionToken(organizationId: string): Promise<string> {
    const result = await oauthService.getValidTokenByPlatform({ organizationId, platform: "notion" });
    return result.accessToken;
  }

  async function notionFetch(orgId: string, endpoint: string, options: RequestInit = {}) {
    const token = await getNotionToken(orgId);
    const response = await fetch(`https://api.notion.com${endpoint}`, {
      ...options,
      headers: {
        ...options.headers,
        Authorization: `Bearer ${token}`,
        "Notion-Version": "2025-09-03",
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.message || `Notion API error: ${response.status}`);
    }

    if (response.status === 204) return {};
    const text = await response.text();
    if (!text) return {};
    return JSON.parse(text);
  }

  function getOrgId(): string {
    const ctx = authContextStorage.getStore();
    if (!ctx) throw new Error("Not authenticated");
    return ctx.user.organization_id;
  }

  function jsonResult(data: object) {
    return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
  }

  function errorResult(msg: string) {
    return { content: [{ type: "text" as const, text: JSON.stringify({ error: msg }) }], isError: true };
  }

  mcpHandler = createMcpHandler(
    (server) => {
      server.tool("notion_status", "Check Notion OAuth connection status", {}, async () => {
        try {
          const orgId = getOrgId();
          const connections = await oauthService.listConnections({ organizationId: orgId, platform: "notion" });
          const active = connections.find((c) => c.status === "active");
          if (!active) return jsonResult({ connected: false });
          return jsonResult({ connected: true, email: active.email, scopes: active.scopes });
        } catch (e) {
          return errorResult(e instanceof Error ? e.message : "Failed");
        }
      });

      server.tool(
        "notion_search",
        "Search pages and data sources",
        {
          query: z.string().optional(),
          filter: z.record(z.any()).optional(),
          sort: z.record(z.any()).optional(),
          start_cursor: z.string().optional(),
          page_size: z.number().int().min(1).max(100).optional(),
        },
        async ({ query, filter, sort, start_cursor, page_size }) => {
          try {
            const orgId = getOrgId();
            const data = await notionFetch(orgId, "/v1/search", {
              method: "POST",
              body: JSON.stringify({ query, filter, sort, start_cursor, page_size }),
            });
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );

      server.tool(
        "notion_get_page",
        "Get page by ID",
        { id: z.string().min(1) },
        async ({ id }) => {
          try {
            const orgId = getOrgId();
            const data = await notionFetch(orgId, `/v1/pages/${id}`);
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );

      server.tool(
        "notion_create_page",
        "Create page",
        { body: z.record(z.any()) },
        async ({ body }) => {
          try {
            const orgId = getOrgId();
            const data = await notionFetch(orgId, "/v1/pages", { method: "POST", body: JSON.stringify(body) });
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );

      server.tool(
        "notion_update_page",
        "Update page properties",
        { id: z.string().min(1), body: z.record(z.any()) },
        async ({ id, body }) => {
          try {
            const orgId = getOrgId();
            const data = await notionFetch(orgId, `/v1/pages/${id}`, { method: "PATCH", body: JSON.stringify(body) });
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );

      server.tool(
        "notion_archive_page",
        "Archive or restore page",
        { id: z.string().min(1), archived: z.boolean() },
        async ({ id, archived }) => {
          try {
            const orgId = getOrgId();
            const data = await notionFetch(orgId, `/v1/pages/${id}`, {
              method: "PATCH",
              body: JSON.stringify({ archived }),
            });
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );

      server.tool(
        "notion_get_block",
        "Get block by ID",
        { id: z.string().min(1) },
        async ({ id }) => {
          try {
            const orgId = getOrgId();
            const data = await notionFetch(orgId, `/v1/blocks/${id}`);
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );

      server.tool(
        "notion_get_block_children",
        "Get block children",
        {
          id: z.string().min(1),
          start_cursor: z.string().optional(),
          page_size: z.number().int().min(1).max(100).optional(),
        },
        async ({ id, start_cursor, page_size }) => {
          try {
            const orgId = getOrgId();
            const params = new URLSearchParams();
            if (start_cursor) params.set("start_cursor", start_cursor);
            if (page_size) params.set("page_size", String(page_size));
            const suffix = params.toString() ? `?${params.toString()}` : "";
            const data = await notionFetch(orgId, `/v1/blocks/${id}/children${suffix}`);
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );

      server.tool(
        "notion_append_blocks",
        "Append blocks to a block",
        { id: z.string().min(1), body: z.record(z.any()) },
        async ({ id, body }) => {
          try {
            const orgId = getOrgId();
            const data = await notionFetch(orgId, `/v1/blocks/${id}/children`, {
              method: "PATCH",
              body: JSON.stringify(body),
            });
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );

      server.tool(
        "notion_update_block",
        "Update block",
        { id: z.string().min(1), body: z.record(z.any()) },
        async ({ id, body }) => {
          try {
            const orgId = getOrgId();
            const data = await notionFetch(orgId, `/v1/blocks/${id}`, {
              method: "PATCH",
              body: JSON.stringify(body),
            });
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );

      server.tool(
        "notion_delete_block",
        "Delete block",
        { id: z.string().min(1) },
        async ({ id }) => {
          try {
            const orgId = getOrgId();
            const data = await notionFetch(orgId, `/v1/blocks/${id}`, { method: "DELETE" });
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );

      server.tool(
        "notion_get_database",
        "Get database",
        { id: z.string().min(1) },
        async ({ id }) => {
          try {
            const orgId = getOrgId();
            const data = await notionFetch(orgId, `/v1/databases/${id}`);
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );

      server.tool(
        "notion_create_database",
        "Create database",
        { body: z.record(z.any()) },
        async ({ body }) => {
          try {
            const orgId = getOrgId();
            const data = await notionFetch(orgId, "/v1/databases", { method: "POST", body: JSON.stringify(body) });
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );

      server.tool(
        "notion_update_database",
        "Update database",
        { id: z.string().min(1), body: z.record(z.any()) },
        async ({ id, body }) => {
          try {
            const orgId = getOrgId();
            const data = await notionFetch(orgId, `/v1/databases/${id}`, { method: "PATCH", body: JSON.stringify(body) });
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );

      server.tool(
        "notion_get_data_source",
        "Get data source schema",
        { id: z.string().min(1) },
        async ({ id }) => {
          try {
            const orgId = getOrgId();
            const data = await notionFetch(orgId, `/v1/data_sources/${id}`);
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );

      server.tool(
        "notion_query_data_source",
        "Query data source",
        { id: z.string().min(1), body: z.record(z.any()).optional() },
        async ({ id, body }) => {
          try {
            const orgId = getOrgId();
            const data = await notionFetch(orgId, `/v1/data_sources/${id}/query`, {
              method: "POST",
              body: JSON.stringify(body || {}),
            });
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );

      server.tool(
        "notion_update_data_source",
        "Update data source properties",
        { id: z.string().min(1), body: z.record(z.any()) },
        async ({ id, body }) => {
          try {
            const orgId = getOrgId();
            const data = await notionFetch(orgId, `/v1/data_sources/${id}/properties`, {
              method: "PATCH",
              body: JSON.stringify(body),
            });
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );

      server.tool(
        "notion_list_users",
        "List workspace users",
        { start_cursor: z.string().optional(), page_size: z.number().int().min(1).max(100).optional() },
        async ({ start_cursor, page_size }) => {
          try {
            const orgId = getOrgId();
            const params = new URLSearchParams();
            if (start_cursor) params.set("start_cursor", start_cursor);
            if (page_size) params.set("page_size", String(page_size));
            const suffix = params.toString() ? `?${params.toString()}` : "";
            const data = await notionFetch(orgId, `/v1/users${suffix}`);
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );

      server.tool(
        "notion_get_user",
        "Get user by ID",
        { id: z.string().min(1) },
        async ({ id }) => {
          try {
            const orgId = getOrgId();
            const data = await notionFetch(orgId, `/v1/users/${id}`);
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );

      server.tool(
        "notion_list_comments",
        "List comments for a block",
        { block_id: z.string().min(1), start_cursor: z.string().optional(), page_size: z.number().int().min(1).max(100).optional() },
        async ({ block_id, start_cursor, page_size }) => {
          try {
            const orgId = getOrgId();
            const params = new URLSearchParams({ block_id });
            if (start_cursor) params.set("start_cursor", start_cursor);
            if (page_size) params.set("page_size", String(page_size));
            const data = await notionFetch(orgId, `/v1/comments?${params.toString()}`);
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );

      server.tool(
        "notion_create_comment",
        "Create comment",
        { body: z.record(z.any()) },
        async ({ body }) => {
          try {
            const orgId = getOrgId();
            const data = await notionFetch(orgId, "/v1/comments", { method: "POST", body: JSON.stringify(body) });
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );
    },
    { capabilities: { tools: {} } },
    { basePath: "/api/mcps/notion", maxDuration: 60 },
  );

  return mcpHandler;
}

async function handleRequest(req: NextRequest): Promise<Response> {
  try {
    const authResult = await requireAuthOrApiKeyWithOrg(req);

    const rateLimitKey = `mcp:ratelimit:notion:${authResult.user.organization_id}`;
    const rateLimit = await checkRateLimitRedis(rateLimitKey, 60000, 100);
    if (!rateLimit.allowed) {
      return new Response(JSON.stringify({ error: "rate_limit_exceeded" }), { status: 429, headers: { "Content-Type": "application/json" } });
    }

    const handler = await getNotionMcpHandler();
    const mcpResponse = await authContextStorage.run(authResult, () => handler(req as Request));

    if (!mcpResponse || !isMcpHandlerResponse(mcpResponse)) {
      return new Response(JSON.stringify({ error: "invalid_response" }), { status: 500, headers: { "Content-Type": "application/json" } });
    }

    const bodyText = mcpResponse.text ? await mcpResponse.text() : "";
    const headers: Record<string, string> = {};
    mcpResponse.headers?.forEach((v: string, k: string) => { headers[k] = v; });

    return new Response(bodyText, { status: mcpResponse.status, headers });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    logger.error(`[NotionMCP] ${msg}`);
    const isAuth = msg.includes("API key") || msg.includes("auth") || msg.includes("Unauthorized");
    return new Response(JSON.stringify({ error: isAuth ? "authentication_required" : "internal_error", message: msg }), { status: isAuth ? 401 : 500, headers: { "Content-Type": "application/json" } });
  }
}

export const GET = handleRequest;
export const POST = handleRequest;
export const DELETE = handleRequest;
