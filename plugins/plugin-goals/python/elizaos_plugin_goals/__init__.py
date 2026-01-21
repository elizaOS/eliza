"""
elizaOS Goals Plugin - Goal management and tracking.

This plugin provides goal management functionality for tracking and achieving objectives.
"""

from elizaos_plugin_goals.actions import (
    CancelGoalAction,
    CompleteGoalAction,
    ConfirmGoalAction,
    CreateGoalAction,
    UpdateGoalAction,
)
from elizaos_plugin_goals.plugin import goals_plugin
from elizaos_plugin_goals.prompts import (
    CHECK_SIMILARITY_TEMPLATE,
    EXTRACT_CANCELLATION_TEMPLATE,
    EXTRACT_CONFIRMATION_TEMPLATE,
    EXTRACT_GOAL_SELECTION_TEMPLATE,
    EXTRACT_GOAL_TEMPLATE,
    EXTRACT_GOAL_UPDATE_TEMPLATE,
    build_check_similarity_prompt,
    build_extract_cancellation_prompt,
    build_extract_confirmation_prompt,
    build_extract_goal_prompt,
    build_extract_goal_selection_prompt,
    build_extract_goal_update_prompt,
)
from elizaos_plugin_goals.providers import GoalsProvider
from elizaos_plugin_goals.service import GoalDataService, GoalDataServiceWrapper
from elizaos_plugin_goals.types import (
    ConfirmationResult,
    CreateGoalParams,
    ExtractedGoalInfo,
    Goal,
    GoalFilters,
    GoalOwnerType,
    GoalSelectionResult,
    GoalStatus,
    GoalTag,
    SimilarityCheckResult,
    UpdateGoalParams,
)

__all__ = [
    # Actions
    "CreateGoalAction",
    "CompleteGoalAction",
    "ConfirmGoalAction",
    "UpdateGoalAction",
    "CancelGoalAction",
    # Providers
    "GoalsProvider",
    # Plugin (python runtime)
    "goals_plugin",
    # Types
    "Goal",
    "GoalTag",
    "GoalStatus",
    "GoalOwnerType",
    "GoalFilters",
    "CreateGoalParams",
    "UpdateGoalParams",
    "ExtractedGoalInfo",
    "SimilarityCheckResult",
    "GoalSelectionResult",
    "ConfirmationResult",
    # Service
    "GoalDataService",
    "GoalDataServiceWrapper",
    # Prompt Templates
    "EXTRACT_GOAL_TEMPLATE",
    "CHECK_SIMILARITY_TEMPLATE",
    "EXTRACT_CANCELLATION_TEMPLATE",
    "EXTRACT_CONFIRMATION_TEMPLATE",
    "EXTRACT_GOAL_SELECTION_TEMPLATE",
    "EXTRACT_GOAL_UPDATE_TEMPLATE",
    # Prompt Builders
    "build_extract_goal_prompt",
    "build_check_similarity_prompt",
    "build_extract_cancellation_prompt",
    "build_extract_confirmation_prompt",
    "build_extract_goal_selection_prompt",
    "build_extract_goal_update_prompt",
]

__version__ = "1.2.0"
PLUGIN_NAME = "goals"
PLUGIN_DESCRIPTION = "Goal management and tracking for elizaOS agents"
