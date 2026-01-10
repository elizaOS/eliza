"""
elizaOS Goals Plugin - Goal management and tracking.

This plugin provides goal management functionality for tracking and achieving objectives.
"""

from elizaos_plugin_goals.types import Goal, GoalStatus, GoalOwnerType
from elizaos_plugin_goals.prompts import (
    EXTRACT_GOAL_TEMPLATE,
    CHECK_SIMILARITY_TEMPLATE,
    build_extract_goal_prompt,
    build_check_similarity_prompt,
)
from elizaos_plugin_goals.service import GoalDataService

__all__ = [
    "Goal",
    "GoalStatus",
    "GoalOwnerType",
    "GoalDataService",
    "EXTRACT_GOAL_TEMPLATE",
    "CHECK_SIMILARITY_TEMPLATE",
    "build_extract_goal_prompt",
    "build_check_similarity_prompt",
]

__version__ = "1.2.0"

