/**
 * Auto-generated prompt templates
 * DO NOT EDIT - Generated from ../../../../../prompts/*.txt
 *
 * These prompts use Handlebars-style template syntax:
 * - {{variableName}} for simple substitution
 * - {{#each items}}...{{/each}} for iteration
 * - {{#if condition}}...{{/if}} for conditionals
 */

export const analyzeTrendingTokensTemplate = `You are an expert cryptocurrency analyst evaluating trending tokens for potential trading opportunities.

# Trending Tokens Data
{{trendingTokens}}

# Current Portfolio
{{currentPortfolio}}

# Market Conditions
{{marketConditions}}

# Previous Picks and Their Performance
{{previousPicks}}

Analyze each trending token and rank them by trading opportunity. Consider:

1. **Momentum Indicators**
   - Price change (1h, 4h, 24h)
   - Volume trends and unusual activity
   - Market cap growth rate

2. **Liquidity Analysis**
   - Available liquidity vs trade size
   - Bid/ask spread implications
   - DEX pool health

3. **Risk Factors**
   - Token age and history
   - Holder concentration
   - Contract security (if available)
   - Social sentiment signals

4. **Technical Signals**
   - Support and resistance levels
   - RSI, MACD patterns
   - Volume profile

Provide your analysis in this JSON format:

\`\`\`json
{
  "marketAssessment": "brief overall market assessment",
  "topOpportunities": [
    {
      "rank": 1,
      "tokenAddress": "contract address",
      "tokenSymbol": "symbol",
      "opportunityScore": 0-100,
      "riskScore": 0-100,
      "recommendedAction": "BUY" | "WATCH" | "AVOID",
      "suggestedAllocation": "percentage of available capital (1-15%)",
      "reasoning": "detailed reasoning",
      "keyMetrics": {
        "price": "current price",
        "priceChange24h": "percentage",
        "volume24h": "in USD",
        "liquidity": "in USD",
        "marketCap": "in USD"
      },
      "exitTargets": {
        "stopLoss": "price or percentage",
        "takeProfit": "price or percentage",
        "timeframe": "expected hold time"
      }
    }
  ],
  "tokensToAvoid": [
    {
      "tokenAddress": "contract address",
      "tokenSymbol": "symbol", 
      "reason": "why to avoid"
    }
  ],
  "overallRecommendation": "summary of recommended actions"
}
\`\`\`

Be conservative with opportunity scores - only give >80 to exceptional setups with strong confluence.
Risk scores should reflect actual downside potential.
Never recommend more than 15% allocation to any single token.

Respond ONLY with the JSON object.`;

export const ANALYZE_TRENDING_TOKENS_TEMPLATE = analyzeTrendingTokensTemplate;

export const backtestAnalysisTemplate = `You are analyzing backtest results for a trading strategy.

# Strategy Configuration
{{strategyConfig}}

# Backtest Parameters
- Start Date: {{startDate}}
- End Date: {{endDate}}
- Initial Capital: {{initialCapital}}
- Trading Pair(s): {{tradingPairs}}

# Trade History
{{tradeHistory}}

# Performance Metrics
{{performanceMetrics}}

# Equity Curve Data
{{equityCurve}}

Provide a comprehensive backtest analysis:

\`\`\`json
{
  "overallAssessment": {
    "grade": "A" | "B" | "C" | "D" | "F",
    "viable": true | false,
    "confidence": 0-100,
    "summary": "brief overall assessment"
  },
  
  "performanceAnalysis": {
    "totalReturn": "percentage return",
    "annualizedReturn": "annualized percentage",
    "maxDrawdown": "maximum drawdown percentage",
    "maxDrawdownDuration": "longest drawdown period",
    "sharpeRatio": "risk-adjusted return",
    "sortinoRatio": "downside risk-adjusted return",
    "calmarRatio": "return / max drawdown",
    "profitFactor": "gross profit / gross loss"
  },
  
  "tradeAnalysis": {
    "totalTrades": "number of trades",
    "winRate": "percentage of winners",
    "averageWin": "average winning trade",
    "averageLoss": "average losing trade",
    "largestWin": "biggest winner",
    "largestLoss": "biggest loser",
    "averageHoldTime": "average position duration",
    "tradesPerDay": "average trades per day"
  },
  
  "riskAnalysis": {
    "volatility": "strategy volatility",
    "downsideVolatility": "negative return volatility",
    "valueAtRisk": "95% VaR estimate",
    "expectedShortfall": "average loss beyond VaR",
    "consecutiveLosses": "max consecutive losing trades",
    "recoveryTime": "average time to recover from drawdowns"
  },
  
  "marketConditionPerformance": {
    "bullMarket": {
      "return": "performance in uptrends",
      "winRate": "win rate in uptrends"
    },
    "bearMarket": {
      "return": "performance in downtrends",
      "winRate": "win rate in downtrends"
    },
    "sideways": {
      "return": "performance in ranging markets",
      "winRate": "win rate in ranging markets"
    }
  },
  
  "strengthsAndWeaknesses": {
    "strengths": ["what the strategy does well"],
    "weaknesses": ["areas of concern"],
    "biases": ["any biases detected in results"]
  },
  
  "optimizationSuggestions": [
    {
      "parameter": "which parameter to adjust",
      "currentValue": "current setting",
      "suggestedValue": "recommended setting",
      "expectedImprovement": "what improvement expected",
      "tradeoff": "any tradeoffs to consider"
    }
  ],
  
  "forwardTestingRecommendations": {
    "recommended": true | false,
    "suggestedCapital": "recommended starting capital",
    "suggestedDuration": "how long to paper trade",
    "keyMetricsToMonitor": ["what to watch during forward test"],
    "stopCriteria": "when to stop if underperforming"
  },
  
  "caveats": [
    "important limitations of this backtest",
    "factors not accounted for",
    "why live performance may differ"
  ],
  
  "conclusion": "detailed conclusion with specific recommendations"
}
\`\`\`

Be skeptical of overfitted results - look for signs of curve fitting.
Account for transaction costs, slippage, and realistic execution.
Compare against buy-and-hold benchmark.

Respond ONLY with the JSON object.`;

