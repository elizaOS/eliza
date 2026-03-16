/**
 * POST /api/v1/agent-state/:containerId/restore
 *
 * Restore a container's agent state from a snapshot.
 * Sends the snapshot data to the container's restore endpoint.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { logger } from "@/lib/utils/logger";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { getContainer } from "@/lib/services/containers";
import { agentSnapshotService } from "@/lib/services/agent-snapshots";

export const dynamic = "force-dynamic";

const restoreSchema = z.object({
  snapshotId: z.string().uuid(),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ containerId: string }> },
) {
  const { containerId } = await params;
  const { user } = await requireAuthOrApiKeyWithOrg(request);

  // Verify container ownership
  const container = await getContainer(containerId, user.organization_id!);
  if (!container) {
    return NextResponse.json(
      { success: false, error: "Container not found" },
      { status: 404 },
    );
  }

  if (container.status !== "running") {
    return NextResponse.json(
      { success: false, error: `Container must be running to restore (current: ${container.status})` },
      { status: 400 },
    );
  }

  const body = await request.json();
  const validated = restoreSchema.parse(body);

  await agentSnapshotService.restoreSnapshot({
    containerId,
    snapshotId: validated.snapshotId,
    organizationId: user.organization_id!,
    containerUrl: container.load_balancer_url,
  });

  logger.info("[agent-state] Snapshot restored", {
    containerId,
    snapshotId: validated.snapshotId,
  });

  return NextResponse.json({
    success: true,
    message: "Agent state restored from snapshot",
  });
}
