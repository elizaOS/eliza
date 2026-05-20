# Trajectory Format

A trajectory is a complete record of one agent's behavior during a time window.

## Database Schema

```sql
CREATE TABLE trajectories (
    id                   BIGINT PRIMARY KEY,
    "trajectoryId"       TEXT UNIQUE NOT NULL,
    "agentId"            TEXT NOT NULL,
    archetype            TEXT,
    "windowId"           TEXT,
    "scenarioId"         TEXT,
    
    -- Core data (JSONB)
    "stepsJson"          JSONB,
    "rewardComponentsJson" JSONB,
    "metricsJson"        JSONB,
    "metadataJson"       JSONB,
    
    -- Summary metrics
    "finalPnL"           FLOAT,
    "episodeLength"      INTEGER,
    "totalReward"        FLOAT,
    "finalStatus"        TEXT,
    "finalBalance"       FLOAT,
    "tradesExecuted"     INTEGER,
    "postsCreated"       INTEGER,
    
    -- Scoring
    "aiJudgeReward"      FLOAT,
    
    -- Flags
    "isTrainingData"     BOOLEAN DEFAULT TRUE,
    "isEvaluation"       BOOLEAN DEFAULT FALSE,
    "usedInTraining"     BOOLEAN DEFAULT FALSE,
    
    -- Timestamps
    "startTime"          TIMESTAMPTZ,
    "endTime"            TIMESTAMPTZ,
    "durationMs"         INTEGER,
    "windowHours"        INTEGER DEFAULT 1,
    "createdAt"          TIMESTAMPTZ DEFAULT NOW(),
    "updatedAt"          TIMESTAMPTZ DEFAULT NOW()
);
```

## Step Structure

Each step in `stepsJson` captures one decision point:

```typescript
interface TrajectoryStep {
  stepNumber: number;
  tick: number;
  timestamp: string;
  
  // What the agent observed
  observation: EnvironmentState;
  
  // LLM calls made during this step
  llmCalls: LLMCall[];
  
  // The action taken
  action: Action;
  
  // Immediate reward (optional)
  reward?: number;
  
  // Provider data accessed
  providerAccess?: ProviderAccess[];
}
```

### Observation (EnvironmentState)

```typescript
interface EnvironmentState {
  // Market data
  marketPrices: Record<string, number>;
  marketVolumes?: Record<string, number>;
  priceChanges24h?: Record<string, number>;
  
  // Agent's portfolio
  portfolio: {
    balance: number;
    positions: Position[];
    unrealizedPnL?: number;
  };
  
  // Social context
  recentPosts?: Post[];
  recentDMs?: DirectMessage[];
  groupChats?: GroupChat[];
  
  // Events and news
  recentEvents?: GameEvent[];
  newsFeed?: NewsItem[];
  
  // Time context
  currentTick?: number;
  gameDay?: number;
  gameHour?: number;
}
```

### LLM Call

```typescript
interface LLMCall {
  callId: string;
  model: string;
  
  // Input
  prompt: string;
  systemPrompt?: string;
  
  // Output
  response: string;
  
  // Metadata
  tokensUsed?: number;
  latencyMs?: number;
  temperature?: number;
  
  // Extracted data
  reasoning?: string;  // Parsed from <thinking> tags
  decision?: string;   // The concluded action
}
```

### Action

```typescript
interface Action {
  actionType: string;  // BUY, SELL, POST, DM, etc.
  parameters: Record<string, unknown>;
  success: boolean;
  error?: string;
  
  // Results
  executionResult?: {
    transactionId?: string;
    pnl?: number;
    newBalance?: number;
  };
}
```

## Example Trajectory

