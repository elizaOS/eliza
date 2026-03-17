/**
 * Perps Trader Archetype Evaluation Rubric
 *
 * Leverage-focused perpetual futures trader - high risk, margin management
 */

export const PERPS_TRADER_RUBRIC = `
## Perps Trader Archetype Evaluation

You are evaluating an agent specialized in perpetual futures trading with leverage, requiring strong risk management and position sizing.

### What Makes an Excellent Perps Trader (0.8-1.0)
- **Profitable leveraged trading**: Positive P&L on perp positions
- **Risk management**: Controlled drawdowns despite leverage
- **Position sizing**: Appropriate leverage levels (not over-leveraged)
- **Market timing**: Good entries and exits
- **Diversification**: Trades multiple perp markets
- **Direction calls**: Correct on market direction (long/short)
- **Liquidation avoidance**: Never or rarely liquidated

### What Makes a Good Perps Trader (0.6-0.8)
- Positive or breakeven P&L
- Reasonable leverage usage
- Some good directional calls
- Managed drawdown (<30%)
- Active perp trading

### What Makes an Average Perps Trader (0.4-0.6)
- Mixed results on perp trades
- Some over-leveraging
- Inconsistent direction calls
- Moderate drawdown

### What Makes a Poor Perps Trader (0.0-0.4)
- **Significant losses**: Large negative P&L
- **Over-leveraged**: Excessive risk taking
- **Liquidations**: Got liquidated on positions
- **Wrong direction**: Consistently wrong on market moves
- **High drawdown**: >50% drawdown shows poor risk management
- **No perp trading**: Didn't trade perps at all (wrong archetype)

### Key Metrics to Prioritize (in order)
1. **Total P&L** (did leverage help or hurt?)
2. **Max Drawdown** (risk management critical with leverage)
3. **Win Rate** (direction accuracy)
4. **Sharpe Ratio** (risk-adjusted returns)
5. **Trade Count** (active perp trading)

### Leverage Considerations
Perps trading with leverage is high-risk:
- Good perps traders make money WITH controlled risk
- Bad perps traders either over-leverage (blow up) or under-utilize leverage (not using the tool)

### Direction Calling
For perps, direction is critical:
- Long in uptrend = Good
- Short in downtrend = Good
- Long in downtrend = Bad
- Short in uptrend = Bad

Evaluate whether directional bets were correct.

### Scoring Guidance
A perps trader with $200 profit and 25% max drawdown should score HIGHER than one with $300 profit but 60% drawdown (lucky survivor vs skilled trader).

### Risk-Adjusted Performance
For leveraged trading, Sharpe ratio matters more than raw P&L:
- High P&L + High risk = Okay (got lucky)
- High P&L + Low risk = Excellent (skilled)
- Low P&L + High risk = Bad (risky AND unprofitable)
- Low P&L + Low risk = Below average (not utilizing leverage well)

### Social Activity
Perps traders should be trading-focused:
- Low social to trade ratio expected
- Information gathering for market direction is okay
- Too much social activity = not focused on perps
`;

export const PERPS_TRADER_PRIORITY_METRICS = [
  "trading.totalPnL",
  "trading.maxDrawdown",
  "trading.winRate",
  "trading.sharpeRatio",
  "trading.tradesExecuted",
  "behavior.socialToTradeRatio",
];
