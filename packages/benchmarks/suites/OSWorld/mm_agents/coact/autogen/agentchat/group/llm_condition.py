# Copyright (c) 2023 - 2025, AG2ai, Inc., AG2ai open-source projects maintainers and core contributors
#
# SPDX-License-Identifier: Apache-2.0

from typing import TYPE_CHECKING, Any

from pydantic import BaseModel

from .context_str import ContextStr

if TYPE_CHECKING:
    # Avoid circular import
    from ..conversable_agent import ConversableAgent

__all__ = ["ContextStrLLMCondition", "LLMCondition", "StringLLMCondition"]


class LLMCondition(BaseModel):
    """Protocol for conditions evaluated by an LLM."""

    def get_prompt(self, agent: "ConversableAgent", messages: list[dict[str, Any]]) -> str:
        """Get the prompt text for LLM evaluation.

        Args:
            agent: The agent evaluating the condition
            messages: The conversation history

        Returns:
            The prompt text to be evaluated by the LLM
        """
        raise NotImplementedError("Requires subclasses to implement.")


class StringLLMCondition(LLMCondition):
    """Simple string-based LLM condition.

    This condition provides a static string prompt to be evaluated by an LLM.
    """

    prompt: str

    def __init__(self, prompt: str, **data: Any) -> None:
        """Initialize with a prompt string as a positional parameter.

        Args:
            prompt: The static prompt string to evaluate
            data: Additional data for the parent class
        """
        super().__init__(prompt=prompt, **data)

    def get_prompt(self, agent: "ConversableAgent", messages: list[dict[str, Any]]) -> str:
        """Return the static prompt string.

        Args:
            agent: The agent evaluating the condition (not used)
            messages: The conversation history (not used)

        Returns:
            The static prompt string
        """
        return self.prompt


class ContextStrLLMCondition(LLMCondition):
    """Context variable-based LLM condition.

    This condition uses a ContextStr object with context variable placeholders that
    will be substituted before being evaluated by an LLM.
    """

    context_str: ContextStr

    def __init__(self, context_str: ContextStr, **data: Any) -> None:
        """Initialize with a context string as a positional parameter.

        Args:
            context_str: The ContextStr object with variable placeholders
            data: Additional data for the parent class
        """
        super().__init__(context_str=context_str, **data)

    def get_prompt(self, agent: "ConversableAgent", messages: list[dict[str, Any]]) -> str:
        """Return the prompt with context variables substituted.

        Args:
            agent: The agent evaluating the condition (provides context variables)
            messages: The conversation history (not used)

        Returns:
            The prompt with context variables substituted
        """
        result = self.context_str.format(agent.context_variables)
        return result if result is not None else ""
