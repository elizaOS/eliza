"""
Babylon RL Training System - Atropos + Tinker Framework

This package provides training infrastructure for Babylon trading agents:

1. **Tinker Training** (RECOMMENDED - Cloud-based)
   - `tinker_client.py` - Unified Tinker API wrapper
   - `tinker_trainer.py` - GRPO trainer using Tinker cloud
   - No local GPU required, access to large models

2. **Atropos Training** (Local GPU)
   - `atropos_trainer.py` - Local GRPO trainer with vLLM
   - `babylon_env.py` - RLAIF environment with LLM-as-judge

3. **Data & Utilities**
   - `rollout_generator.py` - Fast rollout generation
   - `rewards.py` - Reward functions
   - `quality_utils.py` - Trajectory quality scoring
"""

__version__ = "3.0.0"  # Major version bump for Tinker integration

# Import and re-export main components
from .data_bridge import (
    BabylonToAtroposConverter,
    PostgresTrajectoryReader,
    ScoredGroupResult,
    calculate_dropout_rate,
)
from .models import (
    AtroposScoredGroup,
    BabylonTrajectory,
    JudgeResponse,
    MarketOutcomes,
    TrainingBatchSummary,
    WindowStatistics,
)

# Import non-torch training components directly
from .training import (
    CallPurpose,
    # Multi-prompt dataset
    MultiPromptDatasetBuilder,
    PromptDataset,
    PromptSample,
    RewardNormalizer,
    # Tick reward attribution
    TickRewardAttributor,
    # Quality utilities
    calculate_tick_quality_score,
    calculate_trajectory_quality_score,
    composite_reward,
    get_available_archetypes,
    # Archetype utilities (no torch)
    get_rubric,
    # Reward functions
    pnl_reward,
)


# Lazy imports for torch/tinker-dependent modules
# These imports are dynamically returned via __getattr__ - not unused
def __getattr__(name: str):
    """Lazy import for torch/tinker-dependent modules."""
    # Atropos trainer (requires torch)
    if name in (
        "BabylonAtroposTrainer",
        "AtroposTrainingConfig",
    ):
        from .training.atropos_trainer import (
            AtroposTrainingConfig,
            BabylonAtroposTrainer,
        )

        return locals()[name]

    if name in (
        "BabylonRLAIFEnv",
        "BabylonEnvConfig",
    ):
        from .training.babylon_env import (
            BabylonEnvConfig,
            BabylonRLAIFEnv,
        )

        return locals()[name]

    # Tinker trainer (requires tinker)
    if name in (
        "BabylonTinkerClient",
        "TinkerConfig",
        "TinkerDatum",
        "TrainStepResult",
        "SampleResult",
        "TINKER_AVAILABLE",
    ):
        from .training.tinker_client import (
            TINKER_AVAILABLE,
            BabylonTinkerClient,
            SampleResult,
            TinkerConfig,
            TinkerDatum,
            TrainStepResult,
        )

        return locals()[name]

    if name in (
        "BabylonTinkerTrainer",
        "TinkerTrainingConfig",
    ):
        from .training.tinker_trainer import (
            BabylonTinkerTrainer,
            TinkerTrainingConfig,
        )

        return locals()[name]

    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


__all__ = [
    "TINKER_AVAILABLE",
    "AtroposScoredGroup",
    "AtroposTrainingConfig",
    # Atropos Training (lazy - requires torch) - Local fallback
    "BabylonAtroposTrainer",
    "BabylonEnvConfig",
    "BabylonRLAIFEnv",
    # Tinker Training (lazy - requires tinker) - RECOMMENDED
    "BabylonTinkerClient",
    "BabylonTinkerTrainer",
    "BabylonToAtroposConverter",
    # Models
    "BabylonTrajectory",
    "CallPurpose",
    "JudgeResponse",
    "MarketOutcomes",
    # Multi-prompt dataset (no torch)
    "MultiPromptDatasetBuilder",
    # Data Bridge
    "PostgresTrajectoryReader",
    "PromptDataset",
    "PromptSample",
    "RewardNormalizer",
    "SampleResult",
    "ScoredGroupResult",
    # Tick reward (no torch)
    "TickRewardAttributor",
    "TinkerConfig",
    "TinkerDatum",
    "TinkerTrainingConfig",
    "TrainStepResult",
    "TrainingBatchSummary",
    "WindowStatistics",
    "calculate_dropout_rate",
    # Quality utilities (no torch)
    "calculate_tick_quality_score",
    "calculate_trajectory_quality_score",
    "composite_reward",
    "get_available_archetypes",
    # Archetype utilities (no torch)
    "get_rubric",
    # Rewards (no torch)
    "pnl_reward",
]