export const BACKTEST_ANALYSIS_TEMPLATE = backtestAnalysisTemplate;

export const executeSwapTemplate = `Execute a token swap on Solana using Jupiter aggregator.

User Request: {{userRequest}}

Current Wallet State:
{{walletState}}

Extract swap parameters from the request:

\`\`\`json
{
  "inputToken": {
    "address": "token contract address or 'SOL' for native SOL",
    "symbol": "token symbol",
    "amount": "amount to swap (in token units)"
  },
  "outputToken": {
    "address": "token contract address or 'SOL' for native SOL",
    "symbol": "token symbol"
  },
  "slippageBps": "slippage tolerance in basis points (100 = 1%)",
  "urgency": "LOW" | "MEDIUM" | "HIGH"
}
\`\`\`

Common token addresses:
- SOL: So11111111111111111111111111111111111111112
- USDC: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
- USDT: Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB

If the user specifies a symbol without an address, try to resolve it from context.
If amount is specified as percentage (e.g., "50%"), calculate the actual amount from wallet balance.

Default slippage:
- LOW urgency: 50 bps (0.5%)
- MEDIUM urgency: 100 bps (1%)
- HIGH urgency: 200 bps (2%)

Respond ONLY with the JSON object.`;

export const EXECUTE_SWAP_TEMPLATE = executeSwapTemplate;

export const portfolioAnalysisTemplate = `You are a portfolio analyst reviewing the current trading portfolio and performance.

# Current Holdings
{{currentHoldings}}

# Open Positions
{{openPositions}}

# Closed Trades (Last 30 Days)
{{closedTrades}}

# Performance Metrics
{{performanceMetrics}}

# Market Context
{{marketContext}}

Provide a comprehensive portfolio analysis:

\`\`\`json
{
  "portfolioHealth": {
    "overallScore": 0-100,
    "status": "HEALTHY" | "CAUTION" | "AT_RISK" | "CRITICAL",
    "keyStrengths": ["list of portfolio strengths"],
    "concerns": ["list of concerns"]
  },
  
  "performanceSummary": {
    "totalPnL": "total profit/loss in USD",
    "totalPnLPercent": "percentage return",
    "winRate": "percentage of winning trades",
    "averageWin": "average winning trade in USD",
    "averageLoss": "average losing trade in USD",
    "profitFactor": "gross profit / gross loss",
    "sharpeRatio": "risk-adjusted return estimate"
  },
  
  "positionAnalysis": [
    {
      "tokenSymbol": "symbol",
      "tokenAddress": "address",
      "currentValue": "in USD",
      "unrealizedPnL": "in USD",
      "unrealizedPnLPercent": "percentage",
      "recommendation": "HOLD" | "ADD" | "REDUCE" | "EXIT",
      "reasoning": "brief explanation"
    }
  ],
  
  "riskExposure": {
    "totalAtRisk": "total USD at risk across all positions",
    "maxDrawdownPotential": "worst case scenario loss",
    "concentrationRisk": "highest single position percentage",
    "correlationRisk": "are positions correlated"
  },
  
  "rebalancingRecommendations": [
    {
      "action": "description of rebalancing action",
      "priority": "HIGH" | "MEDIUM" | "LOW",
      "reasoning": "why this rebalancing helps"
    }
  ],
  
  "strategyInsights": {
    "bestPerformingStrategy": "which strategy performed best",
    "worstPerformingStrategy": "which strategy performed worst",
    "recommendedAdjustments": ["suggested strategy tweaks"],
    "marketConditionAlignment": "how well strategies match current market"
  },
  
  "actionItems": [
    {
      "priority": 1,
      "action": "most important action to take",
      "deadline": "urgency level"
    }
  ],
  
  "summary": "executive summary of portfolio status and key recommendations"
}
\`\`\`

Focus on actionable insights that can improve risk-adjusted returns.
Be honest about underperforming positions - don't sugarcoat losses.
Prioritize capital preservation over aggressive growth.

Respond ONLY with the JSON object.`;

