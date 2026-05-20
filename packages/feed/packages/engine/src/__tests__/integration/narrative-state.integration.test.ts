/**
 * Narrative State Service Integration Test
 *
 * Tests arc plan persistence using @feed/db interface.
 * Requires: Database running, RUN_INTEGRATION_TESTS=true
 *
 * Run with: RUN_INTEGRATION_TESTS=true bun test narrative-state.integration
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { db } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import {
  getArcPlan,
  saveArcPlan,
} from '../../services/narrative-state-service';
import type { QuestionArcPlan } from '../../services/question-arc-planner';

// Skip unless explicitly enabled with database running
// Run: RUN_INTEGRATION_TESTS=true bun test narrative-state.integration
const SKIP = process.env.RUN_INTEGRATION_TESTS !== 'true';

describe.skipIf(SKIP)('Narrative State Service - Integration', () => {
  let testQuestionId: string;

  beforeAll(async () => {
    // Create a test question to reference
    testQuestionId = await generateSnowflakeId();

    await db.question.create({
      data: {
        id: testQuestionId,
        questionNumber: 99999,
        text: 'Test question for narrative arc',
        scenarioId: 1,
        outcome: true,
        rank: 1,
        resolutionDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        status: 'active',
        updatedAt: new Date(),
      },
    });
  });

  afterAll(async () => {
    // Cleanup test data
    await db.questionArcPlan.deleteMany({
      where: { questionId: testQuestionId },
    });
    await db.question.delete({
      where: { id: testQuestionId },
    });
  });

  test('saveArcPlan persists arc plan to database', async () => {
    const mockArcPlan: QuestionArcPlan = {
      questionId: testQuestionId,
      outcome: true,
      uncertaintyPeakDay: 10,
      clarityOnsetDay: 20,
      verificationDay: 28,
      insiders: ['actor-1', 'actor-2'],
      deceivers: ['actor-3'],
      plannedRedHerrings: [
        { day: 5, description: 'Misleading report', apparentDirection: 'NO' },
      ],
      phases: {
        early: {
          daysRange: [1, 10],
          targetEventsTotal: 5,
          targetCorrectSignals: 2,
          targetWrongSignals: 3,
          targetAmbiguous: 0,
          targetClueStrength: [0.2, 0.4],
        },
        middle: {
          daysRange: [11, 20],
          targetEventsTotal: 5,
          targetCorrectSignals: 3,
          targetWrongSignals: 2,
          targetAmbiguous: 0,
          targetClueStrength: [0.4, 0.6],
        },
        late: {
          daysRange: [21, 27],
          targetEventsTotal: 4,
          targetCorrectSignals: 3,
          targetWrongSignals: 1,
          targetAmbiguous: 0,
          targetClueStrength: [0.6, 0.8],
        },
        climax: {
          daysRange: [28, 30],
          targetEventsTotal: 2,
          targetCorrectSignals: 2,
          targetWrongSignals: 0,
          targetAmbiguous: 0,
          targetClueStrength: [0.9, 1.0],
        },
      },
    };

    // Save the arc plan
    await saveArcPlan(testQuestionId, mockArcPlan);

    // Verify it was saved using the service
    const saved = await getArcPlan(testQuestionId);

    expect(saved).toBeDefined();
    expect(saved!.uncertaintyPeakDay).toBe(10);
    expect(saved!.clarityOnsetDay).toBe(20);
    expect(saved!.verificationDay).toBe(28);
    expect(saved!.insiderActorIds).toEqual(['actor-1', 'actor-2']);
    expect(saved!.deceiverActorIds).toEqual(['actor-3']);

    const ratios = saved!.phaseRatios as {
      early: number;
      middle: number;
      late: number;
      climax: number;
    };
    expect(ratios.early).toBeCloseTo(0.4, 2); // 2/5
    expect(ratios.middle).toBeCloseTo(0.6, 2); // 3/5
    expect(ratios.late).toBeCloseTo(0.75, 2); // 3/4
    expect(ratios.climax).toBe(1.0);
  });

  test('getArcPlan returns null for non-existent question', async () => {
    const result = await getArcPlan('non-existent-id');
    expect(result).toBeNull();
  });

  test('getPhaseForDay returns correct phase based on arc plan timing', async () => {
    const { getPhaseForDay } = await import(
      '../../services/narrative-state-service'
    );

    // Get the arc plan we created in the previous test
    const arcPlan = await getArcPlan(testQuestionId);
    expect(arcPlan).toBeDefined();
    if (!arcPlan) return;

    // Test phase transitions based on arc plan days
    // uncertaintyPeakDay: 10, clarityOnsetDay: 20, verificationDay: 28
    expect(getPhaseForDay(1, arcPlan)).toBe('early');
    expect(getPhaseForDay(9, arcPlan)).toBe('early');
    expect(getPhaseForDay(10, arcPlan)).toBe('middle');
    expect(getPhaseForDay(15, arcPlan)).toBe('middle');
    expect(getPhaseForDay(19, arcPlan)).toBe('middle');
    expect(getPhaseForDay(20, arcPlan)).toBe('late');
    expect(getPhaseForDay(27, arcPlan)).toBe('late');
    expect(getPhaseForDay(28, arcPlan)).toBe('climax');
    expect(getPhaseForDay(30, arcPlan)).toBe('climax');
  });

  test('getSignalDirection returns correct direction for insiders/deceivers', async () => {
    const { getSignalDirection } = await import(
      '../../services/narrative-state-service'
    );

    const arcPlan = await getArcPlan(testQuestionId);
    expect(arcPlan).toBeDefined();
    if (!arcPlan) return;

    // Insiders always point toward truth (outcome=true means YES)
    const insiderDirection = getSignalDirection(
      arcPlan,
      'early',
      'actor-1',
      true
    );
    expect(insiderDirection.direction).toBe('YES');
    expect(insiderDirection.reason).toBe('insider');

    // Deceivers always point away from truth
    const deceiverDirection = getSignalDirection(
      arcPlan,
      'early',
      'actor-3',
      true
    );
    expect(deceiverDirection.direction).toBe('NO');
    expect(deceiverDirection.reason).toBe('deceiver');

    // Regular actors follow phase distribution
    const regularDirection = getSignalDirection(
      arcPlan,
      'early',
      'regular-actor',
      true
    );
    expect(['YES', 'NO']).toContain(regularDirection.direction);
    expect(regularDirection.reason).toBe('phase');
  });

  test('phase signal ratios follow expected progression', async () => {
    const arcPlan = await getArcPlan(testQuestionId);
    expect(arcPlan).toBeDefined();
    if (!arcPlan) return;

    const ratios = arcPlan.phaseRatios as {
      early: number;
      middle: number;
      late: number;
      climax: number;
    };

    // Signal accuracy should increase as we progress through phases
    // early < middle < late < climax
    expect(ratios.early).toBeLessThan(ratios.middle);
    expect(ratios.middle).toBeLessThan(ratios.late);
    expect(ratios.late).toBeLessThan(ratios.climax);

    // Climax should have 100% correct signals
    expect(ratios.climax).toBe(1.0);
  });
});
