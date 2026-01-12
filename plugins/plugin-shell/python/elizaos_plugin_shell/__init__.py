# Actions
from elizaos_plugin_shell.actions import (
    ClearHistoryAction,
    ExecuteCommandAction,
    get_shell_action_names,
)
from elizaos_plugin_shell.path_utils import (
    DEFAULT_FORBIDDEN_COMMANDS,
    extract_base_command,
    is_forbidden_command,
    is_safe_command,
    validate_path,
)
from elizaos_plugin_shell.providers import (
    ShellHistoryProvider,
    get_shell_provider_names,
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

# Plugin metadata
PLUGIN_NAME = "shell"
PLUGIN_DESCRIPTION = "Execute shell commands within a restricted directory with history tracking"

__all__ = [
    # Types
    "CommandResult",
    "CommandHistoryEntry",
    "FileOperation",
    "FileOperationType",
    "ShellConfig",
    # Service
    "ShellService",
    # Actions
    "ExecuteCommandAction",
    "ClearHistoryAction",
    "get_shell_action_names",
    # Providers
    "ShellHistoryProvider",
    "get_shell_provider_names",
    # Utils
    "validate_path",
    "is_safe_command",
    "extract_base_command",
    "is_forbidden_command",
    "DEFAULT_FORBIDDEN_COMMANDS",
    "PLUGIN_NAME",
    "PLUGIN_DESCRIPTION",
]
