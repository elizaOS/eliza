import { NextRequest, NextResponse } from "next/server";
import { requireAuthOrApiKey } from "@/lib/auth";
import { charactersService } from "@/lib/services/characters";
import { logger } from "@/lib/utils/logger";
import { z } from "zod";

export const dynamic = "force-dynamic";

// SECURITY FIX: Zod schemas for validation after JSON.parse
// Prevents malicious JSON with unexpected types or deeply nested structures

const McpServerConfigSchema = z.object({
  type: z.enum(["http", "sse", "streamable-http"]),
  // Accept either full URLs or pathnames (starting with /)
  // Pathnames will be expanded to full URLs at runtime
  url: z
    .string()
    .max(2048)
    .refine(
      (val) => {
        // Accept pathnames starting with /
        if (val.startsWith("/")) return true;
        // Accept full URLs
        try {
          new URL(val);
          return true;
        } catch {
          return false;
        }
      },
      { message: "Must be a valid URL or pathname starting with /" },
    ),
  timeout: z.number().int().min(0).max(300000).optional(), // Max 5 minutes
});

const McpSettingsSchema = z.object({
  servers: z
    .record(
      z.string().max(100), // Server ID max 100 chars
      McpServerConfigSchema,
    )
    .refine(
      (servers) => Object.keys(servers).length <= 50, // Max 50 servers
      { message: "Maximum 50 MCP servers allowed" },
    ),
  maxRetries: z.number().int().min(0).max(10).optional(),
});

import type { McpServerConfig, McpSettings } from "@/lib/types/mcp";

/**
 * SECURITY: Safe JSON parsing with depth and size limits
 * Prevents DoS attacks from deeply nested or large JSON structures
 */
function safeJsonParse(
  jsonString: string,
  maxDepth: number = 10,
  maxSize: number = 100000,
): unknown {
  // Check size limit (100KB default)
  if (jsonString.length > maxSize) {
    throw new Error(
      `JSON string too large: ${jsonString.length} bytes (max: ${maxSize})`,
    );
  }

  // Parse JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonString);
  } catch (error) {
    throw new Error(
      `Invalid JSON: ${error instanceof Error ? error.message : "Parse error"}`,
    );
  }

  // Check depth limit
  function checkDepth(obj: unknown, currentDepth: number = 0): void {
    if (currentDepth > maxDepth) {
      throw new Error(`JSON structure too deep: exceeds ${maxDepth} levels`);
    }

    if (obj && typeof obj === "object") {
      if (Array.isArray(obj)) {
        for (const item of obj) {
          checkDepth(item, currentDepth + 1);
        }
      } else {
        for (const value of Object.values(obj)) {
          checkDepth(value, currentDepth + 1);
        }
      }
    }
  }

  checkDepth(parsed);
  return parsed;
}

/**
 * Transform MCP settings by expanding pathname URLs to full URLs
 * Used when returning settings to the client for display/testing
 */
function transformMcpUrlsForDisplay(
  mcpSettings: McpSettings,
  request: NextRequest,
): McpSettings {
  if (!mcpSettings?.servers) {
    return mcpSettings;
  }

  const baseUrl =
    process.env.NEXT_PUBLIC_APP_URL ||
    (request.headers.get("host")
      ? `${request.headers.get("x-forwarded-proto") || "https"}://${request.headers.get("host")}`
      : "http://localhost:3000");

  const transformedServers: Record<string, McpServerConfig> = {};

  for (const [serverId, serverConfig] of Object.entries(mcpSettings.servers)) {
    transformedServers[serverId] = {
      ...serverConfig,
      // If URL starts with /, prepend baseUrl for display; otherwise use as-is
      url: serverConfig.url.startsWith("/")
        ? `${baseUrl}${serverConfig.url}`
        : serverConfig.url,
    };
  }

  return {
    ...mcpSettings,
    servers: transformedServers,
  };
}

/**
 * SECURITY: Parse and validate MCP settings
 * Combines safe parsing with Zod schema validation
 */
