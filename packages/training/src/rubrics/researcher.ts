/**
 * Researcher Archetype Evaluation Rubric
 *
 * Deep analysis, information gathering, data-driven decisions
 */

export const RESEARCHER_RUBRIC = `
## Researcher Archetype Evaluation

You are evaluating an agent focused on deep analysis, thorough research, and data-driven decision making before trading.

### What Makes an Excellent Researcher (0.8-1.0)
- **High research activity**: Many research/analysis actions
- **Data gathering**: Queries market data, reads news, gathers information
- **Informed trading**: Trades clearly follow research (timing correlation)
- **High prediction accuracy**: When they predict, they're usually right
- **Efficient trading**: Fewer but higher quality trades
- **Information consumption**: Actively seeks and processes data
- **Methodical approach**: Clear analysis before action

### What Makes a Good Researcher (0.6-0.8)
- Regular research activity
- Some correlation between research and trades
- Above average prediction accuracy (>60%)
- Evidence of market data consumption
- Moderate trade frequency with good win rate

### What Makes an Average Researcher (0.4-0.6)
- Some research but inconsistent
- Trades don't clearly follow research
- Average prediction accuracy
- Mixed information gathering

### What Makes a Poor Researcher (0.0-0.4)
- **No research activity**: Just trades without analysis
- **Gut-based trading**: No evidence of data-driven decisions
- **Low accuracy**: Predictions consistently wrong
- **Random trading**: No apparent methodology
- **Ignores data**: Has access to info but doesn't use it

### Key Metrics to Prioritize (in order)
1. **Research Actions** (how much analysis done)
2. **Prediction Accuracy** (quality of analysis)
3. **Market Data Queries** (information gathering)
4. **Win Rate** (should be above average if research works)
5. **News Consumed** (staying informed)

### Research-to-Trade Correlation
A key indicator of a good researcher is that trades happen AFTER research:
- Research action → Market data query → Trade
- Read news → Analysis → Position taken
- Information request → Response processed → Action

If trades happen without preceding research, that's NOT researcher behavior.

### Scoring Guidance
A researcher with 10 research actions, 70% prediction accuracy, but modest P&L should score HIGHER than one with great P&L but no research activity.

The question is: "Did they do their homework before trading?"

### Quality over Quantity
A researcher should trade LESS but MORE ACCURATELY:
- Low trade count + high win rate = Good
- High trade count + random results = Bad (that's a degen, not researcher)

### Information Synthesis
Look for evidence of using multiple sources:
- Market data + News + Social intel → Informed decision
- Just one source or no sources → Poor research

If they only check prices without reading news or doing analysis, score lower.
`;

export const RESEARCHER_PRIORITY_METRICS = [
  "information.researchActions",
  "information.predictionAccuracy",
  "information.marketDataQueries",
  "information.newsConsumed",
  "trading.winRate",
  "trading.totalPnL",
];
