# Copyright (c) 2023 - 2025, AG2ai, Inc., AG2ai open-source projects maintainers and core contributors
#
# SPDX-License-Identifier: Apache-2.0

from typing import Optional

from pydantic import BaseModel

from ...doc_utils import export_module
from .available_condition import AvailableCondition
from .llm_condition import LLMCondition
from .targets.transition_target import TransitionTarget

__all__ = [
    "OnCondition",
]


@export_module("autogen")
class OnCondition(BaseModel):  # noqa: N801
    """Defines a condition for transitioning to another agent or nested chats.

    This is for LLM-based condition evaluation where these conditions are translated into tools and attached to the agent.

    These are evaluated after the OnCondition conditions but before the after work condition.

    Args:
        target (TransitionTarget): The transition (essentially an agent) to hand off to.
        condition (LLMCondition): The condition for transitioning to the target agent, evaluated by the LLM.
        available (AvailableCondition): Optional condition to determine if this OnCondition is included for the LLM to evaluate based on context variables using classes like StringAvailableCondition and ContextExpressionAvailableCondition.
        llm_function_name (Optional[str]): The name of the LLM function to use for this condition.
    """

    target: TransitionTarget
    condition: LLMCondition
    available: Optional[AvailableCondition] = None
    llm_function_name: Optional[str] = None

    def has_target_type(self, target_type: type) -> bool:
        """
        Check if the target type matches the specified type.

        Args:
            target_type (type): The target type to check against, which should be a subclass of TransitionTarget

        Returns:
            bool: True if the target type matches, False otherwise
        """
        return isinstance(self.target, target_type)

    def target_requires_wrapping(self) -> bool:
        """
        Check if the target requires wrapping in an agent.

        Returns:
            bool: True if the target requires wrapping, False otherwise
        """
        return self.target.needs_agent_wrapper()
