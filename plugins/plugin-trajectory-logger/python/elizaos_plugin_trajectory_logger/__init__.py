"""
elizaOS Trajectory Logger Plugin - capture and export agent trajectories.

This package provides:
- In-memory trajectory logging service
- ART / GRPO formatting helpers
- Simple heuristic reward scoring
"""

from elizaos_plugin_trajectory_logger.art_format import (
    extract_shared_prefix,
    group_trajectories,
    prepare_for_ruler,
    remove_shared_prefix,
    to_art_messages,
    to_art_trajectory,
    validate_art_compatibility,
)
from elizaos_plugin_trajectory_logger.eliza_service import (
    TRAJECTORY_LOGGER_SERVICE_TYPE,
    TrajectoryExportConfig,
    TrajectoryLoggerElizaService,
)
from elizaos_plugin_trajectory_logger.export import (
    ExportOptions,
    ExportResult,
    export_for_openpipe_art,
    export_grouped_for_grpo,
)
from elizaos_plugin_trajectory_logger.plugin import get_trajectory_logger_plugin
from elizaos_plugin_trajectory_logger.reward_service import RewardService, create_reward_service
from elizaos_plugin_trajectory_logger.runtime_service import (
    TrajectoryExportConfig as TrajectoryRuntimeExportConfig,
)
from elizaos_plugin_trajectory_logger.runtime_service import (
    TrajectoryLoggerRuntimeService,
)
from elizaos_plugin_trajectory_logger.service import TrajectoryLoggerService
from elizaos_plugin_trajectory_logger.types import (
    ActionAttempt,
    ARTTrajectory,
    ChatMessage,
    EnvironmentState,
    JsonValue,
    LLMCall,
    ProviderAccess,
    RewardComponents,
    TrainingBatch,
    Trajectory,
    TrajectoryGroup,
    TrajectoryMetrics,
    TrajectoryStep,
)

__all__ = [
    # Service
    "TrajectoryLoggerService",
    "get_trajectory_logger_plugin",
    "TrajectoryLoggerElizaService",
    "TRAJECTORY_LOGGER_SERVICE_TYPE",
    "TrajectoryExportConfig",
    "TrajectoryLoggerRuntimeService",
    "TrajectoryRuntimeExportConfig",
    # Types
    "JsonValue",
    "LLMCall",
    "ProviderAccess",
    "ActionAttempt",
    "EnvironmentState",
    "TrajectoryStep",
    "RewardComponents",
    "TrajectoryMetrics",
    "Trajectory",
    "ChatMessage",
    "ARTTrajectory",
    "TrajectoryGroup",
    "TrainingBatch",
    # ART helpers
    "to_art_messages",
    "to_art_trajectory",
    "group_trajectories",
    "extract_shared_prefix",
    "remove_shared_prefix",
    "prepare_for_ruler",
    "validate_art_compatibility",
    # Rewards
    "RewardService",
    "create_reward_service",
    # Export
    "ExportOptions",
    "ExportResult",
    "export_for_openpipe_art",
    "export_grouped_for_grpo",
]

__version__ = "1.2.0"
PLUGIN_NAME = "trajectory-logger"
PLUGIN_DESCRIPTION = "Trajectory logging utilities for elizaOS agents"
