/**
 * GET /api/v1/agent-state/:containerId/snapshots
 *
 * List all snapshots for a container, ordered by creation date descending.
 *
 * DELETE /api/v1/agent-state/:containerId/snapshots/:snapshotId
 * is handled in the [snapshotId] sub-route.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { getContainer } from "@/lib/services/containers";
import { agentSnapshotService } from "@/lib/services/agent-snapshots";

export const dynamic = "force-dynamic";

export async function GET(
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

  const snapshots = await agentSnapshotService.listSnapshots(containerId);

  return NextResponse.json({
    success: true,
    data: snapshots,
  });
}