export const PORTFOLIO_ANALYSIS_TEMPLATE = portfolioAnalysisTemplate;

export const positionExitTemplate = `You are managing an active trading position. Analyze whether to exit, partially close, or hold based on current conditions.

# Position Details
{{positionDetails}}

# Current Market Data
{{currentMarketData}}

# Original Entry Reasoning
{{entryReasoning}}

# Exit Parameters
- Stop Loss: {{stopLossPrice}}
- Take Profit: {{takeProfitPrice}}
- Time in Position: {{timeInPosition}}
- Unrealized P&L: {{unrealizedPnL}} ({{unrealizedPnLPercent}}%)

# Market Conditions Since Entry
{{marketChanges}}

Evaluate the position and provide an exit decision:

\`\`\`json
{
  "decision": "HOLD" | "PARTIAL_EXIT" | "FULL_EXIT",
  "exitPercentage": "percentage of position to exit (0-100)",
  "urgency": "LOW" | "MEDIUM" | "HIGH" | "IMMEDIATE",
  "reasoning": "detailed explanation",
  "marketAnalysis": {
    "trendDirection": "BULLISH" | "BEARISH" | "NEUTRAL",
    "momentumStrength": "STRONG" | "MODERATE" | "WEAK",
    "volumeSignal": "ACCUMULATION" | "DISTRIBUTION" | "NEUTRAL"
  },
  "riskUpdate": {
    "currentRiskLevel": "LOW" | "MEDIUM" | "HIGH" | "CRITICAL",
    "newConcerns": ["any new risk factors"],
    "originalThesisIntact": true | false
  },
  "revisedTargets": {
    "newStopLoss": "updated stop loss if any",
    "newTakeProfit": "updated take profit if any",
    "trailingStopSuggestion": "if applicable"
  }
}
\`\`\`

Exit triggers to consider:
1. Price hit stop loss or take profit
2. Original thesis invalidated
3. Significant negative news or events
4. Better opportunity cost elsewhere
5. Risk/reward ratio deteriorated
6. Liquidity concerns emerged
7. Time-based exit (position held too long)

Be decisive - don't recommend holding losing positions hoping for recovery unless thesis is truly intact.

Respond ONLY with the JSON object.`;

export const POSITION_EXIT_TEMPLATE = positionExitTemplate;

export const riskAssessmentTemplate = `You are a risk management specialist evaluating a potential trade before execution.

# Proposed Trade
{{proposedTrade}}

# Token Security Analysis
{{securityAnalysis}}

# Portfolio Context
{{portfolioContext}}

# Market Volatility
{{volatilityData}}

# Historical Performance of Similar Trades
{{historicalPerformance}}

Provide a comprehensive risk assessment:

\`\`\`json
{
  "overallRiskRating": "APPROVED" | "APPROVED_WITH_CAUTION" | "REDUCED_SIZE" | "REJECTED",
  "riskScore": 0-100,
  "confidenceInAssessment": 0-100,
  
  "tokenRisks": {
    "contractRisk": {
      "level": "LOW" | "MEDIUM" | "HIGH",
      "factors": ["specific contract risks"],
      "rugPullProbability": "percentage estimate"
    },
    "liquidityRisk": {
      "level": "LOW" | "MEDIUM" | "HIGH",
      "slippageEstimate": "expected slippage percentage",
      "exitDifficulty": "how hard to exit position"
    },
    "concentrationRisk": {
      "level": "LOW" | "MEDIUM" | "HIGH",
      "topHoldersPercent": "percentage held by top 10",
      "teamTokensUnlocked": "if known"
    }
  },
  
  "portfolioRisks": {
    "correlationRisk": "how correlated to existing positions",
    "concentrationAfterTrade": "portfolio concentration percentage",
    "drawdownImpact": "max portfolio drawdown if trade goes wrong"
  },
  
  "marketRisks": {
    "volatilityLevel": "current market volatility assessment",
    "trendAlignment": "is trade aligned with market trend",
    "eventRisk": "any upcoming events that could impact"
  },
  
  "recommendations": {
    "positionSizeAdjustment": "suggested adjustment to position size",
    "stopLossAdjustment": "suggested stop loss modification",
    "entryTiming": "immediate or wait for better entry",
    "additionalPrecautions": ["list of precautions"]
  },
  
  "dealBreakers": ["list of absolute reasons to reject, if any"],
  
  "finalVerdict": "detailed summary of risk assessment and final recommendation"
}
\`\`\`

Risk thresholds:
- Reject if rug pull probability > 30%
- Reject if liquidity < 2x trade size
- Reject if top 10 holders > 80%
- Reduce size if daily loss limit within 50%
- Reduce size if portfolio concentration > 20%

Respond ONLY with the JSON object.`;

