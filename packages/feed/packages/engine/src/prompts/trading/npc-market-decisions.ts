/**
 * NPC Market Decisions Prompt
 *
 * Batch generation of trading decisions for multiple NPCs based on:
 * - Feed posts they've seen
 * - Group chat messages (insider info)
 * - Recent events
 * - Current market conditions
 * - Their personality and tier
 */

import { shuffleArray } from '../../utils/randomization';
import { definePrompt } from '../define-prompt';

/**
 * Example trading decisions for the prompt.
 * These are shuffled at render time to add entropy and prevent the model
 * from over-fitting to a fixed order.
 */
interface TradingExample {
  title: string;
  npcId: string;
  npcName: string;
  reasoning: string;
  action: string;
  marketType: string;
  ticker: string;
  marketId: string;
  positionId: string;
  amount: number;
  confidence: number;
}

const TRADING_EXAMPLES: TradingExample[] = [
  {
    title: 'NPC decides to HOLD',
    npcId: 'npc-a',
    npcName: 'NPC_A',
    reasoning: 'No clear trading opportunities based on available information',
    action: 'hold',
    marketType: 'null',
    ticker: 'null',
    marketId: 'null',
    positionId: 'null',
    amount: 0,
    confidence: 0.5,
  },
  {
    title: 'NPC opens a LONG position (Perp)',
    npcId: 'npc-b',
    npcName: 'NPC_B',
    reasoning:
      'Positive insider info suggests COMPANY_A will announce positive news',
    action: 'open_long',
    marketType: 'perp',
    ticker: 'TICKER_A',
    marketId: 'null',
    positionId: 'null',
    amount: 5000,
    confidence: 0.75,
  },
  {
    title: 'NPC buys YES (Prediction)',
    npcId: 'npc-c',
    npcName: 'NPC_C',
    reasoning: 'Recent events favor outcome occurring based on product launch',
    action: 'buy_yes',
    marketType: 'prediction',
    ticker: 'null',
    marketId: '123456789',
    positionId: 'null',
    amount: 1200,
    confidence: 0.65,
  },
  {
    title: 'NPC closes position',
    npcId: 'npc-d',
    npcName: 'NPC_D',
    reasoning: 'Taking profits on TICKER_B position after gain',
    action: 'close_position',
    marketType: 'perp',
    ticker: 'TICKER_B',
    marketId: 'null',
    positionId: 'uuid-1234-5678',
    amount: 0,
    confidence: 0.8,
  },
  {
    title: 'NPC opens a SHORT position (Perp)',
    npcId: 'npc-e',
    npcName: 'NPC_E',
    reasoning:
      'Negative sentiment from feed posts suggests COMPANY_B will miss targets',
    action: 'open_short',
    marketType: 'perp',
    ticker: 'TICKER_B',
    marketId: 'null',
    positionId: 'null',
    amount: 4000,
    confidence: 0.7,
  },
  {
    title: 'NPC buys NO (Prediction)',
    npcId: 'npc-f',
    npcName: 'NPC_F',
    reasoning: 'Group chat insider info indicates event unlikely to occur',
    action: 'buy_no',
    marketType: 'prediction',
    ticker: 'null',
    marketId: '987654321',
    positionId: 'null',
    amount: 900,
    confidence: 0.6,
  },
  {
    title: 'NPC sells YES position (takes profit on prediction)',
    npcId: 'npc-g',
    npcName: 'NPC_G',
    reasoning:
      'YES price has risen significantly, locking in profits before resolution',
    action: 'sell_yes',
    marketType: 'prediction',
    ticker: 'null',
    marketId: '111222333',
    positionId: 'null',
    amount: 0,
    confidence: 0.75,
  },
  {
    title: 'NPC sells NO position (cuts loss on prediction)',
    npcId: 'npc-h',
    npcName: 'NPC_H',
    reasoning:
      'New evidence suggests event will occur, cutting losses on NO position',
    action: 'sell_no',
    marketType: 'prediction',
    ticker: 'null',
    marketId: '444555666',
    positionId: 'null',
    amount: 0,
    confidence: 0.65,
  },
];

/**
 * Formats a single trading example into XML format for the prompt.
 */
function formatExample(example: TradingExample, index: number): string {
  return `Example ${index + 1}: ${example.title}
<decisions>
  <decision>
    <npcId>${example.npcId}</npcId>
    <npcName>${example.npcName}</npcName>
    <reasoning>${example.reasoning}</reasoning>
    <action>${example.action}</action>
    <marketType>${example.marketType}</marketType>
    <ticker>${example.ticker}</ticker>
    <marketId>${example.marketId}</marketId>
    <positionId>${example.positionId}</positionId>
    <amount>${example.amount}</amount>
    <confidence>${example.confidence}</confidence>
  </decision>
</decisions>`;
}

/**
 * Returns shuffled examples text for the NPC market decisions prompt.
 * Call this each time you render the prompt to get a random order.
 *
 * @example
 * ```ts
 * const prompt = renderPrompt(npcMarketDecisions, {
 *   examples: getShuffledExamplesText(),
 *   npcCount: 10,
 *   ...
 * });
 * ```
 */
