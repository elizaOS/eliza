# Abstract backend base‑class
# ---------------------------------------------------------------------------
from abc import ABC, abstractmethod
from typing import Any, List, Type, Dict, Set
from ..Action import (
    Action
)


class Backend(ABC):
    """Abstract base for platform back‑ends."""

    #: Each backend advertises which Action subclasses it supports.
    _supported: Set[Type[Action]] = set()

    # ---------------------------------------------------------------------
    def supports(self, action_type: Type[Action]) -> bool:
        return action_type in self._supported

    # ---------------------------------------------------------------------
    @abstractmethod
    def execute(self, action: Action) ->  Any:
        """Translate an *Action* into concrete commands.

        Should raise **NotImplementedError** if the *action* type is not in
        `self._supported`, so upper layers can decide how to degrade / retry.
        """

