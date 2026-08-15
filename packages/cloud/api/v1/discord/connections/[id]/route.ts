// Handles v1 cloud API v1 discord connections id route traffic with route-local auth expectations.
import { Hono } from "hono";
import type { RouteContext } from "@/lib/api/hono-next-style-params";

import type { AppEnv } from "@/types/cloud-worker-env";

/**
 * Discord Connection by ID API
 *
 * Manages individual Discord bot connections.
 */

import { z } from "zod";
import {
  discordConnectionsRepository,
  userCharactersRepository,
} from "@/db/repositories";
import { DiscordConnectionMetadataSchema } from "@/db/schemas/discord-connections";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { logger } from "@/lib/utils/logger";

const UpdateConnectionSchema = z
  .object({
    // Character to use for responses
    characterId: z.string().uuid().nullable().optional(),

    // Bot token (re-encrypt if changed)
    botToken: z.string().min(1).optional(),

    // Whether the connection is active
    isActive: z.boolean().optional(),

    // Response behavior configuration
    metadata: DiscordConnectionMetadataSchema,

    // Current editors fence mutations by the revision they read. Optionality
    // preserves the established v1 contract for existing API clients.
    expectedEditVersion: z
      .string()
      .regex(/^\d+$/)
      .transform(Number)
      .pipe(z.number().int().nonnegative().max(2_147_483_646))
      .optional(),
  })
  .refine(
    (data) =>
      data.characterId !== undefined ||
      data.botToken !== undefined ||
      data.isActive !== undefined ||
      data.metadata !== undefined,
    { message: "At least one connection setting must be updated" },
  );

/**
 * GET /api/v1/discord/connections/[id]
 * Get a single Discord connection by ID.
 */
async function __hono_GET(
  request: Request,
  context: RouteContext<{ id: string }>,
): Promise<Response> {
  const { user } = await requireAuthOrApiKeyWithOrg(request);
  const { id } = await context.params;

  const connection = await discordConnectionsRepository.findById(id);

  if (!connection) {
    return Response.json(
      { success: false, error: "Connection not found" },
      { status: 404 },
    );
  }

  if (connection.organization_id !== user.organization_id) {
    return Response.json(
      { success: false, error: "Connection not found" },
      { status: 404 },
    );
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
      editVersion: connection.edit_version,
    },
  });
}

/**
 * PATCH /api/v1/discord/connections/[id]
 * Update a Discord connection (character, metadata, active status).
 */
async function __hono_PATCH(
  request: Request,
  context: RouteContext<{ id: string }>,
): Promise<Response> {
  const { user } = await requireAuthOrApiKeyWithOrg(request);
  const { id } = await context.params;

  const connection = await discordConnectionsRepository.findById(id);

  if (!connection) {
    return Response.json(
      { success: false, error: "Connection not found" },
      { status: 404 },
    );
  }

  if (connection.organization_id !== user.organization_id) {
    return Response.json(
      { success: false, error: "Connection not found" },
      { status: 404 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { success: false, error: "Invalid JSON body" },
      { status: 400 },
    );
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
      return Response.json(
        { success: false, error: "Character not found" },
        { status: 404 },
      );
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

  const updates: Parameters<
    typeof discordConnectionsRepository.updateConfiguration
  >[1] = {};

  if (data.botToken) {
    updates.assigned_pod = null;
    updates.status = "pending";
  }

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

  const updated = await discordConnectionsRepository.updateConfiguration(
    id,
    updates,
    data.expectedEditVersion,
    data.botToken,
  );
  if (!updated) {
    return Response.json(
      {
        success: false,
        error:
          data.expectedEditVersion === undefined
            ? "Connection not found"
            : "Connection changed since editing began. Refresh and try again.",
      },
      { status: data.expectedEditVersion === undefined ? 404 : 409 },
    );
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
      editVersion: updated.edit_version,
    },
  });
}

/**
 * DELETE /api/v1/discord/connections/[id]
 * Delete a Discord connection.
 */
async function __hono_DELETE(
  request: Request,
  context: RouteContext<{ id: string }>,
): Promise<Response> {
  const { user } = await requireAuthOrApiKeyWithOrg(request);
  const { id } = await context.params;

  const connection = await discordConnectionsRepository.findById(id);

  if (!connection) {
    return Response.json(
      { success: false, error: "Connection not found" },
      { status: 404 },
    );
  }

  if (connection.organization_id !== user.organization_id) {
    return Response.json(
      { success: false, error: "Connection not found" },
      { status: 404 },
    );
  }

  const deleted = await discordConnectionsRepository.delete(id);

  if (!deleted) {
    return Response.json(
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

  return Response.json({
    success: true,
    message: "Connection deleted. The bot will disconnect within 30 seconds.",
  });
}

const __hono_app = new Hono<AppEnv>();
__hono_app.get("/", async (c) =>
  __hono_GET(c.req.raw, {
    params: Promise.resolve({ id: c.req.param("id")! }),
  }),
);
__hono_app.patch("/", async (c) =>
  __hono_PATCH(c.req.raw, {
    params: Promise.resolve({ id: c.req.param("id")! }),
  }),
);
__hono_app.delete("/", async (c) =>
  __hono_DELETE(c.req.raw, {
    params: Promise.resolve({ id: c.req.param("id")! }),
  }),
);
export default __hono_app;
