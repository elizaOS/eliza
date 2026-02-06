/**
 * Snapshot Cleanup Cron Job
 *
 * Manages the lifecycle of agent snapshots for suspended containers:
 *   - After 30 days in "suspended": mark container as "archived"
 *   - After 90 days in "archived": delete snapshots and container record
 *
 * Schedule: Runs weekly (0 0 * * 0)
 * Protected by CRON_SECRET.
 */

import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { dbRead, dbWrite } from "@/db/client";
import { containers } from "@/db/schemas/containers";
import { eq, and, lt, sql } from "drizzle-orm";
import { agentSnapshotService } from "@/lib/services/agent-snapshots";
import { logger } from "@/lib/utils/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const ARCHIVE_AFTER_DAYS = 30;
const DELETE_AFTER_DAYS = 90;

function verifyCronSecret(request: NextRequest): boolean {
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return false;

  const providedSecret = authHeader?.replace("Bearer ", "") || "";
  const providedBuffer = Buffer.from(providedSecret, "utf8");
  const secretBuffer = Buffer.from(cronSecret, "utf8");

  return (
    providedBuffer.length === secretBuffer.length &&
    timingSafeEqual(providedBuffer, secretBuffer)
  );
}

export async function GET(request: NextRequest) {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date();
  const archiveCutoff = new Date(now.getTime() - ARCHIVE_AFTER_DAYS * 24 * 60 * 60 * 1000);
  const deleteCutoff = new Date(now.getTime() - DELETE_AFTER_DAYS * 24 * 60 * 60 * 1000);

  let archived = 0;
  let deleted = 0;

  // Phase 1: Move suspended containers older than 30 days to archived
  const suspendedContainers = await dbRead
    .select({ id: containers.id, name: containers.name })
    .from(containers)
    .where(
      and(
        eq(containers.billing_status, "suspended"),
        eq(containers.status, "stopped"),
        lt(containers.updated_at, archiveCutoff),
      ),
    );

  for (const container of suspendedContainers) {
    await dbWrite
      .update(containers)
      .set({
        billing_status: "archived",
        updated_at: now,
      })
      .where(eq(containers.id, container.id));
    archived++;
    logger.info(
      `[Snapshot Cleanup] Archived suspended container ${container.name} (${container.id})`,
    );
  }

  // Phase 2: Delete archived containers older than 90 days
  const archivedContainers = await dbRead
    .select({ id: containers.id, name: containers.name })
    .from(containers)
    .where(
      and(
        sql`${containers.billing_status} = 'archived'`,
        lt(containers.updated_at, deleteCutoff),
      ),
    );

  for (const container of archivedContainers) {
    // Delete all snapshots for this container
    const deletedSnapshots = await agentSnapshotService.deleteAllForContainer(
      container.id,
    );

    // Delete the container record itself
    await dbWrite
      .delete(containers)
      .where(eq(containers.id, container.id));

    deleted++;
    logger.info(
      `[Snapshot Cleanup] Deleted archived container ${container.name} (${container.id}) and ${deletedSnapshots} snapshot(s)`,
    );
  }

  logger.info("[Snapshot Cleanup] Completed", { archived, deleted });

  return NextResponse.json({
    success: true,
    data: {
      archived,
      deleted,
      timestamp: now.toISOString(),
    },
  });
}
