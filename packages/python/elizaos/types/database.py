from __future__ import annotations

from typing import Any, Protocol

from elizaos.types.generated.eliza.v1 import database_pb2

# Proto-backed types
BaseLogBody = database_pb2.BaseLogBody
ActionLogBody = database_pb2.ActionLogBody
EvaluatorLogBody = database_pb2.EvaluatorLogBody
ModelLogBody = database_pb2.ModelLogBody
EmbeddingLogBody = database_pb2.EmbeddingLogBody
LogBody = database_pb2.LogBody
Log = database_pb2.Log
RunStatus = database_pb2.DbRunStatus  # Alias for compatibility
AgentRunCounts = database_pb2.AgentRunCounts
AgentRunSummary = database_pb2.AgentRunSummary
AgentRunSummaryResult = database_pb2.AgentRunSummaryResult
EmbeddingSearchResult = database_pb2.EmbeddingSearchResult
MemoryRetrievalOptions = database_pb2.MemoryRetrievalOptions
MemorySearchOptions = database_pb2.MemorySearchOptions
MultiRoomMemoryOptions = database_pb2.MultiRoomMemoryOptions

# Types not in protobuf - provide aliases or simple types
MemoryOptions = MemoryRetrievalOptions  # Alias for compatibility
SearchOptions = MemorySearchOptions  # Alias for compatibility
DbConnection = Any  # Runtime type

# Vector dimension constant (for compatibility with prior adapter interfaces)
VECTOR_DIMS = 1536


class IDatabaseAdapter(Protocol):
    """Runtime adapter interface (implementation-specific)."""

    @property
    def db(self) -> Any: ...

    def __getattr__(self, name: str) -> Any: ...


__all__ = [
    "BaseLogBody",
    "ActionLogBody",
    "EvaluatorLogBody",
    "ModelLogBody",
    "EmbeddingLogBody",
    "LogBody",
    "Log",
    "RunStatus",
    "AgentRunCounts",
    "AgentRunSummary",
    "AgentRunSummaryResult",
    "EmbeddingSearchResult",
    "MemoryRetrievalOptions",
    "MemorySearchOptions",
    "MultiRoomMemoryOptions",
    "MemoryOptions",
    "SearchOptions",
    "DbConnection",
    "VECTOR_DIMS",
    "IDatabaseAdapter",
]
