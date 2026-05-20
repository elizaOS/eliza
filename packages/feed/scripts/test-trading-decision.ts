#!/usr/bin/env bun

/**
 * Test what trading decision the LLM makes for an agent
 * Simulates the trading service logic locally
 */

import { callGroqDirect } from '@feed/agents/llm/direct-groq';
import {
  and,
  db,
  desc,
  eq,
  gte,
  isNull,
  markets,
  organizationState,
  perpPositions,
  positions,
  users,
} from '@feed/db';
import {
  formatRandomContext,
  generateRandomMarketContext,
  StaticDataRegistry,
  shuffleArray,
  WalletService,
} from '@feed/engine';

async function testTradingDecision() {
  console.log('🧪 Testing agent trading decision...\n');

  try {
    // Get one of the ticking agents
    const agentUserId = '254299341433339904'; // agent_tcm_agent1_0lyguq

    const agentResult = await db
      .select()
      .from(users)
      .where(eq(users.id, agentUserId))
      .limit(1);

    const agent = agentResult[0];
    if (!agent?.isAgent) {
      throw new Error('Agent not found');
    }

    console.log(`Agent: ${agent.username}`);
    console.log(`Balance: $${agent.virtualBalance}`);
    console.log(`Trading enabled: ${agent.autonomousTrading}`);
    console.log('');

    // Get positions
    const positionsResult = await db
      .select()
      .from(positions)
      .where(
        and(eq(positions.userId, agentUserId), eq(positions.status, 'active'))
      );

    const perpPositionsResult = await db
      .select()
      .from(perpPositions)
      .where(
        and(
          eq(perpPositions.userId, agentUserId),
          isNull(perpPositions.closedAt)
        )
      );

    // Get markets
    const predictionMarkets = await db
      .select()
      .from(markets)
      .where(and(eq(markets.resolved, false), gte(markets.endDate, new Date())))
      .orderBy(desc(markets.createdAt))
      .limit(10);

    // Get perp markets from static registry + dynamic state
    const staticOrgs = StaticDataRegistry.getOrganizationsByType('company');
    const orgStates = await db
      .select()
      .from(organizationState)
      .orderBy(desc(organizationState.currentPrice))
      .limit(10);

    const perpMarkets = staticOrgs
      .map((org) => {
        const state = orgStates.find((s) => s.id === org.id);
        return {
          ...org,
          currentPrice: state?.currentPrice ?? org.initialPrice,
        };
      })
      .slice(0, 10);

    const balance = await WalletService.getBalance(agentUserId);

    console.log(`Prediction Markets: ${predictionMarkets.length}`);
    console.log(`Perp Markets: ${perpMarkets.length}`);
    console.log(
      `Open Positions: ${positionsResult.length + perpPositionsResult.length}`
    );
    console.log('');

    // Shuffle markets
    const shuffledPredictions = shuffleArray(predictionMarkets);
    const shuffledPerps = shuffleArray(perpMarkets);

    // Get market context
    const marketContext = await generateRandomMarketContext({
      includeGainers: true,
      includeLosers: true,
      includeQuestions: true,
      includePosts: false,
      includeEvents: true,
    });
    const contextString = formatRandomContext(marketContext);

    // Build the exact same prompt the trading service uses
    // NOTE: Intentionally omitting agent.agentSystem to avoid strategy conflicts
    const prompt = `You are ${agent.displayName}, an autonomous trading agent.

Your goal: Make profitable trades on available markets

Current Status:
- Balance: $${balance.balance}
- P&L: ${agent.lifetimePnL}
- Open Positions: ${positionsResult.length + perpPositionsResult.length}

Available Prediction Markets:
${shuffledPredictions
  .slice(0, 5)
  .map((m) => `- ${m.question} (YES: ${m.yesShares}, NO: ${m.noShares})`)
  .join('\n')}

Available Perp Markets:
${shuffledPerps
  .slice(0, 5)
  .map((o) => `- ${o.name} @ $${o.currentPrice}`)
  .join('\n')}

Your Open Positions:
${positionsResult.map((p) => `- Prediction: ${p.marketId}, ${p.side ? 'YES' : 'NO'}, ${p.shares} shares`).join('\n') || 'None'}
${perpPositionsResult.map((p) => `- Perp: ${p.ticker}, ${p.side}, $${p.size}, ${p.leverage}x`).join('\n') || 'None'}

You MUST make a trade this tick (unless NO markets listed above).

Trading rules:
- Always trade 10-20% of balance when markets available ($100-$200)
- Pick the most interesting prediction market
- Buy YES unless question seems unlikely, then buy NO
- Trade amounts: $100, $150, or $200

RESPOND WITH JSON ONLY - NO EXPLANATIONS OUTSIDE JSON:
Example TRADE response:
{
  "action": "trade",
  "trade": {
    "type": "prediction",
    "market": "<exact_market_question_text>",
    "action": "buy_yes",
    "amount": 150,
    "reasoning": "Specific reason: [market name], current YES:NO ratio is [X:Y], betting [side] because [specific catalyst/edge/pattern]. Entry at [implied probability]."
  }
}

REASONING MUST INCLUDE:
- Which specific market (name/question)
- Current YES/NO shares showing odds
- Why this side (YES or NO)
- What edge or catalyst you see

Only respond with {"action": "hold"} if literally ZERO markets are available.
${contextString}`;

    console.log('📤 Calling Groq LLM...\n');

    // Call LLM with same parameters as trading service
    const decision = await callGroqDirect({
      prompt,
      system:
        'You are an active trading agent. Trade available markets regardless of your preferred strategy. Respond ONLY with valid JSON, no other text.',
      modelSize: 'small', // Using small = llama-3.1-70b-versatile now
      temperature: 0.3,
      maxTokens: 500,
      actionType: 'evaluate_trading_opportunity',
      purpose: 'action',
    });

    console.log('📥 LLM Response:');
    console.log('='.repeat(80));
    console.log(decision);
    console.log('='.repeat(80));
    console.log('');

    // Strip out <think> tags if present (applying same fix as trading service)
    let cleanedDecision = decision;
    if (decision.includes('<think>')) {
      cleanedDecision = decision
        .replace(/<think>[\s\S]*?<\/think>/g, '')
        .trim();
      console.log('✂️  Stripped <think> tags from response\n');
      console.log('Cleaned response:');
      console.log('='.repeat(80));
      console.log(cleanedDecision);
      console.log('='.repeat(80));
      console.log('');
    }

    // Parse the decision
    const jsonMatch = cleanedDecision.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.log('❌ Failed to extract JSON from response');
      console.log('   Even after stripping <think> tags');
      return;
    }

    const tradeDecision = JSON.parse(jsonMatch[0]);
    console.log('📊 Parsed Decision:');
    console.log(JSON.stringify(tradeDecision, null, 2));
    console.log('');

    if (tradeDecision.action === 'hold' || !tradeDecision.trade) {
      console.log('💤 Agent decided to HOLD (no trade)');
      if (tradeDecision.reasoning) {
        console.log(`   Reason: ${tradeDecision.reasoning}`);
      }
    } else {
      console.log('💰 Agent decided to TRADE!');
      console.log(`   Type: ${tradeDecision.trade.type}`);
      console.log(`   Market: ${tradeDecision.trade.market}`);
      console.log(`   Action: ${tradeDecision.trade.action}`);
      console.log(`   Amount: $${tradeDecision.trade.amount}`);
      console.log(`   Reasoning: ${tradeDecision.trade.reasoning || 'N/A'}`);
    }
  } catch (error) {
    console.error('Error testing trading decision:', error);
    throw error;
  }
}

testTradingDecision()
  .then(() => {
    console.log('\n✅ Test complete');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Test failed:', error);
    process.exit(1);
  });
