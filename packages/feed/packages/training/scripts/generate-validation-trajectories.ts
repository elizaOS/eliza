#!/usr/bin/env bun
/**
 * Generate validation trajectories with all new R1-R7 fields populated.
 * Runs in memory/simulation mode — writes JSON to training-data-output/trajectories/
 */

import { initializeMemoryMode } from '@babylon/db';

// Switch DB to memory mode so TrajectoryRecorder writes JSON files
await initializeMemoryMode();

const { TrajectoryRecorder } = await import(
  '../src/training/TrajectoryRecorder'
);

const ARCHETYPES = [
  'information-trader',
  'social-butterfly',
  'trader',
  'researcher',
];

const GROUP_CHAT_FACTS_POOL = [
  'BTC bullish sentiment spreading in VC Roundup group',
  'ETH merger announcement rumored for next week',
  'SOL breakout signal detected by CryptoCarl',
  'NVDAI stock manipulation warning from insider',
  'TeslAI robotaxi launch delayed per group leak',
  'Polymarket whale moving into YES positions on BitcAIn',
  'Alpha group consensus: bearish on memecoin sector',
  'Research shared: AI chip shortage worsening',
  'Group member warned about phishing links in DMs',
  'New listing rumor for DeepSeekAI token',
  'Insider tip: regulatory filing expected Friday',
  'Social sentiment turning negative on OpenAGI',
];

async function generateTrajectory(
  archetype: string,
  agentIndex: number
): Promise<string> {
  const recorder = new TrajectoryRecorder();
  const agentId = `validate-${archetype}-${agentIndex}`;

  const isGroupChatArchetype = [
    'information-trader',
    'social-butterfly',
  ].includes(archetype);
  const tickCount = 8 + Math.floor(Math.random() * 5);
  const startBalance = 10000;

  const trajId = await recorder.startTrajectory({
    agentId,
    archetype,
    metadata: { validation: true, generatedAt: new Date().toISOString() },
  });

  let balance = startBalance;
  let pnl = 0;

  for (let tick = 0; tick < tickCount; tick++) {
    const tradeAmount = 50 + Math.random() * 150;
    const tradeResult = (Math.random() - 0.4) * tradeAmount;
    pnl += tradeResult;
    balance += tradeResult;

    // Group chat data — active for social archetypes, sparse for others
    const hasGroupChat =
      isGroupChatArchetype || (tick % 3 === 0 && Math.random() > 0.5);
    const factCount = hasGroupChat
      ? Math.min(tick + 1, 3 + Math.floor(Math.random() * 3))
      : 0;
    const facts = GROUP_CHAT_FACTS_POOL.slice(0, factCount);
    const gcTokens = hasGroupChat ? 300 + Math.floor(Math.random() * 300) : 0;

    // Token budget
    const baseTokens = 2500 + Math.floor(Math.random() * 1500);
    const totalTokens = baseTokens + gcTokens;

    // Working memory — accumulates over time
    const wmFactCount = isGroupChatArchetype
      ? Math.min(tick + 2, 8)
      : Math.min(tick, 3);
    const wmThesis =
      tick > 2 && isGroupChatArchetype
        ? 'BTC uptrend driven by institutional group alpha'
        : tick > 4
          ? 'Market neutral, waiting for catalyst'
          : undefined;

    const stepId = recorder.startStep(trajId, {
      agentBalance: balance,
      agentPnL: pnl,
      openPositions: 1 + Math.floor(Math.random() * 3),
      groupChatsActive: hasGroupChat ? 1 + Math.floor(Math.random() * 3) : 0,
      groupChatFacts: hasGroupChat ? facts : undefined,
      groupChatIntelTokenEstimate: gcTokens || undefined,
      promptTokenEstimate: totalTokens,
      contextBreakdown: {
        system: 800,
        markets: 1000 + Math.floor(Math.random() * 500),
        positions: 300 + Math.floor(Math.random() * 200),
        groupChat: gcTokens,
        pending: Math.floor(Math.random() * 200),
        actionSchemas: 400,
      },
      workingMemoryFactCount: wmFactCount,
      workingMemoryActiveThesis: wmThesis,
    });

    recorder.logLLMCall(trajId, {
      model: 'qwen2.5-1.5b',
      systemPrompt: `You are a ${archetype} agent on Babylon prediction markets.`,
      userPrompt: `Step ${tick}: Decide your next action based on market data and group chat intel.`,
      response: JSON.stringify({
        thought: `Based on group intel: ${facts[0] || 'no intel'}. Taking position.`,
        action: Math.random() > 0.3 ? 'TRADE' : 'GROUP_MESSAGE',
        parameters: {
          marketId: `mkt-${tick}`,
          amount: Math.round(tradeAmount),
        },
      }),
      temperature: 0.7,
      maxTokens: 200,
      purpose: 'action' as const,
      actionType: 'trade',
    });

    const actionType =
      hasGroupChat && tick % 2 === 0 ? 'GROUP_MESSAGE' : 'BUY_YES';
    recorder.completeStep(
      trajId,
      stepId,
      {
        actionType,
        parameters: {
          marketId: `mkt-${tick}`,
          amount: Math.round(tradeAmount),
        },
        success: Math.random() > 0.15,
        result: { positionId: `pos-${tick}` },
      },
      { reward: 0.05 + Math.random() * 0.15 }
    );
  }

  await recorder.endTrajectory(trajId, {
    finalBalance: balance,
    finalPnL: pnl,
  });

  return trajId;
}

async function main() {
  console.log('Generating validation trajectories...\n');

  const results: Array<{ archetype: string; id: string }> = [];
  for (const archetype of ARCHETYPES) {
    for (let i = 0; i < 3; i++) {
      const id = await generateTrajectory(archetype, i);
      results.push({ archetype, id });
      console.log(`  ✅ ${archetype} #${i}: ${id}`);
    }
  }

  console.log(`\nGenerated ${results.length} trajectories`);
  console.log(
    'Output: packages/training/training-data-output/trajectories/*.json'
  );
}

main().catch(console.error);