function parseMcpSettings(mcpSetting: unknown): McpSettings {
  let parsed: unknown;

  if (typeof mcpSetting === "string") {
    // Safe JSON parsing with limits
    parsed = safeJsonParse(mcpSetting, 10, 100000);
  } else if (typeof mcpSetting === "object" && mcpSetting !== null) {
    parsed = mcpSetting;
  } else {
    return { servers: {} };
  }

  // Validate with Zod schema
  const validationResult = McpSettingsSchema.safeParse(parsed);

  if (!validationResult.success) {
    throw new Error(
      `Invalid MCP settings structure: ${validationResult.error.issues.map((i) => i.message).join(", ")}`,
    );
  }

  return validationResult.data;
}

/**
 * GET /api/characters/[characterId]/mcps
 * Gets the current MCP server configuration for a character.
 *
 * @param request - The Next.js request object.
 * @param ctx - Route context containing the character ID parameter.
 * @returns MCP settings with server configurations and plugin status.
 */
export async function GET(
  request: NextRequest,
  ctx: { params: Promise<{ characterId: string }> },
) {
  try {
    const { user } = await requireAuthOrApiKey(request);
    const { characterId } = await ctx.params;

    // Get character
    const character = await charactersService.getById(characterId);

    if (!character) {
      return NextResponse.json(
        { error: "Character not found" },
        { status: 404 },
      );
    }

    // Check ownership
    if (
      character.user_id !== user.id &&
      character.organization_id !== user.organization_id
    ) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    }

    // Extract MCP settings from character settings
    const settings = character.settings || {};
    const mcpSetting = settings.mcp;

    let mcpSettings: McpSettings = { servers: {} };

    // SECURITY FIX: Use safe parsing with validation
    try {
      mcpSettings = parseMcpSettings(mcpSetting);
    } catch (error) {
      logger.warn(
        `[Characters/MCPs] Invalid MCP settings for character ${characterId}: ${error instanceof Error ? error.message : "Parse error"}`,
      );
      // Return empty settings on validation failure
      mcpSettings = { servers: {} };
    }

    // Check if plugin-mcp is enabled
    const plugins = character.plugins || [];
    const pluginMcpEnabled = plugins.includes("@elizaos/plugin-mcp");

    // Transform pathnames to full URLs for display/testing in the UI
    const mcpSettingsForDisplay = transformMcpUrlsForDisplay(
      mcpSettings,
      request,
    );

    return NextResponse.json({
      characterId,
      mcpSettings: mcpSettingsForDisplay,
      pluginMcpEnabled,
      enabledServers: Object.keys(mcpSettings.servers || {}),
      serverCount: Object.keys(mcpSettings.servers || {}).length,
    });
  } catch (error) {
    logger.error("[Characters/MCPs] Error getting MCP config:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to get MCP configuration",
      },
      { status: 500 },
    );
  }
}

/**
 * PUT /api/characters/[characterId]/mcps
 * Updates the complete MCP configuration for a character.
 * Invalidates character cache after update.
 *
 * @param request - Request body with mcpSettings and optional enablePlugin flag.
 * @param ctx - Route context containing the character ID parameter.
 * @returns Updated MCP settings and server list.
 */
