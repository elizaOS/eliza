# Copyright (c) 2023 - 2025, AG2ai, Inc., AG2ai open-source projects maintainers and core contributors
#
# SPDX-License-Identifier: Apache-2.0

from typing import Optional

from pydantic import BaseModel

from .available_condition import AvailableCondition
from .context_condition import ContextCondition
from .targets.transition_target import TransitionTarget

__all__ = [
    "OnContextCondition",
]


class OnContextCondition(BaseModel):  # noqa: N801
    """Defines a condition for transitioning to another agent or nested chats using context variables and the ContextExpression class.

    This is for context variable-based condition evaluation (does not use the agent's LLM).

    These are evaluated before the OnCondition and after work conditions.

    Args:
        target (TransitionTarget): The transition (essentially an agent) to hand off to.
        condition (Optional[ContextCondition]): The context variable based condition for transitioning to the target agent. If None, the condition always evaluates to True.
        available (AvailableCondition): Optional condition to determine if this OnCondition is included for the LLM to evaluate based on context variables using classes like StringAvailableCondition and ContextExpressionAvailableCondition.
    """

    target: TransitionTarget
    condition: Optional[ContextCondition] = None
    available: Optional[AvailableCondition] = None

    def has_target_type(self, target_type: type) -> bool:
        """
        Check if the target type matches the specified type.

        Args:
            target_type (type): The target type to check against. Should be a subclass of TransitionTarget.

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
