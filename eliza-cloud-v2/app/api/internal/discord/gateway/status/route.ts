/**
 * Discord Gateway Status API
 *
 * Receives connection status updates from gateway pods.
 */

import { NextRequest, NextResponse } from "next/server";
import { withInternalAuth } from "@/lib/auth/internal-api";
import { discordConnectionsRepository } from "@/db/repositories";
import { ConnectionStatusUpdateSchema } from "@/lib/services/gateway-discord/schemas";
import { logger } from "@/lib/utils/logger";

export const dynamic = "force-dynamic";

export const POST = withInternalAuth(async (request: NextRequest) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = ConnectionStatusUpdateSchema.safeParse(body);
  if (!parsed.success) {
    logger.warn("[Gateway Status] Invalid payload", {
      errors: parsed.error.issues,
    });
    return NextResponse.json(
      { error: "Invalid payload", details: parsed.error.issues },
      { status: 400 },
    );
  }

  const { connection_id, pod_name, status, error_message, bot_user_id } =
    parsed.data;

  logger.info("[Gateway Status] Updating connection status", {
    connectionId: connection_id,
    podName: pod_name,
    status,
    hasError: !!error_message,
    botUserId: bot_user_id,
  });

  const updated = await discordConnectionsRepository.updateStatus(
    connection_id,
    status,
    pod_name,
    error_message,
    bot_user_id,
  );

  if (!updated) {
    return NextResponse.json(
      { error: "Connection not found" },
      { status: 404 },
    );
  }

  return NextResponse.json({ success: true });
});
