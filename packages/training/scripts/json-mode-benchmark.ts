#!/usr/bin/env bun

/**
 * JSON Mode Benchmark
 *
 * Runs a complete benchmark in JSON mode without database dependency.
 * Tests the full simulation and training data generation pipeline.
 *
 * Usage:
 *   bun packages/training/scripts/json-mode-benchmark.ts
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { db, initializeSimulationMode, saveSnapshot } from '@elizaos/engine';
import { generateSnowflakeId } from '@elizaos/shared';
import { BenchmarkDataGenerator } from '../src/benchmark/BenchmarkDataGenerator';
import type { AgentAction } from '../src/benchmark/SimulationEngine';

const OUTPUT_DIR = './benchmark-output';

// Ensure output directory exists
if (!existsSync(OUTPUT_DIR)) {
  mkdirSync(OUTPUT_DIR, { recursive: true });
}

console.log('═══════════════════════════════════════════════════════════════');
console.log('  Babylon JSON Mode Benchmark');
console.log('  No database required - all data stored in JSON');
console.log(
  '═══════════════════════════════════════════════════════════════\n'
);

async function runBenchmark() {
  const startTime = Date.now();

  // Step 1: Initialize JSON storage
  console.log('Step 1: Initializing JSON storage...');
  await initializeSimulationMode(OUTPUT_DIR);

  // Initialize game state
  const gameId = await generateSnowflakeId();
  await db.game.create({
    data: {
      id: gameId,
      currentDay: 1,
      dayStartedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  });
  console.log('  ✅ JSON storage initialized\n');

  // Step 2: Generate benchmark data
  console.log('Step 2: Generating benchmark data...');
  const generator = new BenchmarkDataGenerator({
    durationMinutes: 10,
    tickInterval: 5,
    numPredictionMarkets: 5,
    numPerpetualMarkets: 3,
    numAgents: 5,
    seed: 42, // Fixed seed for reproducibility
  });

  const snapshot = await generator.generate();
  console.log(`  ✅ Generated ${snapshot.ticks.length} ticks`);
  console.log(
    `  Markets: ${snapshot.initialState.predictionMarkets.length} prediction, ${snapshot.initialState.perpetualMarkets.length} perpetual`
  );
  console.log(
    `  Ground truth outcomes: ${Object.keys(snapshot.groundTruth.marketOutcomes).length} markets\n`
  );

  // Save benchmark data to JSON
  const benchmarkPath = join(OUTPUT_DIR, 'benchmark-snapshot.json');
  writeFileSync(benchmarkPath, JSON.stringify(snapshot, null, 2));
  console.log(`  📁 Saved to: ${benchmarkPath}\n`);

  // Step 3: Run simulation for each agent archetype
  console.log('Step 3: Running simulations...');
  const archetypes = ['trader', 'researcher', 'degenerate', 'conservative'];
  const results: Array<{
    archetype: string;
    agentId: string;
    actions: AgentAction[];
    metrics: {
      totalActions: number;
      correctPredictions: number;
      wrongPredictions: number;
      avgResponseTime: number;
      profitableTrades: number;
    };
  }> = [];

  for (const archetype of archetypes) {
    const agentId = `agent-${archetype}-001`;
    console.log(`  Running simulation for ${archetype}...`);

    // Simulate agent actions based on archetype
    const actions = simulateAgentBehavior(archetype, snapshot);

    // Calculate metrics
    const metrics = calculateAgentMetrics(actions);

    results.push({
      archetype,
      agentId,
      actions,
      metrics,
    });

    console.log(
      `    ✅ ${archetype}: ${actions.length} actions, ${metrics.correctPredictions}/${metrics.correctPredictions + metrics.wrongPredictions} correct`
    );
  }
  console.log('');

  // Step 4: Generate training data
  console.log('Step 4: Generating training data...');
  const trainingData = results.map((r) => ({
    agentId: r.agentId,
    archetype: r.archetype,
    trajectory: r.actions.map((a) => ({
      tick: a.tick,
      action: a.type,
      data: a.data,
      reward: calculateReward(a),
    })),
    totalReward: r.actions.reduce((sum, a) => sum + calculateReward(a), 0),
    metrics: r.metrics,
  }));

  const trainingPath = join(OUTPUT_DIR, 'training-data.json');
  writeFileSync(trainingPath, JSON.stringify(trainingData, null, 2));
  console.log(`  ✅ Generated ${trainingData.length} trajectories`);
  console.log(`  📁 Saved to: ${trainingPath}\n`);

  // Step 5: Store results in JSON storage using db interface
  console.log('Step 5: Storing simulation results...');
  for (const result of results) {
    // Store agent as user
    const userId = await generateSnowflakeId();
    await db.user.create({
      data: {
        id: userId,
        username: result.agentId,
        displayName: `${result.archetype} Agent`,
        isAgent: true,
        virtualBalance: '10000',
        totalDeposited: '0',
        reputationPoints: Math.floor(result.metrics.correctPredictions * 100),
        lifetimePnL: String(result.metrics.profitableTrades * 50),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    // Store agent config
    const configId = await generateSnowflakeId();
    await db.userAgentConfig.create({
      data: {
        id: configId,
        userId: userId,
        personality: result.archetype,
        tradingStrategy: `${result.archetype} strategy`,
        autonomousTrading: true,
        autonomousPosting: false,
        autonomousCommenting: false,
        autonomousDMs: false,
        autonomousGroupChats: false,
        a2aEnabled: true,
        modelTier: 'pro',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    // Store sample trades
    for (const action of result.actions.filter(
      (a) => a.type.includes('prediction') || a.type.includes('perp')
    )) {
      const side = action.data.side as string;
      const amount = action.data.amount as number;
      const tradeId = await generateSnowflakeId();
      await db.agentTrade.create({
        data: {
          id: tradeId,
          agentUserId: userId,
          marketType: action.type.includes('perp') ? 'perpetual' : 'prediction',
          action: action.type,
          side,
          amount: String(amount),
          pnl: String(calculateReward(action) > 0 ? 50 : -20),
          createdAt: new Date(),
        },
      });
    }
  }
  console.log(`  ✅ Stored ${results.length} agents with trades\n`);

  // Step 6: Generate benchmark report
  console.log('Step 6: Generating benchmark report...');
  const report = {
    timestamp: new Date().toISOString(),
    duration: Date.now() - startTime,
    config: {
      ticks: snapshot.ticks.length,
      markets:
        snapshot.initialState.predictionMarkets.length +
        snapshot.initialState.perpetualMarkets.length,
      agents: archetypes.length,
    },
    results: results.map((r) => ({
      archetype: r.archetype,
      totalActions: r.metrics.totalActions,
      accuracy:
        (
          (r.metrics.correctPredictions /
            (r.metrics.correctPredictions + r.metrics.wrongPredictions)) *
          100
        ).toFixed(1) + '%',
      avgResponseTime: r.metrics.avgResponseTime.toFixed(2) + 'ms',
      profitableTrades: r.metrics.profitableTrades,
    })),
    rankings: results
      .sort(
        (a, b) => b.metrics.correctPredictions - a.metrics.correctPredictions
      )
      .map(
        (r, i) =>
          `${i + 1}. ${r.archetype} (${r.metrics.correctPredictions} correct)`
      ),
  };

  const reportPath = join(OUTPUT_DIR, 'benchmark-report.json');
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`  📁 Saved to: ${reportPath}\n`);

  // Save final storage state
  await saveSnapshot();

  // Summary
  const totalTime = Date.now() - startTime;
  console.log(
    '═══════════════════════════════════════════════════════════════'
  );
  console.log('  Benchmark Complete');
  console.log(
    '═══════════════════════════════════════════════════════════════'
  );
  console.log(`  Total time: ${(totalTime / 1000).toFixed(1)}s`);
  console.log(`  Ticks processed: ${snapshot.ticks.length}`);
  console.log(`  Agents tested: ${archetypes.length}`);
  console.log(
    `  Total actions: ${results.reduce((sum, r) => sum + r.metrics.totalActions, 0)}`
  );
  console.log('');
  console.log('  Output files:');
  console.log(`    ${benchmarkPath}`);
  console.log(`    ${trainingPath}`);
  console.log(`    ${reportPath}`);
  console.log(`    ${OUTPUT_DIR}/state.json`);
  console.log(
    '═══════════════════════════════════════════════════════════════'
  );

  // Print rankings
  console.log('\n  Rankings by accuracy:');
  for (const ranking of report.rankings) {
    console.log(`    ${ranking}`);
  }

  process.exit(0);
}

/**
 * Simulate agent behavior based on archetype
 */
