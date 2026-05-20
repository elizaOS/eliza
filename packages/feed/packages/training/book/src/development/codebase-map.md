# Codebase Map

A guide to the key files and their purposes.

## Directory Structure

```text
packages/training/
├── book/                    # This documentation (mdbook)
├── config/
│   └── rubrics.json         # Archetype rubrics and priority metrics
├── data/                    # Generated/cached data
├── python/                  # Python training code
├── scripts/                 # TypeScript scripts
├── src/                     # TypeScript source
├── Dockerfile               # Cloud deployment
├── docker-compose.test.yml  # Test database
├── Makefile                 # Developer commands
├── package.json             # Node dependencies
└── README.md                # Quick reference
```

## TypeScript Source (`src/`)

### Core Modules

| File | Purpose | Key Exports |
|------|---------|-------------|
| `index.ts` | Package entry point | Re-exports all modules |
| `training/TrajectoryRecorder.ts` | Records agent decisions | `TrajectoryRecorder` class |
| `training/types.ts` | Trajectory type definitions | `TrajectoryStep`, `Action`, etc. |
| `training/window-utils.ts` | Time window helpers | `getCurrentWindowId` |

### Scoring

| File | Purpose | Key Exports |
|------|---------|-------------|
| `scoring/ArchetypeScoringService.ts` | LLM-as-judge | `ArchetypeScoringService` class |
| `scoring/types.ts` | Scoring types | `ScoredTrajectory` |

### Archetypes

| File | Purpose | Key Exports |
|------|---------|-------------|
| `archetypes/derive-archetype.ts` | Archetype derivation | `deriveArchetype` |
| `archetypes/ArchetypeConfigService.ts` | Archetype configuration | Config loading |
| `archetypes/index.ts` | Module exports | Re-exports |

### Benchmark

| File | Purpose |
|------|---------|
| `benchmark/BenchmarkDataGenerator.ts` | Synthetic scenario generation |
| `benchmark/BenchmarkRunner.ts` | Run model against benchmark scenarios |
| `benchmark/ScenarioLoader.ts` | Load and validate fixed scenarios |
| `benchmark/ArchetypeFitCalculator.ts` | Calculate archetype alignment scores |
| `benchmark/StakeholderReport.ts` | Generate HTML/JSON/text reports |
| `benchmark/SimulationEngine.ts` | Run agent simulations |
| `benchmark/types.ts` | Benchmark types |

### Utilities

| File | Purpose |
|------|---------|
| `utils/logger.ts` | Logging utilities |
| `utils/snowflake.ts` | ID generation |

## Python Source (`python/src/`)

### Training Core

| File | Purpose | Key Contents |
|------|---------|--------------|
| `training/babylon_env.py` | Atropos environment | `BabylonRLAIFEnv` class |
| `training/atropos_trainer.py` | GRPO training loop | `BabylonAtroposTrainer` class |
| `training/rewards.py` | Reward functions | `archetype_composite_reward`, weight dicts |
| `training/rubric_loader.py` | Load rubrics.json | `get_rubric_for_archetype` |
| `training/format_validator.py` | Response parsing | `validate_response_format` |
| `training/quality_scorer.py` | Reasoning scoring | `score_response` |
| `training/tokenization_utils.py` | Chat template | `tokenize_for_trainer` |
| `training/evaluation.py` | Evaluation suite | `EvaluationSuite`, `RolloutDumper` |

### Data Bridge

| File | Purpose |
|------|---------|
| `data_bridge/reader.py` | Load trajectories from DB/JSON |
| `data_bridge/writer.py` | Write trajectories |

### Models

| File | Purpose |
|------|---------|
| `models/__init__.py` | Pydantic models for data |

## Python Scripts (`python/scripts/`)

### Primary Scripts

| Script | Purpose | Usage |
|--------|---------|-------|
| `run_training.py` | Full pipeline orchestrator | `python scripts/run_training.py --profile 12gb` |
| `import_json_trajectories.py` | Import JSON to DB | `python packages/training/python/scripts/import_json_trajectories.py` |
| `train_local.py` | Local training (legacy) | `python scripts/train_local.py` |

### Configuration

| File | Purpose |
|------|---------|
| `config/babylon_atropos.yaml` | Atropos environment config |
| `config/profiles/*.json` | GPU profile configurations |

## TypeScript Scripts (`scripts/`)

| Script | Purpose |
|--------|---------|
| `run-benchmark-suite.ts` | **Advanced benchmark suite** - compare models across fixed scenarios |
| `generate-benchmark-scenarios.ts` | Regenerate fixed benchmark scenario files |
| `train-and-test.ts` | Train + evaluate |
| `run-full-pipeline.ts` | Complete workflow |
| `run-baseline-comparison.ts` | Model comparison |
| `test-model-in-game.ts` | Test in simulation |
| `export-rubrics.ts` | Export rubrics to JSON |
| `e2e-training-test.ts` | End-to-end test |

