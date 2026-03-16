/**
 * User profile tools
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod3";
import { usersService } from "@/lib/services/users";
import { getAuthContext } from "../lib/context";
import { jsonResponse, errorResponse } from "../lib/responses";

export function registerUserTools(server: McpServer): void {
  server.registerTool(
    "get_user_profile",
    {
      description: "Get current user profile. FREE tool.",
      inputSchema: {},
    },
    async () => {
      try {
        const { user } = getAuthContext();

        return jsonResponse({
          success: true,
          user: {
            id: user.id,
            email: user.email,
            name: user.name,
            organizationId: user.organization_id,
            creditBalance: user.organization.credit_balance,
          },
        });
      } catch (error) {
        return errorResponse(
          error instanceof Error ? error.message : "Failed to get user profile",
        );
      }
    },
  );

  server.registerTool(
    "update_user_profile",
    {
      description: "Update user profile. FREE tool.",
      inputSchema: {
        name: z
          .string()
          .min(1)
          .max(100)
          .optional()
          .describe("New display name"),
      },
    },
    async ({ name }) => {
      try {
        const { user } = getAuthContext();
        if (name) {
          await usersService.update(user.id, { name });
        }
        return jsonResponse({ success: true });
      } catch (error) {
        return errorResponse(
          error instanceof Error ? error.message : "Failed to update profile",
        );
      }
    },
  );
}
