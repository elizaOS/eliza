/**
 * Discord Connections API
 *
 * Manages Discord bot connections for the gateway service.
 * Connections link a Discord bot to a character for AI responses.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import {
  discordConnectionsRepository,
  userCharactersRepository,
} from "@/db/repositories";
import {
  DiscordConnectionMetadataSchema,
  DISCORD_DEFAULT_INTENTS,
} from "@/db/schemas/discord-connections";
import { logger } from "@/lib/utils/logger";
import { z } from "zod";

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
export async function GET(request: NextRequest): Promise<NextResponse> {
  const { user } = await requireAuthOrApiKeyWithOrg(request);

  const connections = await discordConnectionsRepository.findByOrganizationId(
    user.organization_id,
  );

  // Return connections without sensitive token data
  return NextResponse.json({
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
}

/**
 * POST /api/v1/discord/connections
 * Creates a new Discord bot connection.
 *
 * Required: applicationId, botToken (from Discord Developer Portal), 
 * characterId (links to a character for AI responses)
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const { user } = await requireAuthOrApiKeyWithOrg(request);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const validation = CreateConnectionSchema.safeParse(body);
  if (!validation.success) {
    return NextResponse.json(
      {
        success: false,
        error: "Invalid request data",
        details: validation.error.format(),
      },
      { status: 400 },
    );
  }

  const data = validation.data;

  // Verify character exists and belongs to the organization
  const character = await userCharactersRepository.findById(data.characterId);
  if (!character) {
    return NextResponse.json(
      { success: false, error: "Character not found" },
      { status: 404 },
    );
  }
  if (character.organization_id !== user.organization_id) {
    return NextResponse.json(
      {
        success: false,
        error: "Character does not belong to your organization",
      },
      { status: 403 },
    );
  }

  // Create connection - rely on database unique constraint to prevent duplicates
  // This avoids TOCTOU race where two requests could pass the "check if exists"
  // step before either creates the connection
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
      error instanceof Error &&
      "code" in error &&
      (error as { code: string }).code === "23505";

    if (isUniqueViolation) {
      // Fetch existing connection to provide helpful response
      const existing = await discordConnectionsRepository.findByApplicationId(
        user.organization_id,
        data.applicationId,
      );
      return NextResponse.json(
        {
          success: false,
          error: "A connection already exists for this Discord application",
          existingConnectionId: existing?.id,
        },
        { status: 409 },
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

  return NextResponse.json({
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
    message:
      "Connection created. The gateway will pick it up within 30 seconds.",
  });
}