export async function PUT(
  request: NextRequest,
  ctx: { params: Promise<{ characterId: string }> },
) {
  try {
    const { user } = await requireAuthOrApiKey(request);
    const { characterId } = await ctx.params;
    const body = await request.json();

    // SECURITY FIX: Validate request body with Zod schema
    const requestSchema = z.object({
      mcpSettings: McpSettingsSchema,
      enablePlugin: z.boolean().optional().default(true),
    });

    const validationResult = requestSchema.safeParse(body);

    if (!validationResult.success) {
      return NextResponse.json(
        {
          error: "Invalid request body",
          details: validationResult.error.issues.map((issue) => ({
            field: issue.path.join("."),
            message: issue.message,
          })),
        },
        { status: 400 },
      );
    }

    const { mcpSettings, enablePlugin } = validationResult.data;

    // Get character
    const character = await charactersService.getById(characterId);

    if (!character) {
      return NextResponse.json(
        { error: "Character not found" },
        { status: 404 },
      );
    }

    // Check ownership
    if (
      character.user_id !== user.id &&
      character.organization_id !== user.organization_id
    ) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    }

    // Build new settings
    const currentSettings = character.settings || {};
    const newSettings = {
      ...currentSettings,
      mcp: mcpSettings,
    };

    // Handle plugins array
    let newPlugins = character.plugins || [];
    const hasServers = Object.keys(mcpSettings.servers || {}).length > 0;

    if (enablePlugin && hasServers) {
      // Add plugin-mcp if not present
      if (!newPlugins.includes("@elizaos/plugin-mcp")) {
        newPlugins = [...newPlugins, "@elizaos/plugin-mcp"];
      }
    } else if (!hasServers) {
      // Remove plugin-mcp if no servers configured
      newPlugins = newPlugins.filter((p) => p !== "@elizaos/plugin-mcp");
    }

    // Update character
    const updatedCharacter = await charactersService.update(characterId, {
      settings: newSettings,
      plugins: newPlugins,
    });

    // CRITICAL FIX: Invalidate any cached character data
    // This ensures the next runtime creation will use fresh MCP settings
    try {
      const { invalidateCharacterCache } =
        await import("@/lib/cache/character-cache");
      await invalidateCharacterCache(characterId);
      logger.info(
        `[Characters/MCPs] Invalidated cache for character ${characterId}`,
      );
    } catch (cacheError) {
      // Don't fail the update if cache invalidation fails
      logger.warn(`[Characters/MCPs] Failed to invalidate cache:`, cacheError);
    }

    logger.info(
      `[Characters/MCPs] Updated MCP config for character ${characterId}: ${Object.keys(mcpSettings.servers || {}).length} servers`,
    );

    return NextResponse.json({
      success: true,
      characterId,
      mcpSettings,
      pluginMcpEnabled: newPlugins.includes("@elizaos/plugin-mcp"),
      enabledServers: Object.keys(mcpSettings.servers || {}),
      serverCount: Object.keys(mcpSettings.servers || {}).length,
    });
  } catch (error) {
    logger.error("[Characters/MCPs] Error updating MCP config:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to update MCP configuration",
      },
      { status: 500 },
    );
  }
}

/**
 * POST /api/characters/[characterId]/mcps
 * Adds a single MCP server to the character's configuration.
 * Automatically enables the plugin-mcp plugin if not already enabled.
 *
 * @param request - Request body with serverId and serverConfig.
 * @param ctx - Route context containing the character ID parameter.
 * @returns Updated MCP settings with the new server added.
 */
export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ characterId: string }> },
) {
  try {
    const { user } = await requireAuthOrApiKey(request);
    const { characterId } = await ctx.params;
    const body = await request.json();

    // SECURITY FIX: Validate request body with Zod schema
    const requestSchema = z.object({
      serverId: z.string().min(1).max(100),
      serverConfig: McpServerConfigSchema,
    });

    const validationResult = requestSchema.safeParse(body);

    if (!validationResult.success) {
      return NextResponse.json(
        {
          error: "Invalid request body",
          details: validationResult.error.issues.map((issue) => ({
            field: issue.path.join("."),
            message: issue.message,
          })),
        },
        { status: 400 },
      );
    }

    const { serverId, serverConfig } = validationResult.data;

    // Get character
    const character = await charactersService.getById(characterId);

    if (!character) {
      return NextResponse.json(
        { error: "Character not found" },
        { status: 404 },
      );
    }

    // Check ownership
    if (
      character.user_id !== user.id &&
      character.organization_id !== user.organization_id
    ) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    }

    // Get current MCP settings
    const currentSettings = character.settings || {};
    const mcpSetting = currentSettings.mcp;

    let mcpSettings: McpSettings = { servers: {} };

    // SECURITY FIX: Use safe parsing with validation
    try {
      mcpSettings = parseMcpSettings(mcpSetting);
    } catch (error) {
      logger.warn(
        `[Characters/MCPs] Could not parse existing MCP settings for character ${characterId}, starting fresh: ${error instanceof Error ? error.message : "Parse error"}`,
      );
      // Start fresh on validation failure
      mcpSettings = { servers: {} };
    }

    // Add the new server
    mcpSettings.servers = {
      ...mcpSettings.servers,
      [serverId]: serverConfig,
    };

    // Build new settings
    const newSettings = {
      ...currentSettings,
      mcp: mcpSettings,
    };

    // Ensure plugin-mcp is in plugins
    let newPlugins = character.plugins || [];
    if (!newPlugins.includes("@elizaos/plugin-mcp")) {
      newPlugins = [...newPlugins, "@elizaos/plugin-mcp"];
    }

    // Update character
    await charactersService.update(characterId, {
      settings: newSettings,
      plugins: newPlugins,
    });

    // CRITICAL FIX: Invalidate any cached character data
    try {
      const { invalidateCharacterCache } =
        await import("@/lib/cache/character-cache");
      await invalidateCharacterCache(characterId);
      logger.info(
        `[Characters/MCPs] Invalidated cache for character ${characterId}`,
      );
    } catch (cacheError) {
      logger.warn(`[Characters/MCPs] Failed to invalidate cache:`, cacheError);
    }

    logger.info(
      `[Characters/MCPs] Added MCP server ${serverId} to character ${characterId}`,
    );

    return NextResponse.json({
      success: true,
      characterId,
      serverId,
      mcpSettings,
      enabledServers: Object.keys(mcpSettings.servers || {}),
    });
  } catch (error) {
    logger.error("[Characters/MCPs] Error adding MCP server:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to add MCP server",
      },
      { status: 500 },
    );
  }
}

