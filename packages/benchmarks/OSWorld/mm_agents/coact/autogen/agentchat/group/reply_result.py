# Copyright (c) 2023 - 2025, AG2ai, Inc., AG2ai open-source projects maintainers and core contributors
#
# SPDX-License-Identifier: Apache-2.0


__all__ = ["ReplyResult"]


from typing import Optional

from pydantic import BaseModel

from .context_variables import ContextVariables
from .targets.transition_target import TransitionTarget


class ReplyResult(BaseModel):
    """Result of a tool call that is used to provide the return message and the target to transition to."""

    message: str
    target: Optional[TransitionTarget] = None
    context_variables: Optional[ContextVariables] = None

    def __str__(self) -> str:
        """The string representation for ReplyResult will be just the message."""
        return self.message
