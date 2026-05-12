import { Hono } from "hono";

import type { AppEnv } from "@/types/cloud-worker-env";

/**
 * Voice Management API (v1)
 *
 * GET/PATCH/DELETE /api/v1/voice/[id]
 * Manage individual voices.
 * Supports both session and API key authentication.
 *
 * WHY THIS EXISTS:
 * ----------------
 * 1. FULL CRUD: Applications need complete voice lifecycle management - not just
 *    creation, but updates (rename, deactivate) and deletion.
 *
 * 2. VOICE METADATA: Applications displaying voice catalogs need to fetch detailed
 *    voice information including quality scores, usage counts, and settings.
 *
 * 3. CLEANUP & MANAGEMENT: Organizations with voice quotas need to delete unused
 *    voices programmatically to make room for new ones.
 *
 * 4. PROVIDER AGNOSTIC: Generic path ensures voice management code works regardless
 *    of underlying voice synthesis provider.
 */

import { z } from "zod";
import { getErrorStatusCode, nextJsonFromCaughtError } from "@/lib/api/errors";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { voiceCloningService } from "@/lib/services/voice-cloning";
import { logger } from "@/lib/utils/logger";

const VoiceUpdateBody = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
  isActive: z.boolean().optional(),
});

const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidVoiceId(voiceId: string) {
  return uuidRegex.test(voiceId);
}

function createInvalidVoiceIdResponse() {
  return Response.json(
    {
      error: "Invalid voice ID format",
      message: "Please use the internal voice ID (UUID format) from the 'List Voices' endpoint.",
      hint: "Call GET /api/v1/voice/list to get your voice IDs",
    },
    { status: 400 },
  );
}

function getInvalidVoiceIdResponseIfNeeded(voiceId: string, logMessage: string) {
  if (isValidVoiceId(voiceId)) {
    return null;
  }

  logger.warn(logMessage);
  return createInvalidVoiceIdResponse();
}

function isInvalidVoiceIdError(error: unknown) {
  return (
    error instanceof Error &&
    (error.message.includes("invalid input syntax for type uuid") || error.message.includes("uuid"))
  );
}

/**
 * GET /api/v1/voice/[id]
 * Gets details for a specific voice by its internal UUID.
 * Validates UUID format and verifies ownership.
 *
 * @param request - The Next.js request object.
 * @param context - Route context containing the voice ID parameter.
 * @returns Voice details including provider voice ID and metadata.
 */
async function __hono_GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    const params = await context.params;
    const voiceId = params.id;

    logger.info(`[Voice API] Getting voice ${voiceId} for user ${user.id}`);

    const invalidVoiceIdResponse = getInvalidVoiceIdResponseIfNeeded(
      voiceId,
      `[Voice API] Invalid voice ID format: ${voiceId}. Expected UUID format.`,
    );
    if (invalidVoiceIdResponse) {
      return invalidVoiceIdResponse;
    }

    const voice = await voiceCloningService.getVoiceById(voiceId, user.organization_id);

    if (!voice) {
      return Response.json(
        {
          error: "Voice not found",
          message:
            "Voice not found in your organization. Make sure you're using the correct voice ID from 'List Voices'.",
        },
        { status: 404 },
      );
    }

    return Response.json({
      success: true,
      voice,
    });
  } catch (error) {
    if (isInvalidVoiceIdError(error)) {
      return createInvalidVoiceIdResponse();
    }
    if (getErrorStatusCode(error) >= 500) {
      logger.error("[Voice API] Error:", error);
    }
    return nextJsonFromCaughtError(error);
  }
}

/**
 * DELETE /api/v1/voice/[id]
 * Deletes a voice by its internal UUID.
 * Validates UUID format and verifies ownership before deletion.
 *
 * @param request - The Next.js request object.
 * @param context - Route context containing the voice ID parameter.
 * @returns Success confirmation.
 */
async function __hono_DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    const params = await context.params;
    const voiceId = params.id;

    logger.info(`[Voice API] Deleting voice ${voiceId} for user ${user.id}`);

    const invalidVoiceIdResponse = getInvalidVoiceIdResponseIfNeeded(
      voiceId,
      `[Voice API] Invalid voice ID format for deletion: ${voiceId}`,
    );
    if (invalidVoiceIdResponse) {
      return invalidVoiceIdResponse;
    }

    await voiceCloningService.deleteVoice(voiceId, user.organization_id);

    return Response.json({
      success: true,
      message: "Voice deleted successfully",
    });
  } catch (error) {
    if (error instanceof Error) {
      if (error.message.includes("not found")) {
        return Response.json(
          {
            error: "Voice not found",
            message:
              "Voice not found in your organization. Make sure you're using the correct voice ID from 'List Voices'.",
          },
          { status: 404 },
        );
      }

      if (isInvalidVoiceIdError(error)) {
        return createInvalidVoiceIdResponse();
      }
    }
    if (getErrorStatusCode(error) >= 500) {
      logger.error("[Voice API] Delete error:", error);
    }
    return nextJsonFromCaughtError(error);
  }
}

/**
 * PATCH /api/v1/voice/[id]
 * Updates a voice's metadata (name, description, settings, active status).
 * Validates UUID format and verifies ownership.
 *
 * Request Body:
 * - `name`: Optional voice name.
 * - `description`: Optional voice description.
 * - `settings`: Optional settings object.
 * - `isActive`: Optional boolean for active status.
 *
 * @param request - Request body with fields to update.
 * @param context - Route context containing the voice ID parameter.
 * @returns Updated voice details.
 */
async function __hono_PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    const params = await context.params;
    const voiceId = params.id;

    logger.info(`[Voice API] Updating voice ${voiceId} for user ${user.id}`);

    const invalidVoiceIdResponse = getInvalidVoiceIdResponseIfNeeded(
      voiceId,
      `[Voice API] Invalid voice ID format for update: ${voiceId}`,
    );
    if (invalidVoiceIdResponse) {
      return invalidVoiceIdResponse;
    }

    const rawBody = await request.json();
    const parsed = VoiceUpdateBody.safeParse(rawBody);
    if (!parsed.success) {
      return Response.json(
        { error: "Invalid request body", details: parsed.error.flatten() },
        { status: 400 },
      );
    }
    const { name, description, settings, isActive } = parsed.data;

    const updatedVoice = await voiceCloningService.updateVoice(voiceId, user.organization_id, {
      name,
      description,
      settings,
      isActive,
    });

    return Response.json({
      success: true,
      voice: updatedVoice,
    });
  } catch (error) {
    if (error instanceof Error) {
      if (error.message.includes("not found")) {
        return Response.json({ error: "Voice not found" }, { status: 404 });
      }

      if (isInvalidVoiceIdError(error)) {
        return createInvalidVoiceIdResponse();
      }
    }
    if (getErrorStatusCode(error) >= 500) {
      logger.error("[Voice API] Update error:", error);
    }
    return nextJsonFromCaughtError(error);
  }
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
