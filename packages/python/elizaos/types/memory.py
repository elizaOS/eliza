from __future__ import annotations

from elizaos.types.generated.eliza.v1 import memory_pb2

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
