"""elizaOS Scratchpad Plugin - File-based persistent memory storage."""

from elizaos_plugin_scratchpad.actions import (
    SCRATCHPAD_APPEND_ACTION,
    SCRATCHPAD_DELETE_ACTION,
    SCRATCHPAD_LIST_ACTION,
    SCRATCHPAD_READ_ACTION,
    SCRATCHPAD_SEARCH_ACTION,
    SCRATCHPAD_WRITE_ACTION,
    AppendResult,
    DeleteResult,
    ListResult,
    ReadResult,
    SearchResult,
    WriteResult,
    handle_scratchpad_append,
    handle_scratchpad_delete,
    handle_scratchpad_list,
    handle_scratchpad_read,
    handle_scratchpad_search,
    handle_scratchpad_write,
)
from elizaos_plugin_scratchpad.config import ScratchpadConfig
from elizaos_plugin_scratchpad.error import (
    ConfigError,
    FileSizeError,
    NotFoundError,
    ScratchpadError,
    ValidationError,
)
from elizaos_plugin_scratchpad.plugin import scratchpad_plugin
from elizaos_plugin_scratchpad.providers import SCRATCHPAD_PROVIDER, get_scratchpad
from elizaos_plugin_scratchpad.service import ScratchpadService, create_scratchpad_service
from elizaos_plugin_scratchpad.types import (
    ScratchpadEntry,
    ScratchpadReadOptions,
    ScratchpadSearchOptions,
    ScratchpadSearchResult,
    ScratchpadWriteOptions,
)

__version__ = "2.0.0"

__all__ = [
    # Plugin
    "scratchpad_plugin",
    # Service
    "ScratchpadService",
    "create_scratchpad_service",
    # Config
    "ScratchpadConfig",
    # Errors
    "ScratchpadError",
    "NotFoundError",
    "ValidationError",
    "FileSizeError",
    "ConfigError",
    # Types
    "ScratchpadEntry",
    "ScratchpadSearchResult",
    "ScratchpadReadOptions",
    "ScratchpadWriteOptions",
    "ScratchpadSearchOptions",
    # Actions
    "SCRATCHPAD_WRITE_ACTION",
    "SCRATCHPAD_READ_ACTION",
    "SCRATCHPAD_SEARCH_ACTION",
    "SCRATCHPAD_LIST_ACTION",
    "SCRATCHPAD_DELETE_ACTION",
    "SCRATCHPAD_APPEND_ACTION",
    "WriteResult",
    "ReadResult",
    "SearchResult",
    "ListResult",
    "DeleteResult",
    "AppendResult",
    "handle_scratchpad_write",
    "handle_scratchpad_read",
    "handle_scratchpad_search",
    "handle_scratchpad_list",
    "handle_scratchpad_delete",
    "handle_scratchpad_append",
    # Provider
    "SCRATCHPAD_PROVIDER",
    "get_scratchpad",
]
