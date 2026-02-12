"""
ElizaOS RL Training System - Atropos + Tinker Framework

This package provides training infrastructure for autonomous trading agents:

1. **Tinker Training** (RECOMMENDED - Cloud-based)
   - `tinker_client.py` - Unified Tinker API wrapper
   - `tinker_trainer.py` - GRPO trainer using Tinker cloud
   - No local GPU required, access to large models

2. **Atropos Training** (Local GPU)
   - `atropos_trainer.py` - Local GRPO trainer with vLLM
   - `rlaif_env.py` - RLAIF environment with pluggable scoring modes

3. **Data & Utilities**
   - `rollout_generator.py` - Fast rollout generation
   - `rewards.py` - Reward functions
   - `quality_utils.py` - Trajectory quality scoring
"""

__version__ = "3.0.0"  # Major version bump for Tinker integration

# Import and re-export main components
from .models import (
    TrainingTrajectory,
    BabylonTrajectory,
    MarketOutcomes,
    WindowStatistics,
    TrainingBatchSummary,
    AtroposScoredGroup,
    JudgeResponse,
)

from .data_bridge import (
    PostgresTrajectoryReader,
    TrajectoryToAtroposConverter,
    BabylonToAtroposConverter,
    ScoredGroupResult,
    calculate_dropout_rate,
)

# Import non-torch training components directly
from .training import (
    # Reward functions
    pnl_reward,
    composite_reward,
    RewardNormalizer,
    # Quality utilities
    calculate_tick_quality_score,
    calculate_trajectory_quality_score,
    # Multi-prompt dataset
    MultiPromptDatasetBuilder,
    PromptDataset,
    PromptSample,
    # Tick reward attribution
    TickRewardAttributor,
    CallPurpose,
    # Archetype utilities (no torch)
    get_rubric,
    get_available_archetypes,
)


# Lazy imports for torch/tinker-dependent modules
# These imports are dynamically returned via __getattr__ - not unused  # noqa: F401
def __getattr__(name: str):
    """Lazy import for torch/tinker-dependent modules."""
    # Atropos trainer (requires torch)
    if name in (
        "AtroposTrainer",
        "BabylonAtroposTrainer",
        "AtroposTrainingConfig",
    ):
        from .training.atropos_trainer import (  # noqa: F401
            AtroposTrainer,
            BabylonAtroposTrainer,
            AtroposTrainingConfig,
        )
        return locals()[name]
    
    if name in (
        "RLAIFEnv",
        "RLAIFEnvConfig",
        "BabylonRLAIFEnv",
        "BabylonEnvConfig",
    ):
        from .training.rlaif_env import (  # noqa: F401
            RLAIFEnv,
            RLAIFEnvConfig,
            BabylonRLAIFEnv,
            BabylonEnvConfig,
        )
        return locals()[name]
    
    # Tinker trainer (requires tinker)
    if name in (
        "TinkerClient",
        "BabylonTinkerClient",
        "TinkerConfig",
        "TinkerDatum",
        "TrainStepResult",
        "SampleResult",
        "TINKER_AVAILABLE",
    ):
        from .training.tinker_client import (  # noqa: F401
            TinkerClient,
            BabylonTinkerClient,
            TinkerConfig,
            TinkerDatum,
            TrainStepResult,
            SampleResult,
            TINKER_AVAILABLE,
        )
        return locals()[name]
    
    if name in (
        "TinkerTrainer",
        "BabylonTinkerTrainer",
        "TinkerTrainingConfig",
    ):
        from .training.tinker_trainer import (  # noqa: F401
            TinkerTrainer,
            BabylonTinkerTrainer,
            TinkerTrainingConfig,
        )
        return locals()[name]
    
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


__all__ = [
    # Models
    "TrainingTrajectory",
    "BabylonTrajectory",
    "MarketOutcomes",
    "WindowStatistics",
    "TrainingBatchSummary",
    "AtroposScoredGroup",
    "JudgeResponse",
    
    # Data Bridge
    "PostgresTrajectoryReader",
    "TrajectoryToAtroposConverter",
    "BabylonToAtroposConverter",
    "ScoredGroupResult",
    "calculate_dropout_rate",
    
    # Tinker Training (lazy - requires tinker) - RECOMMENDED
    "TinkerClient",
    "BabylonTinkerClient",
    "TinkerConfig",
    "TinkerDatum",
    "TrainStepResult",
    "SampleResult",
    "TINKER_AVAILABLE",
    "TinkerTrainer",
    "BabylonTinkerTrainer",
    "TinkerTrainingConfig",
    
    # Atropos Training (lazy - requires torch) - Local fallback
    "AtroposTrainer",
    "BabylonAtroposTrainer",
    "AtroposTrainingConfig",
    "RLAIFEnv",
    "RLAIFEnvConfig",
    "BabylonRLAIFEnv",
    "BabylonEnvConfig",
    
    # Rewards (no torch)
    "pnl_reward",
    "composite_reward",
    "RewardNormalizer",
    
    # Quality utilities (no torch)
    "calculate_tick_quality_score",
    "calculate_trajectory_quality_score",
    
    # Multi-prompt dataset (no torch)
    "MultiPromptDatasetBuilder",
    "PromptDataset",
    "PromptSample",
    
    # Tick reward (no torch)
    "TickRewardAttributor",
    "CallPurpose",
    
    # Archetype utilities (no torch)
    "get_rubric",
    "get_available_archetypes",
]
