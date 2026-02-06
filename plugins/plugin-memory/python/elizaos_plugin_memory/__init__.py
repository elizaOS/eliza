from elizaos_plugin_memory.plugin import memory_plugin
from elizaos_plugin_memory.types import (
    MEMORY_SOURCE,
    ForgetParameters,
    MemoryImportance,
    MemorySearchResult,
    ParsedMemory,
    RecallParameters,
    RememberParameters,
    decode_memory_text,
    encode_memory_text,
)

__all__ = [
    "memory_plugin",
    "MemoryImportance",
    "ParsedMemory",
    "RememberParameters",
    "RecallParameters",
    "ForgetParameters",
    "MemorySearchResult",
    "MEMORY_SOURCE",
    "encode_memory_text",
    "decode_memory_text",
]

__version__ = "2.0.0"
