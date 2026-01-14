from collections.abc import Callable, Coroutine
from dataclasses import dataclass
from typing import Any, Protocol, TypedDict


class Memory(TypedDict, total=False):
    content: dict[str, str | dict[str, str]]


class State(TypedDict, total=False):
    pass


class ActionResult(TypedDict, total=False):
    text: str
    success: bool
    data: dict[str, str | int | float | bool | list | dict | None]


class RuntimeProtocol(Protocol):
    def get_setting(self, key: str) -> str | None: ...

    def get_service(self, name: str) -> object | None: ...

    async def use_model(self, model_type: str, params: dict[str, Any]) -> str | None: ...


HandlerCallback = Callable[[dict[str, Any]], Coroutine[Any, Any, None]]

ValidateFunc = Callable[[RuntimeProtocol, Memory, State | None], Coroutine[Any, Any, bool]]

HandlerFunc = Callable[
    [RuntimeProtocol, Memory, State | None, dict[str, Any] | None, HandlerCallback | None],
    Coroutine[Any, Any, ActionResult],
]


@dataclass
class ActionExample:
    name: str
    content: dict[str, Any]


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