/**
 * DELETE /api/characters/[characterId]/mcps
 * Removes an MCP server from the character's configuration.
 * Removes plugin-mcp plugin if no servers remain.
 *
 * @param request - Request with serverId query parameter.
 * @param ctx - Route context containing the character ID parameter.
 * @returns Updated MCP settings with the server removed.
 */
export async function DELETE(
  request: NextRequest,
  ctx: { params: Promise<{ characterId: string }> },
) {
  try {
    const { user } = await requireAuthOrApiKey(request);
    const { characterId } = await ctx.params;

    // Get serverId from query params
    const serverId = request.nextUrl.searchParams.get("serverId");

    if (!serverId) {
      return NextResponse.json(
        { error: "Missing serverId query parameter" },
        { status: 400 },
      );
    }

    // Get character
    const character = await charactersService.getById(characterId);

    if (!character) {
      return NextResponse.json(
        { error: "Character not found" },
        { status: 404 },
      );
    }

    // Check ownership
    if (
      character.user_id !== user.id &&
      character.organization_id !== user.organization_id
    ) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    }

    // Get current MCP settings
    const currentSettings = character.settings || {};
    const mcpSetting = currentSettings.mcp;

    let mcpSettings: McpSettings = { servers: {} };

    // SECURITY FIX: Use safe parsing with validation
    try {
      mcpSettings = parseMcpSettings(mcpSetting);
    } catch (error) {
      logger.warn(
        `[Characters/MCPs] Could not parse MCP settings for character ${characterId} during deletion: ${error instanceof Error ? error.message : "Parse error"}`,
      );
      // Nothing to delete if settings are invalid
      return NextResponse.json({
        success: true,
        message: "Server not found (invalid settings)",
      });
    }

    // Remove the server
    if (mcpSettings.servers && mcpSettings.servers[serverId]) {
      delete mcpSettings.servers[serverId];
    }

    // Build new settings
    const newSettings = {
      ...currentSettings,
      mcp: mcpSettings,
    };

    // Remove plugin-mcp if no servers left
    let newPlugins = character.plugins || [];
    if (Object.keys(mcpSettings.servers || {}).length === 0) {
      newPlugins = newPlugins.filter((p) => p !== "@elizaos/plugin-mcp");
    }

    // Update character
    await charactersService.update(characterId, {
      settings: newSettings,
      plugins: newPlugins,
    });

    // CRITICAL FIX: Invalidate any cached character data
    try {
      const { invalidateCharacterCache } =
        await import("@/lib/cache/character-cache");
      await invalidateCharacterCache(characterId);
      logger.info(
        `[Characters/MCPs] Invalidated cache for character ${characterId}`,
      );
    } catch (cacheError) {
      logger.warn(`[Characters/MCPs] Failed to invalidate cache:`, cacheError);
    }

    logger.info(
      `[Characters/MCPs] Removed MCP server ${serverId} from character ${characterId}`,
    );

    return NextResponse.json({
      success: true,
      characterId,
      removedServerId: serverId,
      mcpSettings,
      enabledServers: Object.keys(mcpSettings.servers || {}),
    });
  } catch (error) {
    logger.error("[Characters/MCPs] Error removing MCP server:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to remove MCP server",
      },
      { status: 500 },
    );
  }
}