export const RISK_ASSESSMENT_TEMPLATE = riskAssessmentTemplate;

export const startTradingTemplate = `Start automated trading with the specified strategy and parameters.

Analyze the user's request to extract trading configuration:

User Request: {{userRequest}}

Available Strategies:
- llm: AI-powered trading using market analysis and trending token evaluation
- momentum: Momentum breakout strategy using technical indicators
- mean-reversion: Mean reversion strategy for range-bound markets  
- rules: Rule-based strategy with configurable indicator thresholds

Extract the configuration in this JSON format:

\`\`\`json
{
  "strategy": "strategy name from available list",
  "tokens": ["list of token addresses or symbols to trade, or 'auto' for trending tokens"],
  "maxPositionSize": "maximum position size in USD",
  "intervalMs": "trading loop interval in milliseconds",
  "stopLossPercent": "stop loss percentage",
  "takeProfitPercent": "take profit percentage",
  "maxDailyLoss": "maximum daily loss in USD",
  "tradingMode": "live or paper"
}
\`\`\`

If the user doesn't specify certain parameters, use these defaults:
- strategy: "llm"
- tokens: ["auto"]
- maxPositionSize: 100
- intervalMs: 60000
- stopLossPercent: 5
- takeProfitPercent: 15
- maxDailyLoss: 500
- tradingMode: "paper"

Respond ONLY with the JSON object.`;

export const START_TRADING_TEMPLATE = startTradingTemplate;

export const tradingDecisionTemplate = `You are an expert cryptocurrency trading analyst. Analyze the following market data and portfolio context to make a trading decision.

# Current Market Data
{{marketData}}

# Portfolio Status
{{portfolioStatus}}

# Risk Parameters
- Maximum Position Size: {{maxPositionSize}} USD
- Stop Loss: {{stopLossPercent}}%
- Take Profit: {{takeProfitPercent}}%
- Maximum Daily Loss: {{maxDailyLoss}} USD
- Current Daily P&L: {{dailyPnL}} USD

# Recent Trading History
{{recentTrades}}

# Token Analysis
{{tokenAnalysis}}

Based on this data, provide a trading decision in the following JSON format:

\`\`\`json
{
  "action": "BUY" | "SELL" | "HOLD",
  "tokenAddress": "the token contract address if BUY/SELL, null if HOLD",
  "tokenSymbol": "the token symbol",
  "amount": "amount in USD to trade (only for BUY), or percentage of position to sell (only for SELL)",
  "confidence": 0-100,
  "reasoning": "detailed explanation of the decision",
  "riskAssessment": {
    "riskLevel": "LOW" | "MEDIUM" | "HIGH",
    "concerns": ["list of risk factors"],
    "mitigations": ["how risks are being managed"]
  },
  "exitStrategy": {
    "stopLossPrice": "price at which to exit if losing",
    "takeProfitPrice": "price at which to take profit",
    "timeHorizon": "expected hold duration"
  }
}
\`\`\`

Important considerations:
1. Never recommend trading tokens with insufficient liquidity (<$50k)
2. Always factor in recent price volatility
3. Consider correlation with overall market conditions
4. Respect the risk parameters provided
5. If daily loss limit is approaching, recommend HOLD
6. Provide specific, actionable recommendations with clear reasoning

Respond ONLY with the JSON object, no additional text.`;

export const TRADING_DECISION_TEMPLATE = tradingDecisionTemplate;

