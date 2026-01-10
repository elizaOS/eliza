"""Base types for providers."""

from dataclasses import dataclass
from typing import Any, Callable, Coroutine, Protocol


class Memory(Protocol):
    """Memory data structure."""
    pass


class State(Protocol):
    """State data structure."""
    pass


class RuntimeProtocol(Protocol):
    """Protocol for ElizaOS runtime."""
    
    def get_service(self, name: str) -> Any:
        """Get a service by name."""
        ...


@dataclass
class ProviderResult:
    """Result from a provider."""
    text: str
    data: dict[str, Any] | None = None


ProviderFunc = Callable[
    [RuntimeProtocol, Any, Any],
    Coroutine[Any, Any, ProviderResult]
]


@dataclass
class Provider:
    """Provider definition."""
    name: str
    description: str
    get: ProviderFunc

