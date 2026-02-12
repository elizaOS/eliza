#!/usr/bin/env bun
/**
 * Real Archetype Benchmark
 *
 * Queries actual agent data from the Babylon database.
 *
 * Usage:
 *   bun run packages/training/scripts/real-archetype-benchmark.ts
 */

import {
  agentPerformanceMetrics,
  and,
  db,
  desc,
  eq,
  isNull,
  poolPositions,
  users,
} from '@elizaos/db';
import { ArchetypeConfigService } from '../src/archetypes/ArchetypeConfigService';

// Get the available archetypes from our actual config
const ARCHETYPES = ArchetypeConfigService.getAvailableArchetypes();

interface RealAgentMetrics {
  agentId: string;
  agentName: string;
  archetype: string;
  lifetimePnL: number;
  totalTrades: number;
  winRate: number;
  openPositions: number;
  reputationPoints: number;
}

async function main() {
  console.log(
    '═══════════════════════════════════════════════════════════════'
  );
  console.log('  Babylon Real Archetype Benchmark');
  console.log('  Using ACTUAL data from the game engine');
  console.log(
    '═══════════════════════════════════════════════════════════════\n'
  );

  console.log('Fetching real agent data from database...');

  // Get all agents - use select() without specifying columns
  const agents = await db
    .select()
    .from(users)
    .where(eq(users.isAgent, true))
    .orderBy(desc(users.reputationPoints))
    .limit(100);

  console.log(`Found ${agents.length} agents in database`);

  if (agents.length === 0) {
    console.log('\n⚠️  No agents found in database.');
    console.log('   To generate real benchmark data:');
    console.log('   1. Run the game with agents: bun run dev');
    console.log('   2. Create agents with archetypes');
    console.log('   3. Let them trade for a while');
    console.log('   4. Re-run this benchmark\n');
    return;
  }

  const results: RealAgentMetrics[] = [];

  for (const agent of agents) {
    // Get performance metrics for this agent
    const performanceMetricsList = await db
      .select()
      .from(agentPerformanceMetrics)
      .where(eq(agentPerformanceMetrics.userId, agent.id))
      .limit(1);

    const performanceMetrics = performanceMetricsList[0];

    // Get open positions count
    const openPositionsList = await db
      .select()
      .from(poolPositions)
      .where(
        and(eq(poolPositions.userId, agent.id), isNull(poolPositions.closedAt))
      );

    // Infer archetype from username/displayName
    const agentName = agent.displayName || agent.username || 'Unknown';
    let archetype = 'default';
    const lowerName = agentName.toLowerCase();
    for (const a of ARCHETYPES) {
      if (
        lowerName.includes(a.replace('-', '').toLowerCase()) ||
        lowerName.includes(a.replace('-', ' ').toLowerCase())
      ) {
        archetype = a;
        break;
      }
    }

    results.push({
      agentId: agent.id,
      agentName,
      archetype,
      lifetimePnL: Number(agent.lifetimePnL) || 0,
      totalTrades: performanceMetrics?.totalTrades || 0,
      winRate: performanceMetrics?.winRate || 0,
      openPositions: openPositionsList.length,
      reputationPoints: agent.reputationPoints || 0,
    });
  }

  console.log(`\nProcessed ${results.length} agents\n`);

  // Group by archetype
  const grouped = new Map<string, RealAgentMetrics[]>();
  for (const agent of results) {
    const existing = grouped.get(agent.archetype) || [];
    existing.push(agent);
    grouped.set(agent.archetype, existing);
  }

  // Print summary
  console.log('Archetype Performance Summary:');
  console.log('─'.repeat(70));
  console.log(
    'Archetype            | Agents | Avg PnL      | Win Rate | Reputation'
  );
  console.log('─'.repeat(70));

  const benchmarkResults: Array<{
    archetype: string;
    count: number;
    avgPnL: number;
    avgWinRate: number;
    avgReputation: number;
  }> = [];

  for (const [archetype, agentsList] of grouped) {
    const count = agentsList.length;
    const avgPnL =
      count > 0
        ? agentsList.reduce((sum, a) => sum + a.lifetimePnL, 0) / count
        : 0;
    const avgWinRate =
      count > 0 ? agentsList.reduce((sum, a) => sum + a.winRate, 0) / count : 0;
    const avgReputation =
      count > 0
        ? agentsList.reduce((sum, a) => sum + a.reputationPoints, 0) / count
        : 0;

    benchmarkResults.push({
      archetype,
      count,
      avgPnL,
      avgWinRate,
      avgReputation,
    });
  }

  benchmarkResults.sort((a, b) => b.avgPnL - a.avgPnL);

  for (const r of benchmarkResults) {
    console.log(
      `${r.archetype.padEnd(20)} | ` +
        `${r.count.toString().padStart(6)} | ` +
        `$${r.avgPnL.toFixed(2).padStart(11)} | ` +
        `${(r.avgWinRate * 100).toFixed(1).padStart(7)}% | ` +
        `${r.avgReputation.toFixed(0).padStart(10)}`
    );
  }

  console.log('─'.repeat(70));

  // Save report
  const { mkdirSync, writeFileSync } = await import('fs');
  const outputDir = './research-output/real-benchmarks';
  mkdirSync(outputDir, { recursive: true });

  const report = `# Babylon Real Archetype Benchmark

Generated: ${new Date().toISOString()}

## Agents: ${results.length}

| Archetype | Count | Avg PnL | Win Rate | Reputation |
|-----------|-------|---------|----------|------------|
${benchmarkResults
  .map(
    (r) =>
      `| ${r.archetype} | ${r.count} | $${r.avgPnL.toFixed(2)} | ${(r.avgWinRate * 100).toFixed(1)}% | ${r.avgReputation.toFixed(0)} |`
  )
  .join('\n')}
`;

  const reportPath = `${outputDir}/benchmark-${Date.now()}.md`;
  writeFileSync(reportPath, report);

  console.log(`\n✓ Report saved to: ${reportPath}`);
  console.log(
    '═══════════════════════════════════════════════════════════════'
  );
}

main().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