## Configuration Files

### `config/rubrics.json`

Central archetype configuration:

```json
{
  "rubrics": {
    "trader": "## Trader Archetype...",
    ...
  },
  "priorityMetrics": {
    "trader": ["trading.totalPnL", ...],
    ...
  },
  "defaults": {...},
  "availableArchetypes": [...]
}
```

### `python/config/profiles/*.json`

GPU-specific configurations:

```json
{
  "name": "12GB GPU",
  "model": "Qwen/Qwen2.5-0.5B-Instruct",
  "vllm_gpu_memory": 0.25,
  "batch_size": 1
}
```

### `python/config/babylon_atropos.yaml`

Atropos framework configuration.

## Makefile Targets

| Target | Purpose |
|--------|---------|
| `make venv` | Setup Python environment |
| `make tier1-4` | Run test tiers |
| `make train-*` | Training shortcuts |
| `make db-*` | Database management |
| `make bridge-*` | Simulation bridge |

## Key Classes

### BabylonRLAIFEnv

The main Atropos environment:

```python
class BabylonRLAIFEnv(BaseEnv):
    async def setup(self):
        """Initialize DB connection and load data."""
    
    async def get_next_item(self) -> ScoredDataGroup:
        """Get next training batch."""
    
    def _score_with_judge(self, trajectory, response, archetype) -> float:
        """Score a completion."""
```

### TrajectoryRecorder

Records agent decisions:

```typescript
class TrajectoryRecorder {
    startTrajectory(options: StartOptions): string
    startStep(observation: Observation): void
    logLLMCall(call: LLMCall): void
    completeStep(action: Action): void
    endTrajectory(options: EndOptions): Promise<void>
}
```

### Reward Functions

```python
# Core functions in rewards.py

calculate_pnl_reward(start_balance, end_balance) -> float
calculate_archetype_behavior_bonus(archetype, metrics) -> float
archetype_composite_reward(inputs, archetype, behavior_metrics) -> float
```

## Data Types

### Trajectory (TypeScript)

```typescript
interface Trajectory {
    trajectoryId: string;
    agentId: string;
    archetype: string;
    windowId: string;
    stepsJson: TrajectoryStep[];
    finalPnL: number;
    finalBalance: number;
}
```

### TrajectoryStep

```typescript
interface TrajectoryStep {
    stepNumber: number;
    tick: number;
    observation: EnvironmentState;
    llmCalls: LLMCall[];
    action: Action;
    reward?: number;
}
```

### BehaviorMetrics (Python)

```python
@dataclass
class BehaviorMetrics:
    trades_executed: int = 0
    win_rate: float = 0.0
    total_pnl: float = 0.0
    unique_users_interacted: int = 0
    group_chats_joined: int = 0
    # ... more metrics
```

## Import/Export Pattern

### TypeScript → Python

```text
TypeScript:
  TrajectoryRecorder → PostgreSQL/JSON

Python:
  JsonTrajectoryReader ← PostgreSQL/JSON
```

### Shared Config

```text
config/rubrics.json
  ↓
rubric_loader.py (Python)
  ↓
Training rewards
```

## Finding Things

### "Where is X defined?"

| Looking for | Location |
|-------------|----------|
| Archetype rubrics | `config/rubrics.json` |
| Reward weights | `python/src/training/rewards.py:ARCHETYPE_REWARD_WEIGHTS` |
| Behavior bonus | `python/src/training/rewards.py:_calculate_*_bonus` |
| GPU profiles | `python/config/profiles/*.json` |
| Training args | `python/scripts/run_training.py` |
| Trajectory types | `src/training/types.ts` |
| Scoring logic | `python/src/training/babylon_env.py:_score_with_judge` |
| Fixed scenarios | `data/benchmarks/scenarios/*.json` |
| Archetype fit scoring | `src/benchmark/ArchetypeFitCalculator.ts` |
| Benchmark reports | `src/benchmark/StakeholderReport.ts` |

### "How does X work?"

| Question | Start here |
|----------|------------|
| How are trajectories recorded? | `src/training/TrajectoryRecorder.ts` |
| How are rewards computed? | `python/src/training/rewards.py` |
| How does training run? | `python/scripts/run_training.py` |
| How are prompts built? | `python/src/training/babylon_env.py:_trajectory_to_messages` |
| How is format validated? | `python/src/training/format_validator.py` |
| How does benchmarking work? | `scripts/run-benchmark-suite.ts` |
| How are scenarios loaded? | `src/benchmark/ScenarioLoader.ts` |
| How is archetype fit calculated? | `src/benchmark/ArchetypeFitCalculator.ts` |
