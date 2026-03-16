/**
 * API Keys MCP tools
 * Tools for managing organization API keys
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod3";
import { apiKeysService } from "@/lib/services/api-keys";
import { getAuthContext } from "../lib/context";
import { jsonResponse, errorResponse } from "../lib/responses";

export function registerApiKeyTools(server: McpServer): void {
  // List API Keys
  server.registerTool(
    "list_api_keys",
    {
      description: "List all API keys. FREE tool.",
      inputSchema: {},
    },
    async () => {
      try {
        const { user } = getAuthContext();
        const keys = await apiKeysService.listByOrganization(
          user.organization_id,
        );

        return jsonResponse({
          success: true,
          apiKeys: keys.map((k) => ({
            id: k.id,
            name: k.name,
            keyPrefix: k.key_prefix,
            isActive: k.is_active,
            createdAt: k.created_at,
          })),
        });
      } catch (error) {
        return errorResponse(
          error instanceof Error ? error.message : "Failed to list API keys",
        );
      }
    },
  );

  // Create API Key
  server.registerTool(
    "create_api_key",
    {
      description:
        "Create a new API key. FREE tool. Returns plain key only once!",
      inputSchema: {
        name: z.string().describe("API key name (required)"),
        description: z.string().optional().describe("Description"),
        rateLimit: z.number().optional().describe("Rate limit per minute"),
      },
    },
    async ({ name, description, rateLimit }) => {
      try {
        if (!name || name.trim().length === 0) {
          throw new Error("API key name is required");
        }
        const effectiveRateLimit = rateLimit ?? 1000;
        const { user } = getAuthContext();

        const { apiKey, plainKey } = await apiKeysService.create({
          name,
          description: description || null,
          organization_id: user.organization_id,
          user_id: user.id,
          permissions: [],
          rate_limit: effectiveRateLimit,
          expires_at: null,
          is_active: true,
        });

        return jsonResponse({
          success: true,
          apiKey: {
            id: apiKey.id,
            name: apiKey.name,
            keyPrefix: apiKey.key_prefix,
          },
          plainKey, // IMPORTANT: Only shown once!
          warning: "Store this key securely - it will not be shown again!",
        });
      } catch (error) {
        return errorResponse(
          error instanceof Error ? error.message : "Failed to create API key",
        );
      }
    },
  );

  // Delete API Key
  server.registerTool(
    "delete_api_key",
    {
      description: "Delete an API key. FREE tool.",
      inputSchema: {
        apiKeyId: z.string().uuid().describe("API key ID to delete"),
      },
    },
    async ({ apiKeyId }) => {
      try {
        const { user } = getAuthContext();

        // Verify ownership before deletion to prevent IDOR
        const existingKey = await apiKeysService.getById(apiKeyId);
        if (!existingKey) {
          throw new Error("API key not found");
        }
        if (existingKey.organization_id !== user.organization_id) {
          throw new Error("API key not found");
        }

        await apiKeysService.delete(apiKeyId);

        return jsonResponse({ success: true, apiKeyId });
      } catch (error) {
        return errorResponse(
          error instanceof Error ? error.message : "Failed to delete API key",
        );
      }
    },
  );
}
