"""Actions for the Scratchpad plugin."""

from elizaos_plugin_scratchpad.actions.append import (
    SCRATCHPAD_APPEND_ACTION,
    AppendResult,
    handle_scratchpad_append,
    validate_scratchpad_append,
)
from elizaos_plugin_scratchpad.actions.delete import (
    SCRATCHPAD_DELETE_ACTION,
    DeleteResult,
    handle_scratchpad_delete,
    validate_scratchpad_delete,
)
from elizaos_plugin_scratchpad.actions.list import (
    SCRATCHPAD_LIST_ACTION,
    ListResult,
    handle_scratchpad_list,
    validate_scratchpad_list,
)
from elizaos_plugin_scratchpad.actions.read import (
    SCRATCHPAD_READ_ACTION,
    ReadResult,
    handle_scratchpad_read,
    validate_scratchpad_read,
)
from elizaos_plugin_scratchpad.actions.search import (
    SCRATCHPAD_SEARCH_ACTION,
    SearchResult,
    handle_scratchpad_search,
    validate_scratchpad_search,
)
from elizaos_plugin_scratchpad.actions.write import (
    SCRATCHPAD_WRITE_ACTION,
    WriteResult,
    handle_scratchpad_write,
    validate_scratchpad_write,
)

__all__ = [
    # WRITE
    "SCRATCHPAD_WRITE_ACTION",
    "WriteResult",
    "handle_scratchpad_write",
    "validate_scratchpad_write",
    # READ
    "SCRATCHPAD_READ_ACTION",
    "ReadResult",
    "handle_scratchpad_read",
    "validate_scratchpad_read",
    # SEARCH
    "SCRATCHPAD_SEARCH_ACTION",
    "SearchResult",
    "handle_scratchpad_search",
    "validate_scratchpad_search",
    # LIST
    "SCRATCHPAD_LIST_ACTION",
    "ListResult",
    "handle_scratchpad_list",
    "validate_scratchpad_list",
    # DELETE
    "SCRATCHPAD_DELETE_ACTION",
    "DeleteResult",
    "handle_scratchpad_delete",
    "validate_scratchpad_delete",
    # APPEND
    "SCRATCHPAD_APPEND_ACTION",
    "AppendResult",
    "handle_scratchpad_append",
    "validate_scratchpad_append",
]
