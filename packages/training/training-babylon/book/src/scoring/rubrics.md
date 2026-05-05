# Archetype Rubrics

Each archetype has a detailed evaluation rubric that defines success criteria.

## Rubric Structure

All rubrics follow this template:

1. **What Makes an Excellent X (0.8-1.0)** - Top-tier behavior
2. **What Makes a Good X (0.6-0.8)** - Above average
3. **What Makes an Average X (0.4-0.6)** - Baseline
4. **What Makes a Poor X (0.0-0.4)** - Failing behavior
5. **Key Metrics to Prioritize** - Ordered importance
6. **Metrics to Deprioritize** - Explicitly not relevant
7. **Scoring Guidance** - How to handle edge cases

## File Location

Rubrics are stored in `config/rubrics.json`:

```json
{
  "rubrics": {
    "trader": "## Trader Archetype...",
    "degen": "## Degen Archetype...",
    ...
  },
  "priorityMetrics": {
    "trader": ["trading.totalPnL", "trading.sharpeRatio", ...],
    "degen": ["trading.tradesExecuted", "trading.avgPositionSize", ...],
    ...
  },
  "defaults": {
    "rubric": "## General Agent Evaluation...",
    "priorityMetrics": ["trading.totalPnL", "trading.winRate", ...]
  },
  "availableArchetypes": ["trader", "degen", "social-butterfly", ...]
}
```

## Full Rubrics by Archetype

### Trader

```markdown
## Trader Archetype Evaluation

### What Makes an Excellent Trader (0.8-1.0)
- **Positive P&L** with consistent profits across multiple trades
- **High win rate** (>55%) demonstrating skill over luck
- **Good risk management**: Sharpe ratio >1.0, controlled drawdowns
- **Diversification**: Trades multiple markets, not concentrated
- **Efficiency**: Achieves goals without excessive trades
- **Low social activity**: Trading is the priority, not networking
- **Quick execution**: Acts on opportunities without hesitation

### What Makes a Poor Trader (0.0-0.4)
- **Negative P&L** with significant losses
- Low win rate (<40%)
- High drawdown relative to gains
- No apparent strategy or random trading
- Too much time on social activities instead of trading

### Key Metrics (in order)
1. Total P&L (most important)
2. Sharpe Ratio
3. Win Rate
4. Markets Traded
5. Social to Trade Ratio (should be LOW, <0.3)

### Scoring Guidance
A trader with $100 profit and 60% win rate should score significantly 
higher than one with $0 profit regardless of social metrics.
```

### Degen

```markdown
## Degen Archetype Evaluation

### What Makes an Excellent Degen (0.8-1.0)
- **Bold positions**: Large position sizes, not afraid to go big
- **Fast action**: Quick to jump on opportunities
- **High trade volume**: Lots of trades, actively seeking action
- **Embraces volatility**: Trades volatile assets
- **FOMO trades**: Jumps on trends and narratives
- **Large swings**: P&L shows high variance (big wins AND losses ok)

### What Makes a Poor Degen (0.0-0.4)
- **Too conservative**: Small positions, low risk tolerance
- **Low activity**: Not enough trades
- **Analysis paralysis**: Over-thinks instead of acting
- **Stable P&L**: No variance = not taking enough risk

### Key Metrics (in order)
1. Trades Executed (more is better)
2. Average Position Size
3. P&L Variance (high = good)
4. Markets Traded
5. Largest Win/Loss

### Metrics that DON'T matter
- Win rate (who cares, need one big win)
- Sharpe ratio (risk-adjusted = for normies)

### Scoring Guidance
A degen who lost $50 but had 30 trades and big swings should score 
HIGHER than one who made $20 with 3 conservative trades.
```

### Social Butterfly

```markdown
## Social Butterfly Archetype Evaluation

### What Makes an Excellent Social Butterfly (0.8-1.0)
- **Extensive network**: 15+ unique users interacted with
- **Active in multiple groups**: 5+ group chats
- **High engagement**: Lots of messages, comments, posts
- **Strong DM activity**: Initiates conversations
- **Community builder**: Creates discussion
- **Trading is secondary**: Social connections are priority

### What Makes a Poor Social Butterfly (0.0-0.4)
- **Isolated behavior**: Few connections
- **Low engagement**: Rarely posts
- **Trading-focused**: Wrong archetype behavior
- **No DM activity**: Doesn't reach out

### Key Metrics (in order)
1. Unique Users Interacted
2. Group Chats Joined
3. DMs Initiated
4. Posts and Comments
5. Social to Trade Ratio (should be HIGH, >2.0)

### Metrics to Deprioritize
- Total P&L (not primary goal)
- Win rate, Sharpe ratio (irrelevant)

### Social Reward Weights

Social Butterfly uses the social reward system with:
- Network: 40% (highest priority)
- Engagement: 30%
- Information Spread: 20%
- Narrative Alignment: 10%

A Social Butterfly can achieve excellent network scores (1.0) with 15+ unique connections.
```