```json
{
  "trajectoryId": "traj_abc123",
  "agentId": "user_xyz",
  "archetype": "trader",
  "windowId": "2025-01-13-14",
  
  "stepsJson": [
    {
      "stepNumber": 1,
      "tick": 5,
      "timestamp": "2025-01-13T14:05:00Z",
      "observation": {
        "marketPrices": {"ETH": 2850, "BTC": 45000},
        "portfolio": {
          "balance": 10000,
          "positions": []
        },
        "recentEvents": [
          {"type": "PRICE_MOVE", "ticker": "ETH", "change": 0.05}
        ]
      },
      "llmCalls": [
        {
          "callId": "llm_001",
          "model": "qwen-0.5b",
          "prompt": "Market update: ETH up 5%...",
          "response": "<thinking>ETH showing momentum. RSI not overbought. Good entry.</thinking>\n\nI'll buy ETH with 10% of portfolio.",
          "reasoning": "ETH showing momentum. RSI not overbought. Good entry."
        }
      ],
      "action": {
        "actionType": "BUY",
        "parameters": {
          "ticker": "ETH",
          "amount": 1000,
          "orderType": "MARKET"
        },
        "success": true,
        "executionResult": {
          "transactionId": "tx_001",
          "newBalance": 9000
        }
      }
    },
    {
      "stepNumber": 2,
      "tick": 10,
      "observation": {
        "marketPrices": {"ETH": 2950, "BTC": 45200},
        "portfolio": {
          "balance": 9000,
          "positions": [{"ticker": "ETH", "size": 0.35, "entryPrice": 2850}]
        }
      },
      "llmCalls": [
        {
          "callId": "llm_002",
          "model": "qwen-0.5b",
          "prompt": "Position update: ETH +3.5%...",
          "response": "<thinking>Position up 3.5%. Take partial profits.</thinking>\n\nSelling half my ETH position."
        }
      ],
      "action": {
        "actionType": "SELL",
        "parameters": {"ticker": "ETH", "amount": 0.175},
        "success": true
      }
    }
  ],
  
  "finalPnL": 52.50,
  "finalBalance": 10052.50,
  "tradesExecuted": 3,
  "episodeLength": 2
}
```

## Converting to Training Prompts

The environment converts trajectories to chat format:

```python
def _trajectory_to_messages(self, trajectory: dict) -> list[dict]:
    messages = []
    
    # System message with archetype context
    archetype = trajectory.get("archetype", "trader")
    messages.append({
        "role": "system",
        "content": f"You are a {archetype} agent in Babylon..."
    })
    
    # Convert each step to user/assistant turns
    for step in trajectory.get("stepsJson", []):
        # User: observation
        messages.append({
            "role": "user",
            "content": self._format_observation(step["observation"])
        })
        
        # Assistant: the response we're training on
        if step.get("llmCalls"):
            messages.append({
                "role": "assistant",
                "content": step["llmCalls"][0]["response"]
            })
    
    return messages
```

## Window Grouping

Trajectories are grouped by window for GRPO comparison:

```python
# Same window = same market conditions = fair comparison
window_groups = defaultdict(list)
for traj in trajectories:
    window_id = traj["windowId"]  # e.g., "2025-01-13-14"
    window_groups[window_id].append(traj)

# Only use windows with enough agents
valid_groups = {
    k: v for k, v in window_groups.items() 
    if len(v) >= min_agents_per_window
}
```

## Validation Requirements

Trajectories must pass validation to be used in training:

| Check | Requirement | Reason |
|-------|-------------|--------|
| `stepsJson` not null | Has content | Can't train on empty |
| Length >= `min_actions` | 3+ steps | Need enough context |
| Has LLM calls | At least 1 | Need model output to score |
| Valid JSON | Parseable | Data integrity |
| Has `agentId` | Not null | Need to track agent |
| Has `windowId` | Not null | Need for grouping |

```python
# From import_json_trajectories.py
def validate_trajectory(traj_data: dict) -> tuple[bool, list[str]]:
    issues = []
    
    required = ["trajectoryId", "agentId", "windowId"]
    for field in required:
        if not traj_data.get(field):
            issues.append(f"Missing: {field}")
    
    steps = traj_data.get("stepsJson", [])
    if len(steps) < 3:
        issues.append("Too few steps")
    
    # Check LLM calls present
    has_llm = any(step.get("llmCalls") for step in steps)
    if not has_llm:
        issues.append("No LLM calls found")
    
    return len(issues) == 0, issues
```

## JSON Mode vs DB Mode

### JSON Mode (Development)

Trajectories saved to files:

```text
training-data-output/
├── state.json           # Game state snapshot
├── ground-truth.json    # Causal events (if --causal)
└── trajectories/
    ├── traj_abc123.json
    ├── traj_def456.json
    └── ...
```

### DB Mode (Production)

Trajectories in PostgreSQL:
```sql
SELECT "trajectoryId", archetype, "finalPnL", "createdAt"
FROM trajectories
WHERE "createdAt" > NOW() - INTERVAL '24 hours'
ORDER BY "createdAt" DESC
LIMIT 10;
```

Import JSON to DB:

```bash
python packages/training/python/scripts/import_json_trajectories.py --source ./training-data-output
```
