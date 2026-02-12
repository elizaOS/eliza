#!/usr/bin/env bun
/**
 * Training Data Assessment
 *
 * Comprehensive assessment of all training-related data in the database.
 * This provides a clear picture of what real data exists.
 */

import {
  agentPerformanceMetrics,
  agentTrades,
  benchmarkResults,
  count,
  db,
  desc,
  eq,
  llmCallLogs,
  rewardJudgments,
  sql,
  trainedModels,
  trainingBatches,
  trajectories,
  users,
} from '@elizaos/db';
import { mkdirSync, writeFileSync } from 'fs';
import { CANONICAL_ARCHETYPES } from '../src/rubrics';

interface AssessmentResult {
  timestamp: string;
  summary: {
    hasRealData: boolean;
    readyForTraining: boolean;
    issues: string[];
    recommendations: string[];
  };
  counts: {
    totalAgents: number;
    agentsWithTrades: number;
    agentsWithPerformanceMetrics: number;
    totalTrades: number;
    totalTrajectories: number;
    scoredTrajectories: number;
    trainingBatches: number;
    trainedModels: number;
    benchmarkRuns: number;
    llmCallLogs: number;
  };
  archetypeBreakdown: Array<{
    archetype: string;
    count: number;
    avgPnL: number;
    totalTrades: number;
  }>;
  dataQuality: {
    trajectoriesWithRewards: number;
    trajectoriesWithLlmCalls: number;
    averageStepsPerTrajectory: number;
    averageReward: number;
  };
}