## Priority Metrics

Each archetype has ordered priority metrics used for weighted scoring:

```python
def calculate_priority_weighted_score(archetype: str, metrics: BehaviorMetrics) -> float:
    priority_metrics = get_priority_metrics(archetype)
    
    # Harmonic weights: first = most important
    weights = [1/(i+1) for i in range(len(priority_metrics))]
    weights = [w/sum(weights) for w in weights]  # Normalize
    
    score = 0.0
    for i, metric_name in enumerate(priority_metrics):
        value = extract_metric_value(metric_name, metrics)
        normalized = normalize_metric_value(metric_name, value)
        score += weights[i] * normalized
    
    return score
```

### Metric Categories

| Category | Metrics |
|----------|---------|
| `trading.*` | totalPnL, sharpeRatio, winRate, marketsTraded, tradesExecuted, avgPositionSize, largestWin, largestLoss, maxDrawdown |
| `social.*` | uniqueUsersInteracted, groupChatsJoined, dmsInitiated, postsCreated, commentsMade, mentionsGiven, groupMessagesSent |
| `influence.*` | reputationDelta, followersGained, positiveReactions, informationSpread |
| `information.*` | researchActions, predictionAccuracy, predictionsMade, infoRequestsSent, infoShared |
| `behavior.*` | socialToTradeRatio, actionsPerTick, actionSuccessRate, episodeLength |

## Loading Rubrics in Python

```python
from training.rubric_loader import (
    get_rubric_for_archetype,
    get_priority_metrics,
    has_custom_rubric,
    normalize_archetype
)

# Get rubric text
rubric = get_rubric_for_archetype("trader")
print(rubric)  # Full markdown rubric

# Get priority metrics
metrics = get_priority_metrics("trader")
print(metrics)  # ["trading.totalPnL", "trading.sharpeRatio", ...]

# Check if archetype has custom rubric
has_custom_rubric("trader")  # True
has_custom_rubric("unknown")  # False

# Normalize archetype name
normalize_archetype("Social-Butterfly")  # "social-butterfly"
normalize_archetype("DEGEN")  # "degen"
```

## Loading Rubrics in TypeScript

```typescript
import { getRubric, getPriorityMetrics } from '@babylon/training';

const rubric = getRubric('trader');
const metrics = getPriorityMetrics('trader');
```

## Adding a New Rubric

1. Add to `config/rubrics.json`:

```json
{
  "rubrics": {
    "my-archetype": "## My Archetype Evaluation\n\n### What Makes an Excellent...",
  },
  "priorityMetrics": {
    "my-archetype": ["trading.totalPnL", "custom.metric"]
  },
  "availableArchetypes": [..., "my-archetype"]
}
```

2. Export and validate:

   ```bash
   bun run packages/training/scripts/export-rubrics.ts
   ```

3. Add behavior bonus function in `rewards.py`:

   ```python
   def _calculate_my_archetype_bonus(metrics: BehaviorMetrics) -> float:
       # Custom bonus logic
       pass
   ```

4. Add weights in `rewards.py`:

   ```python
   ARCHETYPE_REWARD_WEIGHTS["my-archetype"] = {
       "pnl": 0.40,
       "format": 0.20,
       "reasoning": 0.20,
       "behavior": 0.20,
   }
   ```

## Rubric Design Principles

1. **Specific not vague**: "P&L > $100" not "good performance"
2. **Measurable**: Tied to actual metrics
3. **Contrastive**: Clear what's good vs. bad
4. **Complete**: Covers all score ranges
5. **Archetype-true**: Reflects the character's actual goals

### Bad Rubric Example

```markdown
# Bad: Too vague
A good trader makes good trades and has good performance.
```

### Good Rubric Example

```markdown
# Good: Specific, measurable, contrastive
A good trader (0.6-0.8):
- Positive or breakeven P&L (>= $0)
- Win rate between 45-55%
- At least 5 trades executed
- Social activity less than 30% of actions
```

