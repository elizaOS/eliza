"""Base types for action definitions following the ElizaOS plugin pattern."""

from collections.abc import Callable, Coroutine
from dataclasses import dataclass
from typing import Protocol, TypedDict


class MemoryContent(TypedDict, total=False):
    text: str
    source: str


class Memory(TypedDict, total=False):
    id: str
    agentId: str
    roomId: str
    userId: str
    content: MemoryContent
    createdAt: int


class State(TypedDict, total=False):
    pass


class ActionResult(TypedDict, total=False):
    text: str
    success: bool
    data: dict[str, str | int | float | bool | list | dict | None]


class MemoryQueryParams(TypedDict, total=False):
    roomId: str
    count: int


class MemoryManagerProtocol(Protocol):
    async def create_memory(self, memory: Memory, unique: bool = False) -> None: ...

    async def get_memories(self, params: MemoryQueryParams) -> list[Memory]: ...

    async def remove_memory(self, memory_id: str) -> None: ...


class RuntimeProtocol(Protocol):
    @property
    def agent_id(self) -> str: ...

    def get_setting(self, key: str) -> str | None: ...

    def get_service(self, name: str) -> object | None: ...

    def get_memory_manager(self) -> MemoryManagerProtocol | None: ...

    async def use_model(self, model_type: str, params: dict[str, str]) -> str | None: ...


HandlerCallback = Callable[[dict[str, str | list[str] | None]], Coroutine[object, object, None]]

ValidateFunc = Callable[[RuntimeProtocol, Memory, State | None], Coroutine[object, object, bool]]

HandlerFunc = Callable[
    [
        RuntimeProtocol,
        Memory,
        State | None,
        dict[str, str | list[str] | int | None] | None,
        HandlerCallback | None,
    ],
    Coroutine[object, object, ActionResult],
]


@dataclass
class ActionExample:
    name: str
    content: dict[str, str | list[str]]


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
