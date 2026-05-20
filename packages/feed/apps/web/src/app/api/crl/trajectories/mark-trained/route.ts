/**
 * Mark Trajectories as Trained
 *
 * @route POST /api/crl/trajectories/mark-trained
 *
 * Called by the Nebius CRL trainer after processing a batch of trajectories.
 * Marks them as usedInTraining=true so they won't be re-fetched.
 *
 * Body: { trajectoryIds: string[], batchId?: string }
 */

import { withErrorHandling } from '@feed/api';
import { db, inArray, trajectories } from '@feed/db';
import { type NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export const POST = withErrorHandling(async function POST(
  request: NextRequest
) {
  try {
    const body = await request.json();
    const { trajectoryIds, batchId } = body as {
      trajectoryIds: string[];
      batchId?: string;
    };

    if (!Array.isArray(trajectoryIds) || trajectoryIds.length === 0) {
      return NextResponse.json(
        { error: 'trajectoryIds must be a non-empty array' },
        { status: 400 }
      );
    }

    if (trajectoryIds.length > 500) {
      return NextResponse.json(
        { error: 'Maximum 500 trajectory IDs per request' },
        { status: 400 }
      );
    }

    const updateData: Record<string, unknown> = {
      usedInTraining: true,
      updatedAt: new Date(),
    };
    if (batchId) {
      updateData.trainedInBatch = batchId;
    }

    await db
      .update(trajectories)
      .set(updateData)
      .where(inArray(trajectories.trajectoryId, trajectoryIds));

    return NextResponse.json({
      success: true,
      marked: trajectoryIds.length,
      batchId: batchId || null,
    });
  } catch (_error) {
    return NextResponse.json(
      { error: 'Failed to mark trajectories' },
      { status: 500 }
    );
  }
});
