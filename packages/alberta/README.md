# Alberta Framework

[![CI](https://github.com/j-klawson/alberta-framework/actions/workflows/ci.yml/badge.svg)](https://github.com/j-klawson/alberta-framework/actions/workflows/ci.yml)
[![PyPI](https://img.shields.io/pypi/v/alberta-framework.svg)](https://pypi.org/project/alberta-framework/)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Python 3.12+](https://img.shields.io/badge/python-3.12+-blue.svg)](https://www.python.org/downloads/)

A JAX-based research framework implementing [The Alberta Plan for AI Research](https://arxiv.org/abs/2208.11173). All 12 steps are implemented and benchmarked.

Every component updates at every time step with no special training phases or resets.

## Install

```bash
pip install alberta-framework
pip install alberta-framework[gymnasium]   # RL environment support
pip install alberta-framework[dev]         # tests, lint
```

Requires Python 3.12+, JAX 0.4+.

## What's here

The Alberta Plan is a 12-step research programme for building continual AI. This framework implements all 12 steps:

| Steps | Focus | Key classes |
|-------|-------|-------------|
| 1 | Adaptive step-size prediction | `LinearLearner`, `IDBD`, `Autostep` |
| 2 | Nonlinear function approximation | `MLPLearner`, `ObGDBounding` |
| 3 | GVF predictions, Horde architecture | `HordeLearner`, `GVFSpec`, `HordeSpec` |
| 4 | Continual control (SARSA + actor-critic) | `SARSAAgent`, `ActorCriticAgent` |
| 5–6 | Average-reward continuing control | `AverageRewardHordeLearner`, `DifferentialSARSAAgent` |
| 7–8 | Dyna planning + one-step world model | `OneStepWorldModel`, `ActionConditionedWorldModel` |
| 9 | Guarded dreaming (error-gated imagined transitions) | `GuardedDreamer` |
| 10 | STOMP temporal abstraction (options) | `STOMPAgent` |
| 11 | OaK option keyboard (utility tracking + curation) | `OaKAgent` |
| 12 | Prototype-IA (exo-cerebellum + exo-cortex) | `PrototypeAgent` |

## Quick start

### Adaptive step-size prediction

```python
import jax.random as jr
from alberta_framework import (
    LinearLearner, IDBD, Autostep,
    ObGDBounding, EMANormalizer,
    RandomWalkStream, run_learning_loop,
)

# Non-stationary prediction: target weights drift over time
stream = RandomWalkStream(feature_dim=10, drift_rate=0.01)

# IDBD: per-weight adaptive step-sizes via gradient correlation (Sutton 1992)
learner = LinearLearner(optimizer=IDBD())
state, metrics = run_learning_loop(learner, stream, num_steps=10000, key=jr.key(42))

# Autostep: tuning-free, self-normalized (Mahmood et al. 2012)
learner = LinearLearner(optimizer=Autostep())
state, metrics = run_learning_loop(learner, stream, num_steps=10000, key=jr.key(42))
```

### Nonlinear function approximation

```python
from alberta_framework import MLPLearner, ObGDBounding, EMANormalizer, run_mlp_learning_loop

# Architecture: Input → [Dense → LayerNorm → LeakyReLU] × N → Dense(1)
mlp = MLPLearner(
    hidden_sizes=(128, 128),
    optimizer=Autostep(),
    bounder=ObGDBounding(kappa=2.0),      # prevents overshooting (Elsayed et al. 2024)
    normalizer=EMANormalizer(decay=0.99), # EMA normalization for non-stationary inputs
)
state, metrics = run_mlp_learning_loop(mlp, stream, num_steps=10000, key=jr.key(42))
```

### GVF / Horde predictions

```python
from alberta_framework import HordeLearner
from alberta_framework.core.types import GVFSpec, DemonType, create_horde_spec

horde_spec = create_horde_spec([
    GVFSpec(name="reward_pred", demon_type=DemonType.PREDICTION, gamma=0.99, lamda=0.9, cumulant_index=0),
    GVFSpec(name="next_obs",    demon_type=DemonType.PREDICTION, gamma=0.95, lamda=0.0, cumulant_index=1),
])

horde = HordeLearner(horde_spec=horde_spec, hidden_sizes=(64, 64))
state = horde.init(feature_dim=20, key=jr.key(0))
```

### SARSA control

```python
from alberta_framework import SARSAAgent, SARSAConfig

agent = SARSAAgent(
    sarsa_config=SARSAConfig(
        n_actions=4,
        gamma=0.99,
        epsilon_start=0.1,
        epsilon_end=0.01,
        epsilon_decay_steps=50000,
    ),
    hidden_sizes=(64, 64),
    optimizer=Autostep(),
)

state = agent.init(feature_dim=20, key=jr.key(0))
state, action = agent.select_action(state, obs, key)
state = agent.update(state, obs, action, reward, next_obs, next_action)
```

### Average-reward continuing control (Steps 5–6)

```python
from alberta_framework import AverageRewardHordeLearner, DifferentialSARSAAgent
```

### Full prototype agent (Steps 1–12)

`PrototypeAgent` integrates all 12 steps into a single agent: GRU perception, average-reward Horde learning, Dyna planning with guarded dreaming, STOMP options, OaK option curation, and Prototype-IA augmentation.

```python
from alberta_framework.core.prototype_agent import PrototypeAgent, PrototypeAgentConfig
from alberta_framework.core.oak import OaKConfig
from alberta_framework.core.options import STOMPConfig, SubtaskSpec
```

See [docs](https://j-klawson.github.io/alberta-framework) for full construction examples.

## Core abstractions

**Learners** compose three independent concerns:

```python
LinearLearner(optimizer=..., bounder=..., normalizer=...)
MLPLearner(hidden_sizes=..., optimizer=..., bounder=..., normalizer=...)
```

**Optimizers:**
- `LMS` — fixed step-size baseline
- `IDBD` — per-weight adaptive step-sizes (Sutton 1992); extends to MLPs via `(∂y/∂w)²` h-decay generalization ([Meyer](https://github.com/ejmejm/phd_research/blob/main/phd/jax_core/optimizers/idbd.py))
- `Autostep` — tuning-free with gradient normalization (Mahmood et al. 2012)
- `TDIDBD`, `AutoTDIDBD` — TD variants with eligibility traces (Kearney et al. 2019)

**Bounders:**
- `ObGDBounding` — dynamic bounding to prevent overshooting (Elsayed et al. 2024)
- `AGCBounding` — per-unit gradient clipping scaled by weight norm (Brock et al. 2021)

**Normalizers:**
- `EMANormalizer` — exponential moving average; non-stationary inputs
- `WelfordNormalizer` — Welford's algorithm; stationary inputs

**Streams** — non-stationary experience generators implementing `ScanStream`:
- `RandomWalkStream`, `AbruptChangeStream`, `PeriodicChangeStream`
- `DynamicScaleShiftStream`, `ScaleDriftStream`

## JAX design

Everything is built for `jax.lax.scan` — learning loops are JIT-compiled. States are immutable `@chex.dataclass(frozen=True)` PyTrees. Keys are passed explicitly.

```python
# Multi-seed experiment via vmap
from alberta_framework.utils import run_multi_seed_experiment

results = run_multi_seed_experiment(
    configs=[lms_config, idbd_config, autostep_config],
    seeds=30,
)
```

## Gymnasium

```python
from alberta_framework.streams.gymnasium import collect_trajectory, PredictionMode
import gymnasium as gym

env = gym.make("CartPole-v1")
obs, targets = collect_trajectory(env, policy, num_steps=10000, mode=PredictionMode.REWARD)
```

## Docs

```bash
pip install alberta-framework[docs]
mkdocs serve   # http://localhost:8000
```

## References

- Sutton, Bowling, Pilarski (2022) — [The Alberta Plan for AI Research](https://arxiv.org/abs/2208.11173)
- Sutton (1992) — Adapting Bias by Gradient Descent (IDBD)
- Mahmood, Sutton, Degris, Pilarski (2012) — Tuning-free Step-size Adaptation (Autostep)
- Kearney et al. (2019) — Learning Feature Relevance Through Step Size Adaptation in TD (TDIDBD)
- Elsayed, Lan, Lim, Mahmood (2024) — [Streaming Deep RL Finally Works](https://arxiv.org/abs/2410.14606) (ObGD)
- Brock, De, Smith, Simonyan (2021) — High-Performance Large-Scale Image Recognition Without Normalization (AGC)
- Meyer (2025) — [IDBD for MLPs](https://github.com/ejmejm/phd_research/blob/main/phd/jax_core/optimizers/idbd.py)

## License

Apache 2.0
