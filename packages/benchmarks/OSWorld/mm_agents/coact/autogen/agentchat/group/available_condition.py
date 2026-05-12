# Copyright (c) 2023 - 2025, AG2ai, Inc., AG2ai open-source projects maintainers and core contributors
#
# SPDX-License-Identifier: Apache-2.0

from typing import TYPE_CHECKING, Any

from pydantic import BaseModel

from .context_expression import ContextExpression

if TYPE_CHECKING:
    # Avoid circular import
    from ..conversable_agent import ConversableAgent

__all__ = ["AvailableCondition", "ExpressionAvailableCondition", "StringAvailableCondition"]


class AvailableCondition(BaseModel):
    """Protocol for determining if a condition is available to be evaluated."""

    def is_available(self, agent: "ConversableAgent", messages: list[dict[str, Any]]) -> bool:
        """Determine if the condition should be considered for evaluation.

        Args:
            agent: The agent evaluating the condition
            messages: The conversation history

        Returns:
            True if the condition should be evaluated, False otherwise
        """
        raise NotImplementedError("Requires subclasses to implement.")


class StringAvailableCondition(AvailableCondition):
    """String-based available condition.

    This condition checks if a named context variable exists and is truthy.
    """

    context_variable: str

    def __init__(self, context_variable: str, **data: Any) -> None:
        """Initialize with a context variable name as a positional parameter.

        Args:
            context_variable: The name of the context variable to check
            data: Additional data for the parent class
        """
        super().__init__(context_variable=context_variable, **data)

    def is_available(self, agent: "ConversableAgent", messages: list[dict[str, Any]]) -> bool:
        """Check if the named context variable is truthy.

        Args:
            agent: The agent with context variables
            messages: The conversation history (not used)

        Returns:
            True if the variable exists and is truthy, False otherwise
        """
        return bool(agent.context_variables.get(self.context_variable, False))


class ExpressionAvailableCondition(AvailableCondition):
    """Expression-based available condition.

    This condition evaluates a ContextExpression against the context variables.
    """

    expression: ContextExpression

    def __init__(self, expression: ContextExpression, **data: Any) -> None:
        """Initialize with an expression as a positional parameter.

        Args:
            expression: The context expression to evaluate
            data: Additional data for the parent class
        """
        super().__init__(expression=expression, **data)

    def is_available(self, agent: "ConversableAgent", messages: list[dict[str, Any]]) -> bool:
        """Evaluate the expression against the context variables.

        Args:
            agent: The agent with context variables
            messages: The conversation history (not used)

        Returns:
            Boolean result of the expression evaluation
        """
        return self.expression.evaluate(agent.context_variables)
