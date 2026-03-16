/**
 * Discord Gateway Heartbeat API
 *
 * Receives heartbeat updates from gateway pods to update last_heartbeat
 * in the database for failover detection.
 */

import { NextRequest, NextResponse } from "next/server";
import { withInternalAuth } from "@/lib/auth/internal-api";
import { discordConnectionsRepository } from "@/db/repositories";
import { z } from "zod";
import { logger } from "@/lib/utils/logger";

export const dynamic = "force-dynamic";

const ConnectionStatsSchema = z.object({
  id: z.string().uuid(),
  guildCount: z.number().int().nonnegative().optional(),
  eventsReceived: z.number().int().nonnegative().optional(),
  eventsRouted: z.number().int().nonnegative().optional(),
});

const HeartbeatSchema = z.object({
  pod_name: z.string().min(1),
  connection_ids: z.array(z.string().uuid()),
  // Optional stats for each connection
  connection_stats: z.array(ConnectionStatsSchema).optional(),
});

export const POST = withInternalAuth(async (request: NextRequest) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = HeartbeatSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid payload", details: parsed.error.issues },
      { status: 400 },
    );
  }

  const { pod_name, connection_ids, connection_stats } = parsed.data;

  if (connection_ids.length === 0) {
    return NextResponse.json({ updated: 0 });
  }

  try {
    // Update heartbeat timestamps
    const updated = await discordConnectionsRepository.updateHeartbeatBatch(
      pod_name,
      connection_ids,
    );

    // Update stats if provided
    if (connection_stats && connection_stats.length > 0) {
      await Promise.all(
        connection_stats.map((stats) =>
          discordConnectionsRepository.updateStats(stats.id, {
            guildCount: stats.guildCount,
            eventsReceived: stats.eventsReceived,
            eventsRouted: stats.eventsRouted,
          }),
        ),
      );
    }

    logger.debug("[Gateway Heartbeat] Updated heartbeats", {
      podName: pod_name,
      requestedCount: connection_ids.length,
      updatedCount: updated,
      statsCount: connection_stats?.length ?? 0,
    });

    return NextResponse.json({ updated });
  } catch (error) {
    logger.error("[Gateway Heartbeat] Failed to update heartbeats", {
      podName: pod_name,
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { error: "Failed to update heartbeats" },
      { status: 500 },
    );
  }
});
