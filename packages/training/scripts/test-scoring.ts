#!/usr/bin/env bun
/**
 * Test scoring directly
 */

import { and, db, desc, eq, isNull, not, trajectories } from '@elizaos/db';
import { archetypeScoringService } from '../src/scoring';

async function main() {
  console.log('Testing trajectory scoring...\n');

  // Get unscored trajectories
  const unscored = await db
    .select({ trajectoryId: trajectories.trajectoryId })
    .from(trajectories)
    .where(
      and(
        isNull(trajectories.aiJudgeReward),
        eq(trajectories.isTrainingData, true),
        not(eq(trajectories.stepsJson, 'null')),
        not(eq(trajectories.stepsJson, '[]'))
      )
    )
    .limit(10);

  console.log(`Found ${unscored.length} unscored trajectories`);

  if (unscored.length === 0) {
    console.log('No trajectories to score!');
    process.exit(0);
  }

  const ids = unscored.map((t) => t.trajectoryId);
  console.log('Trajectory IDs:', ids);

  console.log('\nAttempting to score...');

  try {
    const result = await archetypeScoringService.scoreByArchetype(
      'default',
      ids
    );
    console.log('\nResult:', result);

    // Check if any were scored
    const scored = await db
      .select({
        trajectoryId: trajectories.trajectoryId,
        aiJudgeReward: trajectories.aiJudgeReward,
        aiJudgeReasoning: trajectories.aiJudgeReasoning,
      })
      .from(trajectories)
      .where(not(isNull(trajectories.aiJudgeReward)))
      .orderBy(desc(trajectories.judgedAt))
      .limit(5);

    console.log('\nScored trajectories:', scored.length);
    if (scored.length > 0) {
      console.log('Sample scores:');
      for (const s of scored) {
        console.log(
          `  ${s.trajectoryId}: score=${s.aiJudgeReward}, reasoning=${s.aiJudgeReasoning?.substring(0, 50)}...`
        );
      }
    }
  } catch (error) {
    console.error('Scoring error:', error);
  }

  process.exit(0);
}

main().catch(console.error);
