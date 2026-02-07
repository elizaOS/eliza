/**
 * Discord Connection by ID API
 *
 * Manages individual Discord bot connections.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import {
  discordConnectionsRepository,
  userCharactersRepository,
} from "@/db/repositories";
import { DiscordConnectionMetadataSchema } from "@/db/schemas/discord-connections";
import { logger } from "@/lib/utils/logger";
import { z } from "zod";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const UpdateConnectionSchema = z.object({
  // Character to use for responses
  characterId: z.string().uuid().nullable().optional(),

  // Bot token (re-encrypt if changed)
  botToken: z.string().min(1).optional(),

  // Whether the connection is active
  isActive: z.boolean().optional(),

  // Response behavior configuration
  metadata: DiscordConnectionMetadataSchema,
});

/**
 * GET /api/v1/discord/connections/[id]
 * Get a single Discord connection by ID.
 */
export async function GET(
  request: NextRequest,
  context: RouteContext,
): Promise<NextResponse> {
  const { user } = await requireAuthOrApiKeyWithOrg(request);
  const { id } = await context.params;

  const connection = await discordConnectionsRepository.findById(id);

  if (!connection) {
    return NextResponse.json(
      { success: false, error: "Connection not found" },
      { status: 404 },
    );
  }

  if (connection.organization_id !== user.organization_id) {
    return NextResponse.json(
      { success: false, error: "Connection not found" },
      { status: 404 },
    );
  }

  return NextResponse.json({
    success: true,
    connection: {
      id: connection.id,
      applicationId: connection.application_id,
      botUserId: connection.bot_user_id,
      characterId: connection.character_id,
      status: connection.status,
      errorMessage: connection.error_message,
      assignedPod: connection.assigned_pod,
      guildCount: connection.guild_count,
      eventsReceived: connection.events_received,
      eventsRouted: connection.events_routed,
      isActive: connection.is_active,
      metadata: connection.metadata,
      connectedAt: connection.connected_at,
      lastHeartbeat: connection.last_heartbeat,
      createdAt: connection.created_at,
      updatedAt: connection.updated_at,
    },
  });
}

/**
 * PATCH /api/v1/discord/connections/[id]
 * Update a Discord connection (character, metadata, active status).
 */
export async function PATCH(
  request: NextRequest,
  context: RouteContext,
): Promise<NextResponse> {
  const { user } = await requireAuthOrApiKeyWithOrg(request);
  const { id } = await context.params;

  const connection = await discordConnectionsRepository.findById(id);

  if (!connection) {
    return NextResponse.json(
      { success: false, error: "Connection not found" },
      { status: 404 },
    );
  }

  if (connection.organization_id !== user.organization_id) {
    return NextResponse.json(
      { success: false, error: "Connection not found" },
      { status: 404 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const validation = UpdateConnectionSchema.safeParse(body);
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

  // Verify character exists and belongs to the organization (if provided)
  if (data.characterId) {
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
  }

  // Handle bot token update separately (requires re-encryption)
  if (data.botToken) {
    await discordConnectionsRepository.updateBotToken(id, data.botToken);
    // Force reconnection by clearing pod assignment
    await discordConnectionsRepository.update(id, {
      assigned_pod: null,
      status: "pending",
      updated_at: new Date(),
    });
  }

  // Build update object for other fields
  const updates: Record<string, unknown> = {
    updated_at: new Date(),
  };

  if (data.characterId !== undefined) {
    updates.character_id = data.characterId;
  }

  if (data.isActive !== undefined) {
    updates.is_active = data.isActive;
    // If deactivating, clear pod assignment so it disconnects
    if (!data.isActive) {
      updates.assigned_pod = null;
      updates.status = "disconnected";
    }
  }

  if (data.metadata !== undefined) {
    updates.metadata = data.metadata;
  }

  // Only call update if there are non-token fields to update
  let updated = connection;
  if (Object.keys(updates).length > 1) {
    updated = await discordConnectionsRepository.update(id, updates);
  } else if (data.botToken) {
    // Re-fetch if only token was updated
    updated = (await discordConnectionsRepository.findById(id))!;
  }

  logger.info("[Discord Connections] Updated connection", {
    connectionId: id,
    updates: Object.keys(data),
    organizationId: user.organization_id,
    userId: user.id,
  });

  return NextResponse.json({
    success: true,
    connection: {
      id: updated.id,
      applicationId: updated.application_id,
      characterId: updated.character_id,
      status: updated.status,
      isActive: updated.is_active,
      metadata: updated.metadata,
      updatedAt: updated.updated_at,
    },
  });
}

/**
 * DELETE /api/v1/discord/connections/[id]
 * Delete a Discord connection.
 */
export async function DELETE(
  request: NextRequest,
  context: RouteContext,
): Promise<NextResponse> {
  const { user } = await requireAuthOrApiKeyWithOrg(request);
  const { id } = await context.params;

  const connection = await discordConnectionsRepository.findById(id);

  if (!connection) {
    return NextResponse.json(
      { success: false, error: "Connection not found" },
      { status: 404 },
    );
  }

  if (connection.organization_id !== user.organization_id) {
    return NextResponse.json(
      { success: false, error: "Connection not found" },
      { status: 404 },
    );
  }

  const deleted = await discordConnectionsRepository.delete(id);

  if (!deleted) {
    return NextResponse.json(
      { success: false, error: "Failed to delete connection" },
      { status: 500 },
    );
  }

  logger.info("[Discord Connections] Deleted connection", {
    connectionId: id,
    applicationId: connection.application_id,
    organizationId: user.organization_id,
    userId: user.id,
  });

  return NextResponse.json({
    success: true,
    message: "Connection deleted. The bot will disconnect within 30 seconds.",
  });
}