function simulateAgentBehavior(
  archetype: string,
  snapshot: ReturnType<BenchmarkDataGenerator['generate']> extends Promise<
    infer T
  >
    ? T
    : never
): AgentAction[] {
  const actions: AgentAction[] = [];
  const numTicks = snapshot.ticks.length;

  // Simulate different trading frequencies based on archetype
  const tradingFrequency =
    {
      trader: 0.3, // 30% of ticks
      researcher: 0.1, // 10% of ticks
      degenerate: 0.5, // 50% of ticks
      conservative: 0.05, // 5% of ticks
    }[archetype] ?? 0.2;

  // Simulate different accuracy based on archetype
  const accuracy =
    {
      trader: 0.6,
      researcher: 0.7,
      degenerate: 0.4,
      conservative: 0.65,
    }[archetype] ?? 0.5;

  for (let i = 0; i < numTicks; i++) {
    const tick = snapshot.ticks[i]!;

    // Decide if agent trades this tick
    if (Math.random() < tradingFrequency) {
      const market =
        tick.state.predictionMarkets[
          Math.floor(Math.random() * tick.state.predictionMarkets.length)
        ];
      if (market) {
        const isCorrect = Math.random() < accuracy;
        const actualOutcome =
          snapshot.groundTruth.marketOutcomes[market.id] ?? false;
        const predictedSide = isCorrect
          ? actualOutcome
            ? 'YES'
            : 'NO'
          : actualOutcome
            ? 'NO'
            : 'YES';

        actions.push({
          tick: tick.number,
          timestamp: tick.timestamp,
          type: 'buy_prediction',
          data: {
            marketId: market.id,
            side: predictedSide,
            amount: Math.floor(Math.random() * 500) + 100,
          },
          duration: Math.random() * 100 + 20,
          correctness: {
            predictionCorrect: isCorrect,
            actualOutcome,
            predictedOutcome: predictedSide === 'YES',
          },
        });
      }
    }

    // Occasionally query state
    if (Math.random() < 0.1) {
      actions.push({
        tick: tick.number,
        timestamp: tick.timestamp,
        type: 'query_state',
        data: {},
        duration: Math.random() * 20 + 5,
      });
    }
  }

  return actions;
}

/**
 * Calculate metrics from agent actions
 */
function calculateAgentMetrics(actions: AgentAction[]) {
  const predictions = actions.filter((a) => a.type === 'buy_prediction');
  const correct = predictions.filter(
    (a) => a.correctness?.predictionCorrect
  ).length;
  const wrong = predictions.filter(
    (a) => a.correctness && !a.correctness.predictionCorrect
  ).length;

  return {
    totalActions: actions.length,
    correctPredictions: correct,
    wrongPredictions: wrong,
    avgResponseTime:
      actions.reduce((sum, a) => sum + a.duration, 0) / (actions.length || 1),
    profitableTrades: correct,
  };
}

/**
 * Calculate reward for an action
 */
function calculateReward(action: AgentAction): number {
  if (action.type === 'buy_prediction') {
    return action.correctness?.predictionCorrect ? 10 : -5;
  }
  if (action.type === 'query_state') {
    return 0.1; // Small reward for information gathering
  }
  return 0;
}

// Run the benchmark
void runBenchmark();
