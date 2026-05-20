# Testing Tiers

The training pipeline has four testing tiers, progressing from fast unit tests to full GPU training.

## Overview

| Tier | Name | Requirements | Time |
|------|------|--------------|------|
| 1 | Unit Tests | Python only | ~30s |
| 2 | JSON Mode | Python only | ~1m |
| 3 | DB Integration | Docker (PostgreSQL) | ~2m |
| 4 | Full GPU | GPU + Docker | ~5m |

## Running Tests

```bash
cd packages/training

# Run all tiers progressively
make tier1
make tier2
make tier3
make tier4

# Run quick tests (tier1 + tier2)
make test
```

## Tier 1: Unit Tests

Fast, no infrastructure required.

### What It Tests

- Reward calculation functions
- Archetype weight validation
- Rubric loading
- Format validation
- Tokenization utilities

### Command

```bash
make tier1
```

Runs:

```bash
cd python && pytest tests/ -v \
    --ignore=tests/integration/ \
    --ignore=tests/e2e/ \
    -x
```

### Key Test Files

```text
python/tests/
├── test_archetype_scoring.py    # Archetype reward weights
├── test_format_validator.py     # Response parsing
├── test_quality_scorer.py       # Reasoning scoring
├── test_action_executor.py      # Action validation
├── test_atropos_integration.py  # Env/trainer tests
└── test_evaluation.py           # Evaluation suite
```

### Example: Archetype Scoring Tests

```python
# tests/test_archetype_scoring.py
def test_archetype_weights_sum_to_one():
    for archetype, weights in ARCHETYPE_REWARD_WEIGHTS.items():
        total = sum(weights.values())
        assert abs(total - 1.0) < 1e-9, f"{archetype} weights don't sum to 1"

def test_pnl_reward_positive():
    score = calculate_pnl_reward(start=10000, end=11000)
    assert score == 1.0  # 10% gain = max score
```

## Tier 2: JSON Mode Integration

Tests the scoring pipeline without database.

### What It Tests

- Full scoring pipeline
- Trajectory loading from JSON
- Prompt construction
- End-to-end flow (minus training)

### Command

```bash
make tier2
```

Runs:

```bash
cd python && pytest tests/integration/test_json_mode_integration.py -v -x
```

### Test Setup

```python
# tests/integration/test_json_mode_integration.py

@pytest.fixture
def sample_trajectories():
    """Load test trajectories from fixtures."""
    return load_json_trajectories("tests/fixtures/sample_trajectories/")

def test_scoring_pipeline(sample_trajectories):
    for traj in sample_trajectories:
        score = score_trajectory(traj)
        assert 0.0 <= score <= 1.0

def test_prompt_construction(sample_trajectories):
    traj = sample_trajectories[0]
    messages = trajectory_to_messages(traj)
    assert messages[0]["role"] == "system"
    assert len(messages) >= 2
```

## Tier 3: Database Integration

Tests PostgreSQL connection and queries.

### What It Tests

- Database connection
- Trajectory loading from DB
- Window grouping
- Query performance

### Prerequisites

Docker must be running.

### Command

```bash
make tier3
```

This automatically:
1. Starts test PostgreSQL (`make db-up`)
2. Applies schema (`make db-migrate`)
3. Runs integration tests

```bash
cd python && DATABASE_URL=$DB_URL \
    pytest tests/integration/test_db_integration.py -v -x
```

### Test Database

Uses `docker-compose.test.yml`:

```yaml
services:
  postgres-test:
    image: postgres:15
    environment:
      POSTGRES_USER: babylon_test
      POSTGRES_PASSWORD: test_password
      POSTGRES_DB: babylon_test
    ports:
      - "5434:5432"  # Different port from production
```

### Example: DB Tests

