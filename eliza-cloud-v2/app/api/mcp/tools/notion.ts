/**
 * Notion MCP Tools - Pages, Databases, Blocks
 * Uses per-organization OAuth tokens via oauthService.
 */

import type { McpServer } from "mcp-handler";
import { z } from "zod3";
import { logger } from "@/lib/utils/logger";
import { oauthService } from "@/lib/services/oauth";
import { getAuthContext } from "../lib/context";
import { jsonResponse, errorResponse } from "../lib/responses";

async function getNotionToken(): Promise<string> {
  const { user } = getAuthContext();
  try {
    const result = await oauthService.getValidTokenByPlatform({
      organizationId: user.organization_id,
      platform: "notion",
    });
    return result.accessToken;
  } catch (error) {
    logger.warn("[NotionMCP] Failed to get token", {
      organizationId: user.organization_id,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new Error("Notion account not connected. Connect in Settings > Connections.");
  }
}

async function notionFetch(endpoint: string, options: RequestInit = {}) {
  const token = await getNotionToken();
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

function errMsg(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function registerNotionTools(server: McpServer): void {
  server.registerTool(
    "notion_status",
    {
      description: "Check Notion OAuth connection status",
      inputSchema: {},
    },
    async () => {
      try {
        const { user } = getAuthContext();
        const connections = await oauthService.listConnections({
          organizationId: user.organization_id,
          platform: "notion",
        });
        const active = connections.find((c) => c.status === "active");
        if (!active) {
          return jsonResponse({
            connected: false,
            message: "Notion not connected. Connect in Settings > Connections.",
          });
        }
        return jsonResponse({
          connected: true,
          email: active.email,
          scopes: active.scopes,
          linkedAt: active.linkedAt,
        });
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to check status"));
      }
    },
  );

  server.registerTool(
    "notion_search",
    {
      description: "Search pages and data sources",
      inputSchema: {
        query: z.string().optional(),
        filter: z.record(z.any()).optional(),
        sort: z.record(z.any()).optional(),
        start_cursor: z.string().optional(),
        page_size: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ query, filter, sort, start_cursor, page_size }) => {
      try {
        const data = await notionFetch("/v1/search", {
          method: "POST",
          body: JSON.stringify({ query, filter, sort, start_cursor, page_size }),
        });
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to search"));
      }
    },
  );

  server.registerTool(
    "notion_get_page",
    {
      description: "Get page",
      inputSchema: {
        id: z.string().min(1),
      },
    },
    async ({ id }) => {
      try {
        const data = await notionFetch(`/v1/pages/${id}`);
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to get page"));
      }
    },
  );

  server.registerTool(
    "notion_create_page",
    {
      description: "Create page",
      inputSchema: {
        body: z.record(z.any()),
      },
    },
    async ({ body }) => {
      try {
        const data = await notionFetch("/v1/pages", { method: "POST", body: JSON.stringify(body) });
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to create page"));
      }
    },
  );

  server.registerTool(
    "notion_update_page",
    {
      description: "Update page properties",
      inputSchema: {
        id: z.string().min(1),
        body: z.record(z.any()),
      },
    },
    async ({ id, body }) => {
      try {
        const data = await notionFetch(`/v1/pages/${id}`, { method: "PATCH", body: JSON.stringify(body) });
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to update page"));
      }
    },
  );

  server.registerTool(
    "notion_archive_page",
    {
      description: "Archive or restore page",
      inputSchema: {
        id: z.string().min(1),
        archived: z.boolean(),
      },
    },
    async ({ id, archived }) => {
      try {
        const data = await notionFetch(`/v1/pages/${id}`, { method: "PATCH", body: JSON.stringify({ archived }) });
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to archive page"));
      }
    },
  );

  server.registerTool(
    "notion_get_block",
    {
      description: "Get block",
      inputSchema: {
        id: z.string().min(1),
      },
    },
    async ({ id }) => {
      try {
        const data = await notionFetch(`/v1/blocks/${id}`);
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to get block"));
      }
    },
  );

  server.registerTool(
    "notion_get_block_children",
    {
      description: "Get block children",
      inputSchema: {
        id: z.string().min(1),
        start_cursor: z.string().optional(),
        page_size: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ id, start_cursor, page_size }) => {
      try {
        const params = new URLSearchParams();
        if (start_cursor) params.set("start_cursor", start_cursor);
        if (page_size) params.set("page_size", String(page_size));
        const suffix = params.toString() ? `?${params.toString()}` : "";
        const data = await notionFetch(`/v1/blocks/${id}/children${suffix}`);
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to get block children"));
      }
    },
  );

  server.registerTool(
    "notion_append_blocks",
    {
      description: "Append blocks to a block",
      inputSchema: {
        id: z.string().min(1),
        body: z.record(z.any()),
      },
    },
    async ({ id, body }) => {
      try {
        const data = await notionFetch(`/v1/blocks/${id}/children`, { method: "PATCH", body: JSON.stringify(body) });
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to append blocks"));
      }
    },
  );

  server.registerTool(
    "notion_update_block",
    {
      description: "Update block",
      inputSchema: {
        id: z.string().min(1),
        body: z.record(z.any()),
      },
    },
    async ({ id, body }) => {
      try {
        const data = await notionFetch(`/v1/blocks/${id}`, { method: "PATCH", body: JSON.stringify(body) });
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to update block"));
      }
    },
  );

  server.registerTool(
    "notion_delete_block",
    {
      description: "Delete block",
      inputSchema: {
        id: z.string().min(1),
      },
    },
    async ({ id }) => {
      try {
        const data = await notionFetch(`/v1/blocks/${id}`, { method: "DELETE" });
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to delete block"));
      }
    },
  );

  server.registerTool(
    "notion_get_database",
    {
      description: "Get database info",
      inputSchema: {
        id: z.string().min(1),
      },
    },
    async ({ id }) => {
      try {
        const data = await notionFetch(`/v1/databases/${id}`);
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to get database"));
      }
    },
  );

  server.registerTool(
    "notion_create_database",
    {
      description: "Create database",
      inputSchema: {
        body: z.record(z.any()),
      },
    },
    async ({ body }) => {
      try {
        const data = await notionFetch("/v1/databases", { method: "POST", body: JSON.stringify(body) });
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to create database"));
      }
    },
  );

  server.registerTool(
    "notion_update_database",
    {
      description: "Update database",
      inputSchema: {
        id: z.string().min(1),
        body: z.record(z.any()),
      },
    },
    async ({ id, body }) => {
      try {
        const data = await notionFetch(`/v1/databases/${id}`, { method: "PATCH", body: JSON.stringify(body) });
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to update database"));
      }
    },
  );

  server.registerTool(
    "notion_get_data_source",
    {
      description: "Get data source schema",
      inputSchema: {
        id: z.string().min(1),
      },
    },
    async ({ id }) => {
      try {
        const data = await notionFetch(`/v1/data_sources/${id}`);
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to get data source"));
      }
    },
  );

  server.registerTool(
    "notion_query_data_source",
    {
      description: "Query data source",
      inputSchema: {
        id: z.string().min(1),
        body: z.record(z.any()).optional(),
      },
    },
    async ({ id, body }) => {
      try {
        const data = await notionFetch(`/v1/data_sources/${id}/query`, {
          method: "POST",
          body: JSON.stringify(body || {}),
        });
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to query data source"));
      }
    },
  );

  server.registerTool(
    "notion_update_data_source",
    {
      description: "Update data source properties",
      inputSchema: {
        id: z.string().min(1),
        body: z.record(z.any()),
      },
    },
    async ({ id, body }) => {
      try {
        const data = await notionFetch(`/v1/data_sources/${id}/properties`, {
          method: "PATCH",
          body: JSON.stringify(body),
        });
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to update data source"));
      }
    },
  );

  server.registerTool(
    "notion_list_users",
    {
      description: "List workspace users",
      inputSchema: {
        start_cursor: z.string().optional(),
        page_size: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ start_cursor, page_size }) => {
      try {
        const params = new URLSearchParams();
        if (start_cursor) params.set("start_cursor", start_cursor);
        if (page_size) params.set("page_size", String(page_size));
        const suffix = params.toString() ? `?${params.toString()}` : "";
        const data = await notionFetch(`/v1/users${suffix}`);
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to list users"));
      }
    },
  );

  server.registerTool(
    "notion_get_user",
    {
      description: "Get user",
      inputSchema: {
        id: z.string().min(1),
      },
    },
    async ({ id }) => {
      try {
        const data = await notionFetch(`/v1/users/${id}`);
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to get user"));
      }
    },
  );

  server.registerTool(
    "notion_list_comments",
    {
      description: "List comments",
      inputSchema: {
        block_id: z.string().min(1),
        start_cursor: z.string().optional(),
        page_size: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ block_id, start_cursor, page_size }) => {
      try {
        const params = new URLSearchParams({ block_id });
        if (start_cursor) params.set("start_cursor", start_cursor);
        if (page_size) params.set("page_size", String(page_size));
        const data = await notionFetch(`/v1/comments?${params.toString()}`);
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to list comments"));
      }
    },
  );

  server.registerTool(
    "notion_create_comment",
    {
      description: "Create comment",
      inputSchema: {
        body: z.record(z.any()),
      },
    },
    async ({ body }) => {
      try {
        const data = await notionFetch("/v1/comments", { method: "POST", body: JSON.stringify(body) });
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to create comment"));
      }
    },
  );
}
