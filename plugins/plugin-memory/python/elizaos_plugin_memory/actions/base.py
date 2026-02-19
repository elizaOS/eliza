"""Base types for action definitions following the elizaOS plugin pattern."""

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


class GetMemoriesParams(TypedDict, total=False):
    roomId: str
    tableName: str
    count: int


class RuntimeProtocol(Protocol):
    """Runtime protocol aligned with current DB API (create_memory, get_memories, delete_memory)."""

    @property
    def agent_id(self) -> str: ...

    def get_setting(self, key: str) -> str | None: ...

    def get_service(self, name: str) -> object | None: ...

    async def create_memory(
        self, memory: Memory, table_name: str, unique: bool = False
    ) -> str: ...

    async def get_memories(self, params: GetMemoriesParams) -> list[Memory]: ...

    async def delete_memory(self, memory_id: str) -> None: ...

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
