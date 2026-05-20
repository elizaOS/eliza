/**
 * ScamBench Human Evaluation API
 *
 * @route POST /api/scambench - Submit evaluation results
 * @route GET  /api/scambench - Get aggregate leaderboard
 * @access Public (no auth required for participation)
 */

import { withErrorHandling } from '@feed/api';
import { db } from '@feed/db';
import { scambenchSessions } from '@feed/db/schema';
import { randomUUID } from 'crypto';
import { avg, count, desc } from 'drizzle-orm';
import { NextRequest, NextResponse } from 'next/server';

export const POST = withErrorHandling(async function POST(
  request: NextRequest
) {
  try {
    const body = await request.json();

    const {
      participantId = 'anonymous',
      scenarioCount,
      overallAccuracy,
      attackAccuracy,
      legitimateAccuracy,
      avgReadTimeMs,
      avgResponseTimeMs,
      results: responses,
    } = body;

    if (!responses || !Array.isArray(responses) || responses.length === 0) {
      return NextResponse.json(
        { error: 'No responses provided' },
        { status: 400 }
      );
    }

    // Detect source from headers
    const mturkAssignmentId = request.headers.get('x-mturk-assignment-id');
    const mturkHitId = request.headers.get('x-mturk-hit-id');
    const mturkWorkerId = request.headers.get('x-mturk-worker-id');
    const source = mturkAssignmentId ? 'mturk' : 'web';

    const totalDurationMs = responses.reduce(
      (sum: number, r: { totalTimeMs?: number }) => sum + (r.totalTimeMs || 0),
      0
    );

    const session = await db
      .insert(scambenchSessions)
      .values({
        id: randomUUID(),
        participantId,
        source,
        mturkAssignmentId,
        mturkHitId,
        mturkWorkerId,
        scenarioCount: scenarioCount || responses.length,
        overallAccuracy: overallAccuracy || 0,
        attackAccuracy: attackAccuracy || 0,
        legitimateAccuracy: legitimateAccuracy || 0,
        avgReadTimeMs: avgReadTimeMs || 0,
        avgResponseTimeMs: avgResponseTimeMs || 0,
        totalDurationMs,
        responses,
        userAgent: request.headers.get('user-agent'),
      })
      .returning({ id: scambenchSessions.id });

    return NextResponse.json({
      ok: true,
      sessionId: session[0]?.id,
    });
  } catch (_error) {
    return NextResponse.json(
      { error: 'Failed to save results' },
      { status: 500 }
    );
  }
});

export const GET = withErrorHandling(async function GET() {
  try {
    // Aggregate leaderboard
    const stats = await db
      .select({
        totalSessions: count(),
        avgOverall: avg(scambenchSessions.overallAccuracy),
        avgAttack: avg(scambenchSessions.attackAccuracy),
        avgLegit: avg(scambenchSessions.legitimateAccuracy),
        avgReadMs: avg(scambenchSessions.avgReadTimeMs),
        avgRespMs: avg(scambenchSessions.avgResponseTimeMs),
      })
      .from(scambenchSessions);

    // Recent sessions
    const recent = await db
      .select({
        id: scambenchSessions.id,
        participantId: scambenchSessions.participantId,
        source: scambenchSessions.source,
        scenarioCount: scambenchSessions.scenarioCount,
        overallAccuracy: scambenchSessions.overallAccuracy,
        attackAccuracy: scambenchSessions.attackAccuracy,
        legitimateAccuracy: scambenchSessions.legitimateAccuracy,
        avgReadTimeMs: scambenchSessions.avgReadTimeMs,
        avgResponseTimeMs: scambenchSessions.avgResponseTimeMs,
        createdAt: scambenchSessions.createdAt,
      })
      .from(scambenchSessions)
      .orderBy(desc(scambenchSessions.createdAt))
      .limit(50);

    // Top scores
    const topScores = await db
      .select({
        participantId: scambenchSessions.participantId,
        overallAccuracy: scambenchSessions.overallAccuracy,
        attackAccuracy: scambenchSessions.attackAccuracy,
        scenarioCount: scambenchSessions.scenarioCount,
        createdAt: scambenchSessions.createdAt,
      })
      .from(scambenchSessions)
      .orderBy(desc(scambenchSessions.overallAccuracy))
      .limit(20);

    return NextResponse.json({
      aggregate: stats[0],
      recent,
      topScores,
      modelBaselines: [
        {
          name: 'Qwen3.5-4B + SFT (ours)',
          params: '4B',
          overall: 71.0,
          attack: 74.8,
          legit: 67.2,
        },
        {
          name: 'Qwen3 32B',
          params: '32B',
          overall: 70.9,
          attack: 64.0,
          legit: 77.8,
        },
        {
          name: 'Llama 3.1 8B',
          params: '8B',
          overall: 64.6,
          attack: 49.2,
          legit: 80.0,
        },
        {
          name: 'GPT-OSS 120B',
          params: '120B',
          overall: 52.4,
          attack: 27.3,
          legit: 77.5,
        },
      ],
    });
  } catch (_error) {
    return NextResponse.json(
      { error: 'Failed to fetch leaderboard' },
      { status: 500 }
    );
  }
});
