"""Base types for provider definitions following the elizaOS plugin pattern."""

from collections.abc import Callable, Coroutine
from dataclasses import dataclass
from typing import Protocol


class RuntimeProtocol(Protocol):
    def get_service(self, name: str) -> object | None: ...

    def get_memory_manager(self) -> object | None: ...


@dataclass
class ProviderResult:
    text: str
    data: dict[str, str | int | float | bool | list | dict | None] | None = None


ProviderFunc = Callable[
    [RuntimeProtocol, object, object], Coroutine[object, object, ProviderResult]
]


@dataclass
class Provider:
    name: str
    description: str
    get: ProviderFunc
