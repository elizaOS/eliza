"""
ElizaOS Integration for ART Training

Provides seamless integration with ElizaOS plugins:
- plugin-trajectory-logger: Capture and export trajectories
- plugin-local-ai: Local GGUF model inference  
- plugin-localdb: Persistent storage for trajectories and checkpoints
"""

from elizaos_art.eliza_integration.trajectory_adapter import (
    ElizaTrajectoryLogger,
    convert_to_eliza_trajectory,
)
from elizaos_art.eliza_integration.local_ai_adapter import (
    ElizaLocalAIProvider,
    LocalModelConfig,
)
from elizaos_art.eliza_integration.storage_adapter import (
    ElizaStorageAdapter,
    TrajectoryStore,
)
from elizaos_art.eliza_integration.runtime_integration import (
    create_art_runtime,
    ARTRuntimeConfig,
)

__all__ = [
    # Trajectory logging
    "ElizaTrajectoryLogger",
    "convert_to_eliza_trajectory",
    # Local AI
    "ElizaLocalAIProvider", 
    "LocalModelConfig",
    # Storage
    "ElizaStorageAdapter",
    "TrajectoryStore",
    # Runtime
    "create_art_runtime",
    "ARTRuntimeConfig",
]
