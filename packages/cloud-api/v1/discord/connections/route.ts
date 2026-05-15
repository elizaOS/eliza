/**
 * Discord Connections API
 *
 * Manages Discord bot connections for the gateway service.
 * Connections link a Discord bot to a character for AI responses.
 */

import { Hono } from "hono";
import { z } from "zod";
import { discordConnectionsRepository, userCharactersRepository } from "@/db/repositories";
import {
  DISCORD_DEFAULT_INTENTS,
  DiscordConnectionMetadataSchema,
} from "@/db/schemas/discord-connections";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

const CreateConnectionSchema = z.object({
  // Discord bot credentials from Discord Developer Portal
  applicationId: z.string().min(1, "Application ID is required"),
  botToken: z.string().min(1, "Bot token is required"),

  // Character to use for AI responses (required - bot won't respond without it)
  characterId: z.string().uuid("Character ID must be a valid UUID"),

  // Discord gateway intents (optional, uses secure defaults)
  intents: z.number().int().positive().optional(),

  // Response behavior configuration
  metadata: DiscordConnectionMetadataSchema,
});

/**
 * GET /api/v1/discord/connections
 * Lists all Discord connections for the authenticated user's organization.
 */
app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);

    const connections = await discordConnectionsRepository.findByOrganizationId(
      user.organization_id,
    );

    // Return connections without sensitive token data
    return c.json({
      success: true,
      connections: connections.map((conn) => ({
        id: conn.id,
        applicationId: conn.application_id,
        botUserId: conn.bot_user_id,
        characterId: conn.character_id,
        status: conn.status,
        errorMessage: conn.error_message,
        assignedPod: conn.assigned_pod,
        guildCount: conn.guild_count,
        eventsReceived: conn.events_received,
        eventsRouted: conn.events_routed,
        isActive: conn.is_active,
        metadata: conn.metadata,
        connectedAt: conn.connected_at,
        lastHeartbeat: conn.last_heartbeat,
        createdAt: conn.created_at,
        updatedAt: conn.updated_at,
      })),
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

/**
 * POST /api/v1/discord/connections
 * Creates a new Discord bot connection.
 *
 * Required: applicationId, botToken (from Discord Developer Portal),
 * characterId (links to a character for AI responses)
 */
app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ success: false, error: "Invalid JSON body" }, 400);
    }

    const validation = CreateConnectionSchema.safeParse(body);
    if (!validation.success) {
      return c.json(
        {
          success: false,
          error: "Invalid request data",
          details: validation.error.format(),
        },
        400,
      );
    }

    const data = validation.data;

    // Verify character exists and belongs to the organization
    const character = await userCharactersRepository.findById(data.characterId);
    if (!character) {
      return c.json({ success: false, error: "Character not found" }, 404);
    }
    if (character.organization_id !== user.organization_id) {
      return c.json(
        {
          success: false,
          error: "Character does not belong to your organization",
        },
        403,
      );
    }

    // Create connection - rely on database unique constraint to prevent duplicates
    let connection;
    try {
      connection = await discordConnectionsRepository.create({
        organizationId: user.organization_id,
        characterId: data.characterId,
        applicationId: data.applicationId,
        botToken: data.botToken,
        intents: data.intents ?? DISCORD_DEFAULT_INTENTS,
        metadata: data.metadata,
      });
    } catch (error) {
      // Handle PostgreSQL unique constraint violation (discord_connections_org_app_unique_idx)
      const isUniqueViolation =
        error instanceof Error && "code" in error && (error as { code: string }).code === "23505";

      if (isUniqueViolation) {
        // Fetch existing connection to provide helpful response
        const existing = await discordConnectionsRepository.findByApplicationId(
          user.organization_id,
          data.applicationId,
        );
        return c.json(
          {
            success: false,
            error: "A connection already exists for this Discord application",
            existingConnectionId: existing?.id,
          },
          409,
        );
      }
      throw error;
    }

    logger.info("[Discord Connections] Created connection", {
      connectionId: connection.id,
      applicationId: connection.application_id,
      characterId: connection.character_id,
      organizationId: user.organization_id,
      userId: user.id,
    });

    return c.json({
      success: true,
      connection: {
        id: connection.id,
        applicationId: connection.application_id,
        characterId: connection.character_id,
        status: connection.status,
        isActive: connection.is_active,
        metadata: connection.metadata,
        createdAt: connection.created_at,
      },
      message: "Connection created. The gateway will pick it up within 30 seconds.",
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
