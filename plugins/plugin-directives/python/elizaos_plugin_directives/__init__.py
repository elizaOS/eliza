"""elizaOS Directives Plugin - parse and manage agent directives."""

from elizaos_plugin_directives.parsers import (
    apply_directives,
    extract_elevated_directive,
    extract_exec_directive,
    extract_model_directive,
    extract_reasoning_directive,
    extract_status_directive,
    extract_think_directive,
    extract_verbose_directive,
    format_directive_state,
    normalize_elevated_level,
    normalize_exec,
    normalize_reasoning_level,
    normalize_think_level,
    normalize_verbose_level,
    parse_all_directives,
    strip_directives,
)
from elizaos_plugin_directives.providers import DirectiveStateProvider, ProviderResult
from elizaos_plugin_directives.types import (
    DirectiveState,
    ElevatedLevel,
    ExecConfig,
    ModelConfig,
    ParsedDirectives,
    ReasoningLevel,
    ThinkLevel,
    VerboseLevel,
)

__version__ = "1.0.0"

PLUGIN_NAME = "directives"
PLUGIN_DESCRIPTION = (
    "Inline directive parsing (/think, /model, /verbose, etc.) "
    "for controlling agent behavior"
)

__all__ = [
    # Types
    "ThinkLevel",
    "VerboseLevel",
    "ReasoningLevel",
    "ElevatedLevel",
    "ExecConfig",
    "ModelConfig",
    "ParsedDirectives",
    "DirectiveState",
    # Normalizers
    "normalize_think_level",
    "normalize_verbose_level",
    "normalize_reasoning_level",
    "normalize_elevated_level",
    "normalize_exec",
    # Extractors
    "extract_think_directive",
    "extract_verbose_directive",
    "extract_reasoning_directive",
    "extract_elevated_directive",
    "extract_exec_directive",
    "extract_model_directive",
    "extract_status_directive",
    # Combined
    "parse_all_directives",
    "strip_directives",
    "apply_directives",
    "format_directive_state",
    # Provider
    "DirectiveStateProvider",
    "ProviderResult",
    # Constants
    "PLUGIN_NAME",
    "PLUGIN_DESCRIPTION",
]
