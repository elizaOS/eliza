/**
 * DELETE /api/v1/agent-state/:containerId/snapshots/:snapshotId
 *
 * Delete a specific snapshot.
 */

import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/utils/logger";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { getContainer } from "@/lib/services/containers";
import { agentSnapshotService } from "@/lib/services/agent-snapshots";

export const dynamic = "force-dynamic";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ containerId: string; snapshotId: string }> },
) {
  const { containerId, snapshotId } = await params;
  const { user } = await requireAuthOrApiKeyWithOrg(request);

  // Verify container ownership
  const container = await getContainer(containerId, user.organization_id!);
  if (!container) {
    return NextResponse.json(
      { success: false, error: "Container not found" },
      { status: 404 },
    );
  }

  await agentSnapshotService.deleteSnapshot(snapshotId, user.organization_id!);

  logger.info("[agent-state] Snapshot deleted", {
    containerId,
    snapshotId,
  });

  return NextResponse.json({
    success: true,
    message: "Snapshot deleted",
  });
}
