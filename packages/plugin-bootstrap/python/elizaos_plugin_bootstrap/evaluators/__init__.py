"""
Evaluators for the elizaOS Bootstrap Plugin.

This module exports all available evaluators for the bootstrap plugin.
"""

from .goal import goal_evaluator
from .reflection import reflection_evaluator

__all__ = [
    "goal_evaluator",
    "reflection_evaluator",
]

# All evaluators list for easy registration
ALL_EVALUATORS = [
    goal_evaluator,
    reflection_evaluator,
]

