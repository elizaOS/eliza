/**
 * Integration Test: Game Feedback → Reputation Recalculation
 *
 * Validates that submitting game feedback updates AgentPerformanceMetrics
 * (gamesPlayed, gamesWon, averageFeedbackScore, reputationScore, intel stats).
 */

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { db } from '@babylon/db';
import { generateSnowflakeId } from '@babylon/shared';
import { NextRequest } from 'next/server';

// Mock agent0 sync to prevent race conditions in tests
mock.module('@babylon/agents/agent0/reputation/agent0-reputation-sync', () => ({
  submitFeedbackToAgent0: async () => {
    return { submitted: true };
  },
  syncAfterAgent0Registration: async () => {
    return { synced: true };
  },
}));

// Dynamic import to ensure mock is used
const { POST: submitGameFeedback } = await import(
  '@/app/api/feedback/game-to-agent/route'
);

describe('game feedback updates reputation metrics', () => {
  let agentId: string;

  beforeAll(async () => {
    agentId = await generateSnowflakeId();
    await db.user.create({
      data: {
        id: agentId,
        username: `agent-rep-${Date.now()}`,
        displayName: 'Reputation Test Agent',
        isAgent: true,
        updatedAt: new Date(),
      },
    });
  });

  afterAll(async () => {
    await db.feedback.deleteMany({ where: { toUserId: agentId } });
    await db.agentPerformanceMetrics.deleteMany({ where: { userId: agentId } });
    await db.user.delete({ where: { id: agentId } });
  });

  test('POST /api/feedback/game-to-agent increments metrics and reputation', async () => {
    const payload = {
      agentId,
      gameId: `game-${Date.now()}`,
      score: 85,
      won: true,
      metadata: { source: 'integration-test' },
    };

    const request = new NextRequest(
      'http://localhost/api/feedback/game-to-agent',
      {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: new Headers({ 'Content-Type': 'application/json' }),
      }
    );

    const response = await submitGameFeedback(request);
    expect(response.status).toBe(201);
    const json = await response.json();
    expect(json.success).toBe(true);

    const metrics = await db.agentPerformanceMetrics.findUnique({
      where: { userId: agentId },
    });
    expect(metrics).toBeTruthy();
    expect(metrics?.gamesPlayed).toBeGreaterThanOrEqual(1);
    expect(metrics?.gamesWon).toBeGreaterThanOrEqual(1);
    expect(metrics?.totalFeedbackCount).toBeGreaterThanOrEqual(1);
    expect(metrics?.averageFeedbackScore).toBeGreaterThan(0);
    expect(metrics?.reputationScore).toBeGreaterThan(0);
  });
});
