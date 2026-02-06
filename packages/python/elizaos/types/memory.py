from __future__ import annotations

from elizaos.types.generated.eliza.v1 import memory_pb2


class _MemoryTypeValue(str):
    """String that also has a .value property for enum compatibility."""

    @property
    def value(self) -> str:  # noqa: D401
        return str(self)


class MemoryType:
    """Memory type constants (mirrors the TypeScript MemoryType enum)."""

    MESSAGE = _MemoryTypeValue("MESSAGE")
    DOCUMENT = _MemoryTypeValue("DOCUMENT")
    FRAGMENT = _MemoryTypeValue("FRAGMENT")
    DESCRIPTION = _MemoryTypeValue("DESCRIPTION")
    CUSTOM = _MemoryTypeValue("CUSTOM")


BaseMetadata = memory_pb2.BaseMetadata
DocumentMetadata = memory_pb2.DocumentMetadata
FragmentMetadata = memory_pb2.FragmentMetadata
MessageMetadata = memory_pb2.MessageMetadata
DescriptionMetadata = memory_pb2.DescriptionMetadata
CustomMetadata = memory_pb2.CustomMetadata
MemoryMetadata = memory_pb2.MemoryMetadata
Memory = memory_pb2.Memory
MessageMemory = memory_pb2.MessageMemory

__all__ = [
    "MemoryType",
    "BaseMetadata",
    "DocumentMetadata",
    "FragmentMetadata",
    "MessageMetadata",
    "DescriptionMetadata",
    "CustomMetadata",
    "MemoryMetadata",
    "Memory",
    "MessageMemory",
]
