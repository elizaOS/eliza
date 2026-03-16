/**
 * POST /api/v1/agent-state/:containerId/snapshot
 *
 * Create a state snapshot of a running agent container.
 * Calls the agent's internal snapshot endpoint and stores the result
 * in cloud storage with metadata in the agent_snapshots table.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { logger } from "@/lib/utils/logger";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { getContainer } from "@/lib/services/containers";
import { agentSnapshotService } from "@/lib/services/agent-snapshots";

export const dynamic = "force-dynamic";

const createSnapshotSchema = z.object({
  snapshotType: z.enum(["manual", "auto", "pre-eviction"]).default("manual"),
  metadata: z.record(z.unknown()).optional(),
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

  const body = await request.json();
  const validated = createSnapshotSchema.parse(body);

  // Create snapshot through the agent snapshot service
  const snapshot = await agentSnapshotService.createSnapshot({
    containerId,
    organizationId: user.organization_id!,
    snapshotType: validated.snapshotType,
    containerUrl: container.load_balancer_url,
    metadata: validated.metadata,
  });

  logger.info("[agent-state] Snapshot created", {
    containerId,
    snapshotId: snapshot.id,
    type: validated.snapshotType,
    sizeBytes: snapshot.sizeBytes,
  });

  return NextResponse.json({
    success: true,
    data: snapshot,
  });
}
