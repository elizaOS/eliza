/**
 * Discord Events API
 *
 * Receives Discord events forwarded from the gateway service.
 * Routes events to the appropriate Eliza agent for processing.
 */

import { NextRequest, NextResponse } from "next/server";
import { withInternalAuth } from "@/lib/auth/internal-api";
import { routeDiscordEvent } from "@/lib/services/gateway-discord/event-router";
import { logger } from "@/lib/utils/logger";
import {
  DiscordEventPayloadSchema,
  type DiscordEventPayload,
} from "@/lib/services/gateway-discord/schemas";

export const dynamic = "force-dynamic";

/**
 * Validate payload with Zod schema.
 * Fails hard if Zod is unavailable - no unsafe fallback validation.
 */
function validatePayload(body: unknown): { success: true; data: DiscordEventPayload } | { success: false; error: string } {
  const parsed = DiscordEventPayloadSchema.safeParse(body);
  if (parsed.success) {
    return { success: true, data: parsed.data };
  }
  return { success: false, error: parsed.error.issues.map((e) => e.message).join(", ") };
}

export const POST = withInternalAuth(async (request: NextRequest) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const validation = validatePayload(body);
  if (!validation.success) {
    logger.warn("[Discord Events] Invalid payload", { error: validation.error });
    return NextResponse.json(
      { error: "Invalid payload", details: validation.error },
      { status: 400 },
    );
  }

  const payload = validation.data;

  logger.info("[Discord Events] Received event", {
    connectionId: payload.connection_id,
    eventType: payload.event_type,
    eventId: payload.event_id,
    organizationId: payload.organization_id,
    guildId: payload.guild_id,
    channelId: payload.channel_id,
  });

  try {
    const result = await routeDiscordEvent(payload);

    if (!result.processed) {
      logger.warn("[Discord Events] Event not processed", {
        connectionId: payload.connection_id,
        eventType: payload.event_type,
        eventId: payload.event_id,
      });
    }

    return NextResponse.json({
      processed: result.processed,
      hasResponse: !!result.response,
    });
  } catch (error) {
    logger.error("[Discord Events] Error processing event", {
      connectionId: payload.connection_id,
      eventType: payload.event_type,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return NextResponse.json(
      { error: "Internal server error", message: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
});
