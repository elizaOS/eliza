"""
ElizaOS Integration for ART Training

Full integration with the ElizaOS agent runtime:
- Uses REAL AgentRuntime with character and plugins
- Message processing through message_service.handle_message
- Actions registered and invoked properly
- Providers supplying context
- basicCapabilities enabled by default

Integrates with ElizaOS plugins:
- plugin-trajectory-logger: Trajectory capture and export
- plugin-local-ai: Local GGUF model inference
- plugin-localdb: Persistent storage for trajectories and checkpoints
"""

from elizaos_art.eliza_integration.runtime_integration import (
    ARTRuntime,
    ARTRuntimeConfig,
    create_art_plugin,
    create_art_runtime,
    create_game_action,
    create_game_state_provider,
)
from elizaos_art.eliza_integration.storage_adapter import (
    ElizaStorageAdapter,
    TrajectoryStore,
)
from elizaos_art.eliza_integration.trajectory_adapter import (
    ElizaEnvironmentState,
    ElizaLLMCall,
    ElizaTrajectoryLogger,
    convert_to_eliza_trajectory,
)
from elizaos_art.eliza_integration.local_ai_adapter import (
    ElizaLocalAIProvider,
    LocalModelConfig,
    MockLocalAIProvider,
)
from elizaos_art.eliza_integration.export import (
    export_trajectories_art_format,
    export_trajectories_jsonl,
)

__all__ = [
    # Core Runtime
    "ARTRuntime",
    "ARTRuntimeConfig",
    "create_art_runtime",
    # Plugin creation
    "create_art_plugin",
    "create_game_action",
    "create_game_state_provider",
    # Trajectory logging
    "ElizaTrajectoryLogger",
    "ElizaLLMCall",
    "ElizaEnvironmentState",
    "convert_to_eliza_trajectory",
    # Local AI
    "ElizaLocalAIProvider",
    "LocalModelConfig",
    "MockLocalAIProvider",
    # Storage
    "ElizaStorageAdapter",
    "TrajectoryStore",
    # Export
    "export_trajectories_art_format",
    "export_trajectories_jsonl",
]
