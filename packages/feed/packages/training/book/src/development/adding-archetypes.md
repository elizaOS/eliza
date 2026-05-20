# Adding Archetypes

How to add a new agent archetype to the training system.

## Overview

Adding an archetype requires changes in:

1. **Rubrics** - Define success criteria
2. **Reward weights** - Set component importance
3. **Behavior bonus** - Implement archetype-specific scoring
4. **TypeScript types** - Add to available archetypes

## Step-by-Step

### Step 1: Define the Rubric

Edit `config/rubrics.json`:

```json
{
  "rubrics": {
    "my-archetype": "## My Archetype Evaluation\n\n### What Makes an Excellent My-Archetype (0.8-1.0)\n- **Key behavior 1**: Description\n- **Key behavior 2**: Description\n\n### What Makes a Good My-Archetype (0.6-0.8)\n- Moderate behavior\n\n### What Makes a Poor My-Archetype (0.0-0.4)\n- **Anti-behavior**: What they should NOT do\n\n### Key Metrics to Prioritize (in order)\n1. metric.one\n2. metric.two\n\n### Scoring Guidance\nSpecific guidance for edge cases."
  }
}
```

### Step 2: Add Priority Metrics

In the same file, add priority metrics:

```json
{
  "priorityMetrics": {
    "my-archetype": [
      "trading.totalPnL",
      "social.uniqueUsersInteracted",
      "behavior.customMetric"
    ]
  }
}
```

Available metrics:
- `trading.*`: totalPnL, winRate, tradesExecuted, etc.
- `social.*`: uniqueUsersInteracted, dmsInitiated, etc.
- `influence.*`: reputationDelta, followersGained, etc.
- `information.*`: researchActions, predictionAccuracy, etc.
- `behavior.*`: socialToTradeRatio, actionsPerTick, etc.

### Step 3: Register as Available

```json
{
  "availableArchetypes": [
    "trader",
    "degen",
    "...",
    "my-archetype"
  ]
}
```

### Step 4: Add Reward Weights

Edit `python/src/training/rewards.py`:

```python
ARCHETYPE_REWARD_WEIGHTS: Dict[str, Dict[str, float]] = {
    # ... existing archetypes ...
    
    "my-archetype": {
        "pnl": 0.30,      # How much P&L matters
        "format": 0.20,   # Response format quality
        "reasoning": 0.25, # Reasoning quality
        "behavior": 0.25,  # Archetype-aligned behavior
    },
}
```

Weights must sum to 1.0 (validated at import time).

### Step 5: Implement Behavior Bonus

In `python/src/training/rewards.py`, add the bonus function:

```python
def _calculate_my_archetype_bonus(metrics: BehaviorMetrics) -> float:
    """
    My Archetype: Describe the key behaviors.
    
    Scoring rationale:
    - What behaviors earn bonuses
    - What behaviors earn penalties
    """
    bonus = 0.0
    
    # Example: Reward specific behavior
    if metrics.some_metric >= 10:
        bonus += 0.20  # Excellent
    elif metrics.some_metric >= 5:
        bonus += 0.10  # Good
    elif metrics.some_metric < 2:
        bonus -= 0.15  # Penalty for absence
    
    # Example: Penalize wrong behavior
    if metrics.wrong_metric > 0:
        bonus -= 0.10
    
    return clamp_bonus(bonus)  # Clamp to [-0.5, 0.5]
```

### Step 6: Register in Dispatcher

In the same file, add to `calculate_archetype_behavior_bonus`:

```python
def calculate_archetype_behavior_bonus(
    archetype: str,
    metrics: BehaviorMetrics,
) -> float:
    archetype = normalize_archetype(archetype)
    
    if archetype == "degen":
        return _calculate_degen_bonus(metrics)
    # ... existing ...
    elif archetype == "my-archetype":
        return _calculate_my_archetype_bonus(metrics)
    else:
        return 0.0
```

### Step 7: Add TypeScript Definition (Optional)

For full integration with the game engine:

Create `src/archetypes/definitions/my-archetype.ts`:

```typescript
import type { ArchetypeDefinition } from '../types';

export const myArchetype: ArchetypeDefinition = {
  id: 'my-archetype',
  name: 'My Archetype',
  description: 'What this archetype does',
  
  systemPrompt: `You are a [my-archetype] agent in Babylon...`,
  
  priorityMetrics: [
    'trading.totalPnL',
    'social.uniqueUsersInteracted',
  ],
  
  behaviorHints: [
    'Focus on X',
    'Avoid Y',
  ],
};
```

Register in `src/archetypes/index.ts`:

```typescript
import { myArchetype } from './definitions/my-archetype';

export const ARCHETYPES = {
  // ... existing
  'my-archetype': myArchetype,
};
```

## Testing Your Archetype

### 1. Validate Rubric Loading

```python
from training.rubric_loader import get_rubric_for_archetype, has_custom_rubric

assert has_custom_rubric("my-archetype")
rubric = get_rubric_for_archetype("my-archetype")
print(rubric)  # Should show your rubric
```

