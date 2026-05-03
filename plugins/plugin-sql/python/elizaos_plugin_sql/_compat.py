from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Any, Protocol, TypeAlias

try:
    from elizaos.types import (  # type: ignore[import-not-found]
        UUID as UUID,
    )
    from elizaos.types import (
        BaseLogBody as BaseLogBody,
    )
    from elizaos.types import (
        IAgentRuntime as IAgentRuntime,
    )
    from elizaos.types import (
        IDatabaseAdapter as IDatabaseAdapter,
    )
    from elizaos.types import (
        Log as Log,
    )
    from elizaos.types import (
        Log as LogModel,
    )
    from elizaos.types import (
        Plugin as Plugin,
    )
    from elizaos.types import (
        as_uuid as as_uuid,
    )
except Exception:
    UUID: TypeAlias = str

    class IDatabaseAdapter:
        """Fallback base class when elizaos is unavailable."""

    class IAgentRuntime(Protocol):
        """Fallback runtime protocol when elizaos is unavailable."""

    class BaseLogBody(dict[str, Any]):
        """Fallback log body model."""

    @dataclass(slots=True)
    class LogModel:
        id: UUID
        entityId: UUID
        roomId: UUID | None
        type: str
        body: BaseLogBody
        createdAt: int

    Log = LogModel

    @dataclass(slots=True)
    class Plugin:
        name: str
        description: str
        init: Any
        config: dict[str, Any]

    def as_uuid(value: str | uuid.UUID) -> UUID:
        if isinstance(value, uuid.UUID):
            return str(value)
        return str(uuid.UUID(str(value)))


__all__ = [
    "UUID",
    "IDatabaseAdapter",
    "IAgentRuntime",
    "Plugin",
    "Log",
    "LogModel",
    "BaseLogBody",
    "as_uuid",
]
