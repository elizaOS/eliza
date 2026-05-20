# Glossary

Key terms used throughout the training pipeline.

## Core Concepts

### Trajectory

A complete record of one agent's behavior during a time window. Contains:
- Steps (observation → reasoning → action)
- LLM calls made
- Final outcomes (P&L, balance)
- Metadata (archetype, window ID)

### Archetype

A behavioral style that defines how an agent should act. Examples:
- **trader**: Disciplined, profit-focused
- **degen**: High-risk, high-activity
- **social-butterfly**: Network-building, community-focused

Each archetype has unique success criteria and reward weights.

### Window

A time slice (typically 1 hour) during which trajectories are grouped. Agents in the same window faced similar market conditions, making their trajectories comparable.

```text
windowId: "2025-01-13-14"  # Day 2025-01-13, hour 14
```

### Step

A single decision point in a trajectory:
1. Agent receives **observation** (market state, portfolio)
2. Agent makes **LLM call** (reasoning)
3. Agent takes **action** (buy, sell, post)

## Training Terms

### GRPO (Group Relative Policy Optimization)

The training algorithm. Key features:
- Generates multiple completions per prompt
- Scores them relative to each other
- Updates model to increase probability of higher-scoring completions

### Atropos

The RL framework we build on (by Nous Research). Provides:
- `BaseEnv` class for environments
- GRPO implementation
- Training loop utilities

### RLAIF (Reinforcement Learning from AI Feedback)

Using AI-generated scores instead of human feedback. Our Python judge scores trajectories automatically.

### vLLM

Fast inference server for generating model completions. Used during training to produce candidate actions.

## Scoring Terms

### Composite Reward

The final score combining multiple components:
- PnL score (financial performance)
- Format score (valid response structure)
- Reasoning score (quality of thinking)
- Behavior bonus (archetype alignment)

### Behavior Bonus

Archetype-specific adjustment to reward. Ranges from -0.5 to +0.5. Rewards on-archetype behavior, penalizes off-archetype behavior.

### Priority Metrics

Ordered list of metrics most important for each archetype. First metric has highest weight in scoring.

### Market Regime

Classification of overall market conditions:
- **Bull**: Average price increase > +5%
- **Bear**: Average price decrease < -5%
- **Sideways**: Price change between -5% and +5%

Used by enhanced rewards to adjust scoring based on market context.

### Counterfactual Alpha

Measures skill vs luck: `Alpha = Actual P&L - Expected P&L`

- Positive alpha = outperformed the market
- Negative alpha = underperformed the market
- Expected P&L is based on market regime (+5% bull, -5% bear, 0% sideways)

### Temporal Credit

Attribution of final P&L back to individual trading decisions. Decisions closer to the outcome receive more credit (exponential decay).

### Social Reward

PnL-independent scoring for non-trading archetypes (Social Butterfly, Ass-Kisser, etc.). Composed of:
- **Engagement**: Volume/diversity of social actions (posts, DMs, comments)
- **Spread**: How well content reaches others (reactions, shares)
- **Network**: Connections built (unique users, groups, reputation)
- **Narrative**: Alignment with ground truth events

### Narrative Event

A ground truth event in the simulation that agents can react to. Contains:
- Tick when it occurred
- Affected tickers/markets
- Expected direction (up/down/volatile)
- Whether publicly revealed

Used to score how well agents align actions with real events.

### Rubric

Detailed evaluation criteria for an archetype. Defines what makes excellent, good, average, and poor performance.

### Tiebreaker

Small deterministic adjustment to ensure scores aren't identical. Critical for GRPO which needs score variance.

## Data Terms

### stepsJson

The JSON field in trajectories table containing the array of steps. Stores observations, LLM calls, and actions.

### LLM Call

A record of one language model invocation:
- Prompt (input)
- Response (output)
- Model used
- Metadata (tokens, latency)

### Observation

The environment state presented to an agent:
- Market prices
- Portfolio (balance, positions)
- Recent events/news
- Social context

### Action

What the agent decided to do:
- Type (BUY, SELL, POST, DM, etc.)
- Parameters (ticker, amount, content)
- Success/failure

## Infrastructure Terms

### GPU Profile

Configuration for specific GPU hardware:
- Model to use
- vLLM memory allocation
- Batch size
- Max sequence length

### Test Database

Separate PostgreSQL instance for testing. Runs on port 5434 to avoid conflicts with production.

### Simulation Bridge

HTTP server that enables online training by providing real-time scenarios.

## Metrics

### Trading Metrics

| Metric | Description |
|--------|-------------|
| `totalPnL` | Total profit/loss in dollars |
| `winRate` | Fraction of successful trades |
| `sharpeRatio` | Risk-adjusted return |
| `tradesExecuted` | Number of trades made |
| `marketsTraded` | Number of different markets |
| `maxDrawdown` | Largest peak-to-trough decline |
| `avgPositionSize` | Average trade size |

### Social Metrics

| Metric | Description |
|--------|-------------|
| `uniqueUsersInteracted` | Number of distinct users engaged |
| `groupChatsJoined` | Group chat memberships |
| `dmsInitiated` | Direct messages sent |
| `postsCreated` | Posts published |
| `commentsMade` | Comments on others' posts |

### Influence Metrics

| Metric | Description |
|--------|-------------|
| `reputationDelta` | Change in reputation score |
| `followersGained` | New followers |
| `positiveReactions` | Likes, upvotes received |
| `informationSpread` | How far information propagated |

### Behavior Metrics

| Metric | Description |
|--------|-------------|
| `socialToTradeRatio` | Social actions / trading actions |
| `actionsPerTick` | Activity level per time unit |
| `episodeLength` | Number of steps in trajectory |

## Abbreviations

| Abbreviation | Meaning |
|--------------|---------|
| GRPO | Group Relative Policy Optimization |
| RLAIF | Reinforcement Learning from AI Feedback |
| RLHF | Reinforcement Learning from Human Feedback |
| vLLM | Virtual LLM (fast inference library) |
| W&B | Weights & Biases |
| LR | Learning Rate |
| OOM | Out Of Memory |
| DB | Database |
| API | Application Programming Interface |
| GPU | Graphics Processing Unit |
| VRAM | Video Random Access Memory |
| P&L | Profit and Loss |
| DM | Direct Message |