### 2. Validate Weights

```python
from training.rewards import get_archetype_weights

weights = get_archetype_weights("my-archetype")
print(weights)  # Should show your weights
assert abs(sum(weights.values()) - 1.0) < 1e-9
```

### 3. Test Behavior Bonus

```python
from training.rewards import BehaviorMetrics, calculate_archetype_behavior_bonus

# Test excellent behavior
metrics = BehaviorMetrics(
    some_metric=15,
    wrong_metric=0,
)
bonus = calculate_archetype_behavior_bonus("my-archetype", metrics)
assert bonus > 0.15, f"Expected positive bonus, got {bonus}"

# Test poor behavior
metrics = BehaviorMetrics(
    some_metric=0,
    wrong_metric=10,
)
bonus = calculate_archetype_behavior_bonus("my-archetype", metrics)
assert bonus < 0, f"Expected negative bonus, got {bonus}"
```

### 4. Test Full Scoring

```python
from training.rewards import archetype_composite_reward, TrajectoryRewardInputs

inputs = TrajectoryRewardInputs(
    final_pnl=100,
    starting_balance=10000,
    format_score=0.8,
    reasoning_score=0.7,
)
metrics = BehaviorMetrics(some_metric=10)

score = archetype_composite_reward(inputs, "my-archetype", metrics)
print(f"Composite score: {score}")
assert -1.0 <= score <= 1.0
```

### 5. Run Unit Tests

```bash
make tier1
# Should pass with no errors
```

## Example: Adding "Whale" Archetype

A whale is a large-position trader who moves markets.

### rubrics.json

```json
{
  "rubrics": {
    "whale": "## Whale Archetype Evaluation\n\n### What Makes an Excellent Whale (0.8-1.0)\n- **Large positions**: Average position size > $5000\n- **Market impact**: Trades that move prices\n- **Confident**: Doesn't panic sell on small dips\n- **Strategic timing**: Enters/exits at key levels\n\n### What Makes a Poor Whale (0.0-0.4)\n- Small positions (not whale behavior)\n- Paper hands (sells on fear)\n- No market impact\n\n### Key Metrics\n1. trading.avgPositionSize (most important)\n2. trading.totalPnL\n3. trading.tradesExecuted"
  },
  "priorityMetrics": {
    "whale": [
      "trading.avgPositionSize",
      "trading.totalPnL",
      "trading.tradesExecuted",
      "trading.largestWin"
    ]
  },
  "availableArchetypes": ["...", "whale"]
}
```

### rewards.py

```python
ARCHETYPE_REWARD_WEIGHTS["whale"] = {
    "pnl": 0.40,
    "format": 0.15,
    "reasoning": 0.20,
    "behavior": 0.25,
}

def _calculate_whale_bonus(metrics: BehaviorMetrics) -> float:
    """Whale: Large positions, market-moving trades."""
    bonus = 0.0
    
    # Large position sizes
    if metrics.avg_position_size >= 5000:
        bonus += 0.25
    elif metrics.avg_position_size >= 2000:
        bonus += 0.15
    elif metrics.avg_position_size < 500:
        bonus -= 0.15  # Not whale behavior
    
    # Should trade, but not excessively
    if 3 <= metrics.trades_executed <= 10:
        bonus += 0.10
    
    # Big wins expected
    if metrics.largest_win >= 1000:
        bonus += 0.10
    
    return clamp_bonus(bonus)
```

Add to dispatcher:

```python
elif archetype == "whale":
    return _calculate_whale_bonus(metrics)
```

## Social Archetypes

For archetypes where social interaction is primary (not trading), also add social reward weights:

```python
# In rewards.py - add to SOCIAL_REWARD_WEIGHTS
"my-social-archetype": {
    "engagement": 0.30,  # Posts, DMs, comments
    "spread": 0.25,      # Reactions, shares
    "network": 0.30,     # Connections, groups
    "narrative": 0.15,   # Alignment with events
}
```

And add composite weights:

```python
# In rewards.py - add to SOCIAL_COMPOSITE_WEIGHTS
"my-social-archetype": {
    "social": 0.50,      # Total social reward weight
    "format": 0.25,
    "reasoning": 0.15,
    "pnl": 0.10,         # Minimal PnL weight
}
```

See [Enhanced Rewards - Social & Narrative](../scoring/enhanced-rewards.md#social--narrative-rewards).

## Checklist

- [ ] Rubric added to `config/rubrics.json`
- [ ] Priority metrics defined
- [ ] Archetype in `availableArchetypes`
- [ ] Weights added to `ARCHETYPE_REWARD_WEIGHTS`
- [ ] Bonus function implemented
- [ ] Bonus function registered in dispatcher
- [ ] Unit tests pass (`make tier1`)
- [ ] (Optional) TypeScript definition
- [ ] (For social archetypes) `SOCIAL_REWARD_WEIGHTS` entry
- [ ] (For social archetypes) `SOCIAL_COMPOSITE_WEIGHTS` entry