```python
# tests/integration/test_db_integration.py

@pytest.fixture
async def db_pool():
    pool = await asyncpg.create_pool(os.environ['DATABASE_URL'])
    yield pool
    await pool.close()

async def test_load_trajectories(db_pool):
    env = BabylonRLAIFEnv(config)
    await env.setup()
    
    trajectories = await env._load_trajectories()
    assert len(trajectories) > 0

async def test_window_grouping(db_pool):
    env = BabylonRLAIFEnv(config)
    groups = await env._group_by_window()
    
    for window_id, trajs in groups.items():
        assert len(trajs) >= config.min_agents_per_window
```

## Tier 4: Full GPU Training

End-to-end training with GPU.

### What It Tests

- vLLM server startup
- Model loading
- Training step execution
- Checkpoint saving

### Prerequisites

- Docker (for database)
- CUDA GPU (12GB+)
- Training data (generated or imported)

### Command

```bash
make tier4
```

This runs:
1. Start database (`make db-up`)
2. Apply schema (`make db-migrate`)
3. Import test data (`make tier4-import`)
4. Run 1 training step

```bash
cd python && DATABASE_URL=$DB_URL WANDB_MODE=offline \
    python scripts/run_training.py \
    --profile 12gb \
    --steps 1 \
    --no-wandb \
    --skip-validation
```

### Generate Test Data

If no data exists:

```bash
make tier4-generate
# Generates 2 hours of simulation data
```

### Expected Output

```text
[INFO] Starting training with profile: 12gb
[INFO] Loaded 50 trajectories from database
[INFO] Starting vLLM server on port 8001...
[INFO] vLLM server ready
[INFO] Step 1/1 - Loss: 0.342
[INFO] Saved checkpoint to trained_models/step_1
[INFO] Training complete
✓ Tier 4 passed
```

## CI/CD Integration

### GitHub Actions

```yaml
# .github/workflows/training-tests.yml
jobs:
  tier1:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: '3.11'
      - run: cd packages/training && make venv
      - run: cd packages/training && make tier1

  tier2:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: '3.11'
      - run: cd packages/training && make venv
      - run: cd packages/training && make tier2

  tier3:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:15
        env:
          POSTGRES_USER: babylon_test
          POSTGRES_PASSWORD: test_password
        ports:
          - 5434:5432
    steps:
      - uses: actions/checkout@v4
      - run: cd packages/training && make tier3
```

Note: Tier 4 requires GPU and is typically run manually or on GPU-enabled runners.

## Debugging Failing Tests

### Tier 1 Failures

```bash
# Run with verbose output
cd python && pytest tests/test_rewards.py -v -s

# Run single test
pytest tests/test_rewards.py::test_pnl_reward_positive -v
```

### Tier 2 Failures

```bash
# Check fixture files exist
ls python/tests/fixtures/sample_trajectories/

# Run with debugging
pytest tests/integration/test_json_mode_integration.py -v --pdb
```

### Tier 3 Failures

```bash
# Check database is running
docker ps | grep postgres-test

# Check connection
psql postgresql://babylon_test:test_password@localhost:5434/babylon_test

# View logs
docker logs $(docker ps -q --filter name=postgres-test)
```

### Tier 4 Failures

```bash
# Check GPU
nvidia-smi

# Check vLLM can start
python -m vllm.entrypoints.openai.api_server \
    --model Qwen/Qwen2.5-0.5B-Instruct \
    --port 8001 \
    --gpu-memory-utilization 0.25

# Check training data
psql $DATABASE_URL -c "SELECT COUNT(*) FROM trajectories"
```

## Adding New Tests

### Unit Test

```python
# python/tests/test_my_feature.py
import pytest
from training.my_module import my_function

def test_my_function_basic():
    result = my_function(input_data)
    assert result == expected

def test_my_function_edge_case():
    with pytest.raises(ValueError):
        my_function(bad_input)
```

### Integration Test

```python
# python/tests/integration/test_my_integration.py
import pytest

@pytest.fixture
def setup_data():
    # Setup
    yield data
    # Teardown

def test_integration_flow(setup_data):
    # Test full flow
    pass
```

Register in Makefile if needed (most tests auto-discovered by pytest).

