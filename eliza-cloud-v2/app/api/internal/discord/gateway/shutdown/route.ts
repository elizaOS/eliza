/**
 * Discord Gateway Shutdown API
 *
 * Called by gateway pods during graceful shutdown to release all their connections.
 * This allows other pods to immediately pick up the connections rather than
 * waiting for heartbeat timeout (45+ seconds).
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { withInternalAuth } from "@/lib/auth/internal-api";
import { discordConnectionsRepository } from "@/db/repositories";
import { logger } from "@/lib/utils/logger";

export const dynamic = "force-dynamic";

// K8s pod name pattern: alphanumeric with hyphens, max 253 chars
const ShutdownRequestSchema = z.object({
  pod_name: z
    .string()
    .min(1)
    .max(253)
    .regex(/^[a-zA-Z0-9-]+$/, "Pod name must be alphanumeric with hyphens"),
});

export const POST = withInternalAuth(async (request: NextRequest) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = ShutdownRequestSchema.safeParse(body);
  if (!parsed.success) {
    logger.warn("[Gateway Shutdown] Invalid payload", {
      errors: parsed.error.issues,
    });
    return NextResponse.json(
      { error: "Invalid payload", details: parsed.error.issues },
      { status: 400 },
    );
  }

  const { pod_name } = parsed.data;

  logger.info("[Gateway Shutdown] Releasing connections for pod", {
    podName: pod_name,
  });

  const released = await discordConnectionsRepository.clearPodAssignments(
    pod_name,
  );

  logger.info("[Gateway Shutdown] Released connections", {
    podName: pod_name,
    released,
  });

  return NextResponse.json({ released });
});
