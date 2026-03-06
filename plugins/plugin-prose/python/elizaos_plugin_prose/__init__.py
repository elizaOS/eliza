"""
elizaos-plugin-prose: OpenProse VM integration for elizaOS.

OpenProse is a programming language for AI sessions that allows
orchestrating multi-agent workflows.
"""

from elizaos_plugin_prose.actions import (
    ProseCompileAction,
    ProseHelpAction,
    ProseRunAction,
    get_prose_action_names,
)
from elizaos_plugin_prose.providers import ProseProvider, get_prose_provider_names
from elizaos_plugin_prose.services import ProseService
from elizaos_plugin_prose.types import (
    ProseCompileOptions,
    ProseCompileResult,
    ProseConfig,
    ProseRunOptions,
    ProseRunResult,
    ProseSkillFile,
    ProseStateMode,
)

__version__ = "1.0.0"

PLUGIN_NAME = "prose"
PLUGIN_DESCRIPTION = "OpenProse VM integration - a programming language for AI sessions"

__all__ = [
    # Types
    "ProseStateMode",
    "ProseRunOptions",
    "ProseCompileOptions",
    "ProseRunResult",
    "ProseCompileResult",
    "ProseSkillFile",
    "ProseConfig",
    # Service
    "ProseService",
    # Actions
    "ProseRunAction",
    "ProseCompileAction",
    "ProseHelpAction",
    "get_prose_action_names",
    # Providers
    "ProseProvider",
    "get_prose_provider_names",
    # Plugin metadata
    "PLUGIN_NAME",
    "PLUGIN_DESCRIPTION",
]
