"""elizaOS Commands Plugin - command registry and built-in commands."""

from elizaos_plugin_commands.actions import (
    CommandsListAction,
    HelpCommandAction,
    ModelsCommandAction,
    StatusCommandAction,
    StopCommandAction,
)
from elizaos_plugin_commands.parser import (
    extract_command_args,
    is_command,
    normalize_command_name,
    parse_command,
)
from elizaos_plugin_commands.providers import CommandRegistryProvider, ProviderResult
from elizaos_plugin_commands.registry import CommandRegistry, default_registry
from elizaos_plugin_commands.types import (
    CommandCategory,
    CommandContext,
    CommandDefinition,
    CommandResult,
    ParsedCommand,
)

__version__ = "2.0.0"

PLUGIN_NAME = "commands"
PLUGIN_DESCRIPTION = "Chat command system with /help, /status, /stop, /models, /commands"

__all__ = [
    # Types
    "CommandCategory",
    "CommandContext",
    "CommandDefinition",
    "CommandResult",
    "ParsedCommand",
    # Parser
    "is_command",
    "parse_command",
    "normalize_command_name",
    "extract_command_args",
    # Registry
    "CommandRegistry",
    "default_registry",
    # Actions
    "HelpCommandAction",
    "StatusCommandAction",
    "StopCommandAction",
    "ModelsCommandAction",
    "CommandsListAction",
    # Providers
    "CommandRegistryProvider",
    "ProviderResult",
    # Plugin metadata
    "PLUGIN_NAME",
    "PLUGIN_DESCRIPTION",
]
