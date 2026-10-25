# Copyright (c) 2023 - 2025, AG2ai, Inc., AG2ai open-source projects maintainers and core contributors
#
# SPDX-License-Identifier: Apache-2.0
#
# Portions derived from  https://github.com/microsoft/autogen are under the MIT License.
# SPDX-License-Identifier: MIT
from typing import Any

from .doc_utils import export_module

__all__ = [
    "AgentNameConflictError",
    "InvalidCarryOverTypeError",
    "ModelToolNotSupportedError",
    "NoEligibleSpeakerError",
    "SenderRequiredError",
    "UndefinedNextAgentError",
]


@export_module("autogen")
class AgentNameConflictError(Exception):  # noqa: N818
    def __init__(self, msg: str = "Found multiple agents with the same name.", *args: Any, **kwargs: Any):
        super().__init__(msg, *args, **kwargs)


@export_module("autogen")
class NoEligibleSpeakerError(Exception):  # noqa: N818
    """Exception raised for early termination of a GroupChat."""

    def __init__(self, message: str = "No eligible speakers."):
        self.message = message
        super().__init__(self.message)


@export_module("autogen")
class SenderRequiredError(Exception):  # noqa: N818
    """Exception raised when the sender is required but not provided."""

    def __init__(self, message: str = "Sender is required but not provided."):
        self.message = message
        super().__init__(self.message)


@export_module("autogen")
class InvalidCarryOverTypeError(Exception):  # noqa: N818
    """Exception raised when the carryover type is invalid."""

    def __init__(
        self, message: str = "Carryover should be a string or a list of strings. Not adding carryover to the message."
    ):
        self.message = message
        super().__init__(self.message)


@export_module("autogen")
class UndefinedNextAgentError(Exception):  # noqa: N818
    """Exception raised when the provided next agents list does not overlap with agents in the group."""

    def __init__(self, message: str = "The provided agents list does not overlap with agents in the group."):
        self.message = message
        super().__init__(self.message)


class ModelToolNotSupportedError(Exception):
    """Exception raised when attempting to use tools with models that do not support them."""

    def __init__(
        self,
        model: str,
    ):
        self.message = f"Tools are not supported with {model} models. Refer to the documentation at https://platform.openai.com/docs/guides/reasoning#limitations"
        super().__init__(self.message)
