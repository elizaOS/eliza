"""
elizaOS Shell Plugin - Shell command execution with directory restrictions and history tracking.
"""

from elizaos_plugin_shell.path_utils import (
    DEFAULT_FORBIDDEN_COMMANDS,
    extract_base_command,
    is_forbidden_command,
    is_safe_command,
    validate_path,
)
from elizaos_plugin_shell.service import ShellService
from elizaos_plugin_shell.types import (
    CommandHistoryEntry,
    CommandResult,
    FileOperation,
    FileOperationType,
    ShellConfig,
)

__version__ = "1.2.0"

__all__ = [
    # Types
    "CommandResult",
    "CommandHistoryEntry",
    "FileOperation",
    "FileOperationType",
    "ShellConfig",
    # Service
    "ShellService",
    # Utils
    "validate_path",
    "is_safe_command",
    "extract_base_command",
    "is_forbidden_command",
    "DEFAULT_FORBIDDEN_COMMANDS",
]





