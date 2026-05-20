/**
 * CRL Trajectory Export API
 *
 * @route GET /api/crl/trajectories - Export trajectories with pre-computed rewards
 *
 * Polled by the Nebius CRL trainer to fetch training data.
 * Returns trajectories with full LLM call logs and deterministic reward scores.
 *
 * Query params:
 *   since  - ISO8601 timestamp, only return trajectories created after this
 *   limit  - Max trajectories to return (default 50, max 200)
 *   cursor - Pagination cursor (trajectory ID) for next page
 */

import { withErrorHandling } from '@feed/api';
import {
  and,
  asc,
  db,
  eq,
  gt,
  inArray,
  rewardJudgments,
  trajectories,
} from '@feed/db';
import { type NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export const GET = withErrorHandling(async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const since = searchParams.get('since');
    const limitParam = searchParams.get('limit');
    const cursor = searchParams.get('cursor');

    const limit = Math.min(parseInt(limitParam || '50', 10), 200);

    // Build conditions
    const conditions = [
      eq(trajectories.isTrainingData, true),
      eq(trajectories.usedInTraining, false),
    ];

    if (since) {
      conditions.push(gt(trajectories.createdAt, new Date(since)));
    }

    if (cursor) {
      conditions.push(gt(trajectories.id, cursor));
    }

    // Fetch trajectories
    const rows = await db
      .select({
        id: trajectories.id,
        trajectoryId: trajectories.trajectoryId,
        agentId: trajectories.agentId,
        archetype: trajectories.archetype,
        windowId: trajectories.windowId,
        stepsJson: trajectories.stepsJson,
        totalReward: trajectories.totalReward,
        aiJudgeReward: trajectories.aiJudgeReward,
        rewardComponentsJson: trajectories.rewardComponentsJson,
        metricsJson: trajectories.metricsJson,
        metadataJson: trajectories.metadataJson,
        finalBalance: trajectories.finalBalance,
        finalPnL: trajectories.finalPnL,
        episodeLength: trajectories.episodeLength,
        createdAt: trajectories.createdAt,
      })
      .from(trajectories)
      .where(and(...conditions))
      .orderBy(asc(trajectories.id))
      .limit(limit + 1); // +1 to check hasMore

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? page[page.length - 1]?.id : null;

    // Fetch reward judgments for these trajectories
    const trajIds = page.map((r) => r.trajectoryId);

    const judgments =
      trajIds.length > 0
        ? await db
            .select({
              trajectoryId: rewardJudgments.trajectoryId,
              overallScore: rewardJudgments.overallScore,
              normalizedScore: rewardJudgments.normalizedScore,
              componentScoresJson: rewardJudgments.componentScoresJson,
            })
            .from(rewardJudgments)
            .where(inArray(rewardJudgments.trajectoryId, trajIds))
        : [];

    const judgmentMap = new Map(judgments.map((j) => [j.trajectoryId, j]));

    // Format response
    const result = page.map((row) => {
      const judgment = judgmentMap.get(row.trajectoryId);
      let steps: unknown[] = [];
      try {
        steps = JSON.parse(row.stepsJson || '[]');
      } catch {
        /* invalid JSON */
      }

      let metadata: Record<string, unknown> = {};
      try {
        metadata = JSON.parse(row.metadataJson || '{}');
      } catch {
        /* invalid JSON */
      }

      let componentScores: Record<string, number> = {};
      try {
        componentScores = JSON.parse(
          judgment?.componentScoresJson || row.rewardComponentsJson || '{}'
        );
      } catch {
        /* invalid JSON */
      }

      return {
        id: row.id,
        trajectoryId: row.trajectoryId,
        agentId: row.agentId,
        archetype: row.archetype,
        team: (metadata as Record<string, string>).agentTeam || 'gray',
        alignment:
          (metadata as Record<string, string>).agentAlignment || 'neutral',
        windowId: row.windowId,
        totalReward: row.totalReward,
        aiJudgeReward: row.aiJudgeReward ?? row.totalReward,
        overallScore: judgment?.overallScore ?? row.totalReward,
        componentScores,
        finalBalance: row.finalBalance,
        finalPnL: row.finalPnL,
        episodeLength: row.episodeLength,
        steps,
        createdAt: row.createdAt?.toISOString(),
      };
    });

    return NextResponse.json({
      trajectories: result,
      cursor: nextCursor,
      hasMore,
      count: result.length,
    });
  } catch (_error) {
    return NextResponse.json(
      { error: 'Failed to export trajectories' },
      { status: 500 }
    );
  }
});