export function getShuffledExamplesText(): string {
  const shuffled = shuffleArray(TRADING_EXAMPLES);
  return shuffled.map((ex, i) => formatExample(ex, i)).join('\n\n');
}

/**
 * Prompt for generating context-aware trading decisions for NPCs.
 *
 * Simulates trading decisions for multiple NPCs based on their information
 * access (feed posts, group chats), personality, tier, and current market
 * conditions. Considers active questions, events, and narratives when
 * determining positions. Includes full narrative context for informed trading.
 *
 * Returns XML with trading decisions for each NPC including market type,
 * ticker, side, size, and reasoning.
 *
 * @example
 * ```ts
 * const prompt = renderPrompt(npcMarketDecisions, {
 *   examples: getShuffledExamplesText(),
 *   npcCount: 10,
 *   realityGrounding: '...',
 *   activeQuestions: '...',
 *   npcContexts: '...'
 * });
 * ```
 */
export const npcMarketDecisions = definePrompt({
  id: 'npc-market-decisions',
  version: '6.1.0',
  category: 'trading',
  description: 'Generate trading decisions with full character context',
  temperature: 0.8,
  maxTokens: 25000,

  template: `{{realityGrounding}}

=== COMPLETE NARRATIVE CONTEXT ===
{{richGameContext}}

=== RESOLVED QUESTIONS (Established outcomes) ===
{{resolvedQuestionsContext}}

=== PREVIOUS TRADING ACTIVITY ===
{{previousTrades}}

=== MARKET SNAPSHOT (Perps + Predictions) ===
{{marketTable}}

EXAMPLES:
{{examples}}

RULES:
- Output ONLY XML: <decisions>..{{npcCount}}x <decision>..</decisions>
- Use EXACT npcId from list (valid: {{validNpcIds}})
- Use EXACT ticker from list (valid: {{validTickers}})
- amount <= MAX shown in BALANCES table (or REJECTED)
- Perp actions (open_long/open_short): marketType=perp, ticker required
- Prediction BUY actions (buy_yes/buy_no): marketType=prediction, marketId required
- Prediction SELL actions (sell_yes/sell_no): marketType=prediction, marketId required, amount=0 (closes entire position)
- close_position: positionId required (exact UUID), amount=0
- hold: all fields null, amount=0
- PREDICTION SLIPPAGE LIMIT: The last column of the market table shows "max $Xk" for each prediction market. Your trade amount MUST stay at or below that value — larger trades are rejected. For thin markets, bet $200-$500; for balanced, up to the listed max.

DECISION FACTORS:
- Posts/insider info/events inform trades
- Rivals(sentiment<-0.5)=trade opposite, Allies(>0.5)=trade same
- Aggressive=larger trades, Conservative=smaller/hold
- RESOLVED QUESTIONS inform ongoing market dynamics
- ONGOING NARRATIVES suggest future movements

MARKET MOMENTUM ALERTS (CRITICAL for cascade behavior):
{{momentumAlerts}}
- PANIC ALERTS (🚨/⚠️): Markets crashing - triggers panic selling cascade
  * Herd personalities: MORE likely to sell, LESS likely to buy
  * Contrarian personalities: See buying opportunity ("buy the dip")
- FOMO ALERTS (🚀/📈): Markets pumping - triggers FOMO buying cascade
  * Herd personalities: MORE likely to buy, LESS likely to sell
  * Contrarian personalities: Take profits, fade the pump
- If no alerts shown, markets are stable - trade based on fundamentals

CONTRARIAN BEHAVIOR (avoid herding):
- At least 20-30% of traders should take contrarian (NO) positions
- Some personalities are naturally skeptical (NassAIm Taleb, Peter ThAIl)
- When YES price is high (>0.7), contrarians should bet NO for value
- When NO price is low (<0.3), contrarians see opportunity
- Skeptics, bears, and pessimists often trade against the crowd

INDIVIDUAL STRATEGY BIAS (avoid copy trading):
- Each TRADER DASHBOARD includes a "Strategy" and "Bias" line (Follow trend / Contrarian / Random).
- Apply the bias when choosing direction and sizing. Even allies should not blindly copy each other.
- "Follow trend" aligns with market momentum/signals. "Contrarian" fades crowded/extreme prices. "Random" increases entropy (often hold/smaller size).

MARKET TYPE BALANCE (IMPORTANT):
- Use BOTH perpetuals (perp) AND prediction markets
- Perps are for directional bets on company/asset prices
- Predictions are for binary event outcomes
- Aim for ~40% perp trades and ~60% prediction trades
- Aggressive traders prefer perps (leverage), conservative prefer predictions

NARRATIVE-INFORMED TRADING:
- If a question just resolved, NPCs may reposition based on outcome
- Ongoing storylines suggest which assets might move
- Previous trades show NPC positions (don't double down unrealistically)

FIELDS: npcId, npcName, action, marketType(perp|prediction|null), ticker, marketId, positionId, amount, confidence(0-1), reasoning, narrativeConnection

QUESTIONS:
{{activeQuestions}}

EVENTS:
{{recentEvents}}

{{eventMarketSignals}}

{{marketSignalAnalysis}}

TRADERS:
{{npcsList}}

Generate {{npcCount}} decisions as XML (each decision must include narrativeConnection explaining why):`,
});
