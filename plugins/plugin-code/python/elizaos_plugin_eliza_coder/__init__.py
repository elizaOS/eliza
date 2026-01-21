from elizaos_plugin_eliza_coder.actions import (
    ChangeDirectoryAction,
    EditFileAction,
    ExecuteShellAction,
    GitAction,
    ListFilesAction,
    ReadFileAction,
    SearchFilesAction,
    WriteFileAction,
)
from elizaos_plugin_eliza_coder.config import load_coder_config
from elizaos_plugin_eliza_coder.path_utils import (
    DEFAULT_FORBIDDEN_COMMANDS,
    extract_base_command,
    is_forbidden_command,
    is_safe_command,
    validate_path,
)
from elizaos_plugin_eliza_coder.providers import CoderStatusProvider
from elizaos_plugin_eliza_coder.service import CoderService
from elizaos_plugin_eliza_coder.types import (
    CoderConfig,
    CommandHistoryEntry,
    CommandResult,
    FileOperation,
    FileOperationType,
)

__version__ = "1.0.0"

PLUGIN_NAME = "code"
PLUGIN_DESCRIPTION = "Filesystem + shell + git tools within a restricted directory"

__all__ = [
    "CoderConfig",
    "CommandResult",
    "CommandHistoryEntry",
    "FileOperation",
    "FileOperationType",
    "CoderService",
    "ReadFileAction",
    "WriteFileAction",
    "EditFileAction",
    "ListFilesAction",
    "SearchFilesAction",
    "ChangeDirectoryAction",
    "ExecuteShellAction",
    "GitAction",
    "CoderStatusProvider",
    "load_coder_config",
    "validate_path",
    "is_safe_command",
    "extract_base_command",
    "is_forbidden_command",
    "DEFAULT_FORBIDDEN_COMMANDS",
    "PLUGIN_NAME",
    "PLUGIN_DESCRIPTION",
]
