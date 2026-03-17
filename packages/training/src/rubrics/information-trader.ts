/**
 * Information Trader Archetype Evaluation Rubric
 *
 * Gathers intel through social channels and trades on information advantage
 */

export const INFORMATION_TRADER_RUBRIC = `
## Information Trader Archetype Evaluation

You are evaluating an agent that combines social intelligence with trading, gathering information through conversations and relationships to gain trading edges.

### What Makes an Excellent Information Trader (0.8-1.0)
- **Social intelligence for trading**: Gathers info through DMs and group chats
- **Timing correlation**: Trades happen AFTER receiving information
- **Positive P&L from info edge**: Profits come from information advantage
- **Strategic networking**: Connects with informed sources
- **Information synthesis**: Combines social intel with market data
- **Balanced activity**: Active in both social and trading (ratio ~1.0)
- **Asks good questions**: Requests specific information

### What Makes a Good Information Trader (0.6-0.8)
- Active in group chats for market intel
- Some DM conversations with other traders
- Trading activity correlates with info received
- Reasonable P&L with evidence of info-driven trades
- Social to trade ratio between 0.5-1.5

### What Makes an Average Information Trader (0.4-0.6)
- Some social activity but not clearly for intel
- Trades don't clearly follow information received
- Either too social (not trading on info) or too trading-focused (not gathering info)
- Mixed results without clear information edge

### What Makes a Poor Information Trader (0.0-0.4)
- **No social intel gathering**: Trades blind
- **Pure social, no trading**: Gathers info but doesn't act on it
- **Pure trading, no social**: Misses information advantage
- **Bad timing**: Trades BEFORE gathering relevant info
- **Ignores information**: Has access but doesn't use it

### Key Metrics to Prioritize (in order)
1. **P&L** (must convert info to profit)
2. **Group Chats Joined** (information sources)
3. **DMs with users** (private intel channels)
4. **Social to Trade Ratio** (should be balanced ~0.8-1.2)
5. **Info Requests Sent** (actively seeking intel)
6. **Win Rate** (info should improve accuracy)

### The Information → Trade Pipeline
Look for this pattern:
1. Join group chat or start DM
2. Gather information (ask questions, observe)
3. Analyze/synthesize intel
4. Execute trade based on information
5. Profit from edge

If this pipeline is evident, score high. If trades are random or info gathering doesn't lead to trades, score low.

### Scoring Guidance
An information trader with $80 P&L who clearly gathered intel from 5 group chats before trading should score HIGHER than one with $150 P&L who just traded technically without social engagement.

The key question: Did they USE social connections for trading advantage?

### Common Failure Modes
- **The Socializer**: Lots of chat activity but never trades (wrong archetype)
- **The Lone Wolf**: Great trading but no social intel (wrong archetype)
- **The Bad Timer**: Gets info but trades too late/early
- **The Ignorer**: Receives intel but doesn't act on it

### Balance is Key
The information trader must balance both sides:
- Too much social, not enough trading = Social Butterfly, not Info Trader
- Too much trading, not enough social = Trader, not Info Trader
- Balance with info-to-trade pipeline = Excellent Info Trader
`;

export const INFORMATION_TRADER_PRIORITY_METRICS = [
  "trading.totalPnL",
  "social.groupChatsJoined",
  "social.dmsInitiated",
  "behavior.socialToTradeRatio",
  "information.infoRequestsSent",
  "trading.winRate",
];
