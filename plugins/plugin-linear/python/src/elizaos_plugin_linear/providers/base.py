from collections.abc import Callable, Coroutine
from dataclasses import dataclass
from typing import Any, Protocol


class RuntimeProtocol(Protocol):
    def get_service(self, name: str) -> Any: ...


@dataclass
class ProviderResult:
    text: str
    data: dict[str, Any] | None = None


ProviderFunc = Callable[
    [RuntimeProtocol, object, object], Coroutine[object, object, ProviderResult]
]


@dataclass
class Provider:
    name: str
    description: str
    get: ProviderFunc
