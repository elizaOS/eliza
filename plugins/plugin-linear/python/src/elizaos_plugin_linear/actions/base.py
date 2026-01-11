"""Base types and utilities for actions."""

from collections.abc import Callable, Coroutine
from dataclasses import dataclass
from typing import Any, Protocol, TypedDict


class Memory(TypedDict, total=False):
    """Memory/message data structure."""

    content: dict[str, Any]


class State(TypedDict, total=False):
    """State data structure."""

    pass


class ActionResult(TypedDict, total=False):
    """Result from an action handler."""

    text: str
    success: bool
    data: dict[str, Any]


class RuntimeProtocol(Protocol):
    """Protocol for ElizaOS runtime."""

    def get_setting(self, key: str) -> str | None:
        """Get a setting value."""
        ...

    def get_service(self, name: str) -> Any:
        """Get a service by name."""
        ...

    async def use_model(self, model_type: str, params: dict[str, Any]) -> str | None:
        """Use an AI model."""
        ...


HandlerCallback = Callable[[dict[str, Any]], Coroutine[Any, Any, None]]

ValidateFunc = Callable[[RuntimeProtocol, Memory, State | None], Coroutine[Any, Any, bool]]

HandlerFunc = Callable[
    [RuntimeProtocol, Memory, State | None, dict[str, Any] | None, HandlerCallback | None],
    Coroutine[Any, Any, ActionResult],
]


@dataclass
class ActionExample:
    """Example of action usage."""

    name: str
    content: dict[str, Any]


@dataclass
class Action:
    """Action definition."""

    name: str
    description: str
    similes: list[str]
    examples: list[list[ActionExample]]
    validate: ValidateFunc
    handler: HandlerFunc


def create_action(
    name: str,
    description: str,
    similes: list[str],
    examples: list[list[ActionExample]],
    validate: ValidateFunc,
    handler: HandlerFunc,
) -> Action:
    """Create an action definition."""
    return Action(
        name=name,
        description=description,
        similes=similes,
        examples=examples,
        validate=validate,
        handler=handler,
    )





