"""elizaOS CLI Plugin - CLI framework and command registration.

Provides:
- CLI command registration and management via :class:`CliRegistry`
- Type definitions for commands, arguments, and contexts
- Duration/timeout parsing and formatting utilities
- Progress reporting
"""

from elizaos_plugin_cli.registry import CliRegistry
from elizaos_plugin_cli.types import (
    CliArg,
    CliCommand,
    CliContext,
    CliLogger,
    CliPluginConfig,
    CommonCommandOptions,
    DefaultCliLogger,
    ParsedDuration,
    ProgressReporter,
)
from elizaos_plugin_cli.utils import (
    DEFAULT_CLI_NAME,
    DEFAULT_CLI_VERSION,
    format_bytes,
    format_cli_command,
    format_duration,
    parse_duration,
    parse_timeout_ms,
    truncate_string,
)

__version__ = "2.0.0"

PLUGIN_NAME = "cli"
PLUGIN_DESCRIPTION = "CLI framework plugin for command registration and execution"

__all__ = [
    # Registry
    "CliRegistry",
    # Types
    "CliArg",
    "CliCommand",
    "CliContext",
    "CliLogger",
    "CliPluginConfig",
    "CommonCommandOptions",
    "DefaultCliLogger",
    "ParsedDuration",
    "ProgressReporter",
    # Utils
    "DEFAULT_CLI_NAME",
    "DEFAULT_CLI_VERSION",
    "format_bytes",
    "format_cli_command",
    "format_duration",
    "parse_duration",
    "parse_timeout_ms",
    "truncate_string",
    # Constants
    "PLUGIN_NAME",
    "PLUGIN_DESCRIPTION",
]
