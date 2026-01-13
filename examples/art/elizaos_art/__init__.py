"""
ElizaOS ART (Adaptive Reinforcement Training) Package

Continuous reinforcement learning system for training local LLMs
using OpenPipe's ART framework with GRPO.

Integrates with ElizaOS plugins:
- plugin-trajectory-logger: Trajectory capture and export
- plugin-local-ai: Local GGUF model inference
- plugin-localdb: Persistent storage
"""

from elizaos_art.base import (
    Action,
    BaseAgent,
    BaseEnvironment,
    EpisodeResult,
    State,
    TrainingConfig,
    TrainingMetrics,
    Trajectory,
)

__version__ = "1.0.0"

__all__ = [
    # Base classes
    "BaseEnvironment",
    "BaseAgent",
    "State",
    "Action",
    "EpisodeResult",
    "Trajectory",
    # Training
    "TrainingConfig",
    "TrainingMetrics",
]


# Lazy import ElizaOS integration to avoid import errors when not installed
def __getattr__(name: str):
    """Lazy load ElizaOS integration components."""
    eliza_exports = {
        "ElizaTrajectoryLogger",
        "ElizaLocalAIProvider",
        "ElizaStorageAdapter",
        "ARTRuntime",
        "ARTRuntimeConfig",
        "create_art_runtime",
        "LocalModelConfig",
        "TrajectoryStore",
    }

    if name in eliza_exports:
        from elizaos_art import eliza_integration

        return getattr(eliza_integration, name)

    if name in {"GRPOTrainer", "RulerScorer"}:
        # Avoid importing heavy training deps (openpipe-art, torch, etc.) unless needed.
        from elizaos_art.trainer import GRPOTrainer, RulerScorer

        return GRPOTrainer if name == "GRPOTrainer" else RulerScorer

    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