async function main() {
  console.log(
    '═══════════════════════════════════════════════════════════════'
  );
  console.log('  Babylon Training Data Assessment');
  console.log(
    '═══════════════════════════════════════════════════════════════\n'
  );

  const result: AssessmentResult = {
    timestamp: new Date().toISOString(),
    summary: {
      hasRealData: false,
      readyForTraining: false,
      issues: [],
      recommendations: [],
    },
    counts: {
      totalAgents: 0,
      agentsWithTrades: 0,
      agentsWithPerformanceMetrics: 0,
      totalTrades: 0,
      totalTrajectories: 0,
      scoredTrajectories: 0,
      trainingBatches: 0,
      trainedModels: 0,
      benchmarkRuns: 0,
      llmCallLogs: 0,
    },
    archetypeBreakdown: [],
    dataQuality: {
      trajectoriesWithRewards: 0,
      trajectoriesWithLlmCalls: 0,
      averageStepsPerTrajectory: 0,
      averageReward: 0,
    },
  };

  // 1. Count agents
  console.log('Checking agents...');
  const agentCountResult = await db
    .select({ count: count() })
    .from(users)
    .where(eq(users.isAgent, true));
  result.counts.totalAgents = agentCountResult[0]?.count ?? 0;
  console.log(`  Total agents: ${result.counts.totalAgents}`);

  // 2. Count agents with performance metrics
  const perfMetricsCount = await db
    .select({ count: count() })
    .from(agentPerformanceMetrics);
  result.counts.agentsWithPerformanceMetrics = perfMetricsCount[0]?.count ?? 0;
  console.log(
    `  Agents with performance metrics: ${result.counts.agentsWithPerformanceMetrics}`
  );

  // 3. Count trades
  console.log('\nChecking trades...');
  const tradesCount = await db.select({ count: count() }).from(agentTrades);
  result.counts.totalTrades = tradesCount[0]?.count ?? 0;
  console.log(`  Total agent trades: ${result.counts.totalTrades}`);

  // Count agents with trades
  const agentsWithTradesResult = await db
    .select({ agentUserId: agentTrades.agentUserId })
    .from(agentTrades)
    .groupBy(agentTrades.agentUserId);
  result.counts.agentsWithTrades = agentsWithTradesResult.length;
  console.log(`  Agents with trades: ${result.counts.agentsWithTrades}`);

  // 4. Count trajectories
  console.log('\nChecking trajectories...');
  const trajectoriesCount = await db
    .select({ count: count() })
    .from(trajectories);
  result.counts.totalTrajectories = trajectoriesCount[0]?.count ?? 0;
  console.log(`  Total trajectories: ${result.counts.totalTrajectories}`);

  // 5. Count scored trajectories (with reward judgments)
  const scoredCount = await db.select({ count: count() }).from(rewardJudgments);
  result.counts.scoredTrajectories = scoredCount[0]?.count ?? 0;
  console.log(`  Scored trajectories: ${result.counts.scoredTrajectories}`);

  // 6. Count training batches
  console.log('\nChecking training data...');
  const batchesCount = await db
    .select({ count: count() })
    .from(trainingBatches);
  result.counts.trainingBatches = batchesCount[0]?.count ?? 0;
  console.log(`  Training batches: ${result.counts.trainingBatches}`);

  // 7. Count trained models
  const modelsCount = await db.select({ count: count() }).from(trainedModels);
  result.counts.trainedModels = modelsCount[0]?.count ?? 0;
  console.log(`  Trained models: ${result.counts.trainedModels}`);

  // 8. Count benchmark results
  const benchmarkCount = await db
    .select({ count: count() })
    .from(benchmarkResults);
  result.counts.benchmarkRuns = benchmarkCount[0]?.count ?? 0;
  console.log(`  Benchmark runs: ${result.counts.benchmarkRuns}`);

  // 9. Count LLM call logs
  const llmLogsCount = await db.select({ count: count() }).from(llmCallLogs);
  result.counts.llmCallLogs = llmLogsCount[0]?.count ?? 0;
  console.log(`  LLM call logs: ${result.counts.llmCallLogs}`);

  // 10. Get archetype breakdown from agent names
  console.log('\nAnalyzing archetype distribution...');
  const allAgents = await db
    .select({
      id: users.id,
      displayName: users.displayName,
      username: users.username,
      lifetimePnL: users.lifetimePnL,
    })
    .from(users)
    .where(eq(users.isAgent, true))
    .orderBy(desc(users.lifetimePnL))
    .limit(100);

  const archetypeMap = new Map<
    string,
    { count: number; totalPnL: number; totalTrades: number }
  >();

  // Sort archetypes by length (longest first) to prevent false positives from substring matching
  // e.g., "information-trader" should match before "trader"
  const sortedArchetypes = [...CANONICAL_ARCHETYPES].sort(
    (a, b) => b.length - a.length
  );

  for (const agent of allAgents) {
    // Detect archetype from name using canonical list
    let archetype = 'unknown';
    const name = (agent.displayName || agent.username || '').toLowerCase();
    for (const a of sortedArchetypes) {
      // Check both hyphenated and non-hyphenated versions
      if (name.includes(a.replaceAll('-', '')) || name.includes(a)) {
        archetype = a;
        break;
      }
    }

    const existing = archetypeMap.get(archetype) || {
      count: 0,
      totalPnL: 0,
      totalTrades: 0,
    };
    existing.count++;
    existing.totalPnL += Number(agent.lifetimePnL) || 0;
    archetypeMap.set(archetype, existing);
  }

  for (const [archetype, data] of archetypeMap) {
    result.archetypeBreakdown.push({
      archetype,
      count: data.count,
      avgPnL: data.count > 0 ? data.totalPnL / data.count : 0,
      totalTrades: data.totalTrades,
    });
  }
  result.archetypeBreakdown.sort((a, b) => b.avgPnL - a.avgPnL);

  console.log('\nArchetype breakdown:');
  for (const arch of result.archetypeBreakdown) {
    console.log(
      `  ${arch.archetype.padEnd(20)}: ${arch.count} agents, avg PnL: $${arch.avgPnL.toFixed(2)}`
    );
  }

  // 11. Calculate data quality metrics
  if (result.counts.totalTrajectories > 0) {
    const trajectoryStats = await db
      .select({
        avgReward: sql`AVG(${trajectories.totalReward})`.mapWith(Number),
        avgSteps: sql`AVG(${trajectories.episodeLength})`.mapWith(Number),
        withLlmCalls:
          sql`COUNT(CASE WHEN ${trajectories.aiJudgeReward} IS NOT NULL THEN 1 END)`.mapWith(
            Number
          ),
      })
      .from(trajectories);

    result.dataQuality.averageReward = trajectoryStats[0]?.avgReward ?? 0;
    result.dataQuality.averageStepsPerTrajectory =
      trajectoryStats[0]?.avgSteps ?? 0;
    result.dataQuality.trajectoriesWithRewards =
      trajectoryStats[0]?.withLlmCalls ?? 0;
  }

  // 12. Generate summary
  console.log(
    '\n═══════════════════════════════════════════════════════════════'
  );
  console.log('  Summary');
  console.log(
    '═══════════════════════════════════════════════════════════════\n'
  );

  // Check if we have real data
  result.summary.hasRealData =
    result.counts.totalAgents > 0 ||
    result.counts.totalTrades > 0 ||
    result.counts.totalTrajectories > 0;

  // Check if ready for training
  result.summary.readyForTraining =
    result.counts.totalTrajectories >= 10 &&
    result.counts.scoredTrajectories >= 10;

  // Identify issues
  if (result.counts.totalAgents === 0) {
    result.summary.issues.push('No agents found in database');
  }
  if (result.counts.totalTrades === 0) {
    result.summary.issues.push('No agent trades recorded');
  }
  if (result.counts.totalTrajectories === 0) {
    result.summary.issues.push(
      'No trajectories recorded - agents may not have recordTrajectories enabled'
    );
  }
  if (
    result.counts.scoredTrajectories === 0 &&
    result.counts.totalTrajectories > 0
  ) {
    result.summary.issues.push(
      'Trajectories exist but none are scored - run "babylon train score"'
    );
  }
  if (result.archetypeBreakdown.every((a) => a.archetype === 'unknown')) {
    result.summary.issues.push('No archetype information detected in agents');
  }

  // Generate recommendations
  if (result.counts.totalAgents === 0) {
    result.summary.recommendations.push(
      'Create agents: babylon agent spawn --count 5'
    );
    result.summary.recommendations.push(
      'Enable agents: babylon agent enable --all'
    );
  }
  if (result.counts.totalTrajectories === 0 && result.counts.totalAgents > 0) {
    result.summary.recommendations.push(
      'Run agents with trajectory recording: babylon train parallel -a trader -n 3 -t 50'
    );
  }
  if (
    result.counts.scoredTrajectories === 0 &&
    result.counts.totalTrajectories > 0
  ) {
    result.summary.recommendations.push(
      'Score trajectories: babylon train score'
    );
  }
  if (
    result.counts.trainingBatches === 0 &&
    result.counts.scoredTrajectories > 0
  ) {
    result.summary.recommendations.push(
      'Export and train: babylon train archetype -a trader'
    );
  }

  // Print summary
  if (result.summary.hasRealData) {
    console.log('✅ REAL DATA EXISTS\n');
  } else {
    console.log('❌ NO REAL DATA FOUND\n');
  }

  if (result.summary.readyForTraining) {
    console.log('✅ READY FOR TRAINING\n');
  } else {
    console.log('⚠️  NOT READY FOR TRAINING\n');
  }

  if (result.summary.issues.length > 0) {
    console.log('Issues:');
    for (const issue of result.summary.issues) {
      console.log(`  ❌ ${issue}`);
    }
    console.log();
  }

  if (result.summary.recommendations.length > 0) {
    console.log('Recommendations:');
    for (const rec of result.summary.recommendations) {
      console.log(`  → ${rec}`);
    }
    console.log();
  }

  // Save report
  const outputDir = './research-output/assessments';
  mkdirSync(outputDir, { recursive: true });

  const reportPath = `${outputDir}/data-assessment-${Date.now()}.json`;
  writeFileSync(reportPath, JSON.stringify(result, null, 2));
  console.log(`\n✓ Full report saved to: ${reportPath}`);

  // Also save as markdown
  const mdReport = `# Training Data Assessment

Generated: ${result.timestamp}

## Summary

| Metric | Value |
|--------|-------|
| Has Real Data | ${result.summary.hasRealData ? '✅ Yes' : '❌ No'} |
| Ready for Training | ${result.summary.readyForTraining ? '✅ Yes' : '❌ No'} |

## Data Counts

| Category | Count |
|----------|-------|
| Total Agents | ${result.counts.totalAgents} |
| Agents with Trades | ${result.counts.agentsWithTrades} |
| Agents with Metrics | ${result.counts.agentsWithPerformanceMetrics} |
| Total Trades | ${result.counts.totalTrades} |
| Trajectories | ${result.counts.totalTrajectories} |
| Scored Trajectories | ${result.counts.scoredTrajectories} |
| Training Batches | ${result.counts.trainingBatches} |
| Trained Models | ${result.counts.trainedModels} |
| Benchmark Runs | ${result.counts.benchmarkRuns} |
| LLM Call Logs | ${result.counts.llmCallLogs} |

## Archetype Breakdown

| Archetype | Agents | Avg PnL |
|-----------|--------|---------|
${result.archetypeBreakdown.map((a) => `| ${a.archetype} | ${a.count} | $${a.avgPnL.toFixed(2)} |`).join('\n')}

## Issues

${result.summary.issues.length > 0 ? result.summary.issues.map((i) => `- ❌ ${i}`).join('\n') : 'None'}

## Recommendations

${result.summary.recommendations.length > 0 ? result.summary.recommendations.map((r) => `- ${r}`).join('\n') : 'None'}
`;

  const mdPath = `${outputDir}/data-assessment-${Date.now()}.md`;
  writeFileSync(mdPath, mdReport);
  console.log(`✓ Markdown report saved to: ${mdPath}`);

  console.log(
    '\n═══════════════════════════════════════════════════════════════'
  );

  process.exit(0);
}

main().catch((err) => {
  console.error('Assessment failed:', err);
  process.exit(1);
});
