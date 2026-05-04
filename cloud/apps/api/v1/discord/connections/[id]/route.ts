import { Hono } from "hono";

import type { AppEnv } from "@/types/cloud-worker-env";

/**
 * Discord Connection by ID API
 *
 * Manages individual Discord bot connections.
 */

import { z } from "zod";
import { discordConnectionsRepository, userCharactersRepository } from "@/db/repositories";
import { DiscordConnectionMetadataSchema } from "@/db/schemas/discord-connections";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { logger } from "@/lib/utils/logger";

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
async function __hono_GET(request: Request, context: RouteContext): Promise<Response> {
  const { user } = await requireAuthOrApiKeyWithOrg(request);
  const { id } = await context.params;

  const connection = await discordConnectionsRepository.findById(id);

  if (!connection) {
    return Response.json({ success: false, error: "Connection not found" }, { status: 404 });
  }

  if (connection.organization_id !== user.organization_id) {
    return Response.json({ success: false, error: "Connection not found" }, { status: 404 });
  }

  return Response.json({
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
async function __hono_PATCH(request: Request, context: RouteContext): Promise<Response> {
  const { user } = await requireAuthOrApiKeyWithOrg(request);
  const { id } = await context.params;

  const connection = await discordConnectionsRepository.findById(id);

  if (!connection) {
    return Response.json({ success: false, error: "Connection not found" }, { status: 404 });
  }

  if (connection.organization_id !== user.organization_id) {
    return Response.json({ success: false, error: "Connection not found" }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const validation = UpdateConnectionSchema.safeParse(body);
  if (!validation.success) {
    return Response.json(
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
      return Response.json({ success: false, error: "Character not found" }, { status: 404 });
    }
    if (character.organization_id !== user.organization_id) {
      return Response.json(
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

  return Response.json({
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
async function __hono_DELETE(request: Request, context: RouteContext): Promise<Response> {
  const { user } = await requireAuthOrApiKeyWithOrg(request);
  const { id } = await context.params;

  const connection = await discordConnectionsRepository.findById(id);

  if (!connection) {
    return Response.json({ success: false, error: "Connection not found" }, { status: 404 });
  }

  if (connection.organization_id !== user.organization_id) {
    return Response.json({ success: false, error: "Connection not found" }, { status: 404 });
  }

  const deleted = await discordConnectionsRepository.delete(id);

  if (!deleted) {
    return Response.json({ success: false, error: "Failed to delete connection" }, { status: 500 });
  }

  logger.info("[Discord Connections] Deleted connection", {
    connectionId: id,
    applicationId: connection.application_id,
    organizationId: user.organization_id,
    userId: user.id,
  });

  return Response.json({
    success: true,
    message: "Connection deleted. The bot will disconnect within 30 seconds.",
  });
}

const __hono_app = new Hono<AppEnv>();
__hono_app.get("/", async (c) =>
  __hono_GET(c.req.raw, { params: Promise.resolve({ id: c.req.param("id")! }) }),
);
__hono_app.patch("/", async (c) =>
  __hono_PATCH(c.req.raw, { params: Promise.resolve({ id: c.req.param("id")! }) }),
);
__hono_app.delete("/", async (c) =>
  __hono_DELETE(c.req.raw, { params: Promise.resolve({ id: c.req.param("id")! }) }),
);
export default __hono_app;
