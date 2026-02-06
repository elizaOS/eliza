"""Base action types for the plugin manager plugin."""

from __future__ import annotations

from collections.abc import Callable, Coroutine
from dataclasses import dataclass
from typing import Protocol


class Memory(dict[str, dict[str, str] | str | None]):
    """Message memory."""


class State(dict[str, str | int | float | bool | None]):
    """State dictionary."""


class ActionResult(dict[str, str | bool | dict[str, str | int | float | bool | None] | None]):
    """Action result dictionary."""


class RuntimeProtocol(Protocol):
    def get_setting(self, key: str) -> str | None: ...
    def get_service(self, name: str) -> object | None: ...


HandlerCallback = Callable[[dict[str, str | list[str]]], Coroutine[object, object, None]]

ValidateFunc = Callable[
    [RuntimeProtocol, Memory, State | None],
    Coroutine[object, object, bool],
]

HandlerFunc = Callable[
    [
        RuntimeProtocol,
        Memory,
        State | None,
        dict[str, str | int | float | bool | None] | None,
        HandlerCallback | None,
    ],
    Coroutine[object, object, ActionResult],
]


@dataclass
class ActionExample:
    name: str
    content: dict[str, str | list[str] | bool]


@dataclass
class Action:
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
    return Action(
        name=name,
        description=description,
        similes=similes,
        examples=examples,
        validate=validate,
        handler=handler,
    )
