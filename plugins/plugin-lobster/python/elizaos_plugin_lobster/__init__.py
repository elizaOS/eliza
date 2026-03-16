"""
elizaos-plugin-lobster: Lobster workflow runtime integration for elizaOS.

Lobster is a local-first workflow execution tool for running multi-step
pipelines with approval checkpoints.
"""

from elizaos_plugin_lobster.actions import (
    LobsterResumeAction,
    LobsterRunAction,
    get_lobster_action_names,
)
from elizaos_plugin_lobster.providers import LobsterProvider, get_lobster_provider_names
from elizaos_plugin_lobster.service import LobsterService
from elizaos_plugin_lobster.types import (
    LobsterAction,
    LobsterApprovalRequest,
    LobsterConfig,
    LobsterEnvelope,
    LobsterErrorEnvelope,
    LobsterResumeParams,
    LobsterResult,
    LobsterRunParams,
    LobsterSuccessEnvelope,
)

__version__ = "1.0.0"

PLUGIN_NAME = "lobster"
PLUGIN_DESCRIPTION = "Lobster workflow runtime for multi-step pipelines with approval checkpoints"

__all__ = [
    # Types
    "LobsterAction",
    "LobsterRunParams",
    "LobsterResumeParams",
    "LobsterApprovalRequest",
    "LobsterSuccessEnvelope",
    "LobsterErrorEnvelope",
    "LobsterEnvelope",
    "LobsterConfig",
    "LobsterResult",
    # Service
    "LobsterService",
    # Actions
    "LobsterRunAction",
    "LobsterResumeAction",
    "get_lobster_action_names",
    # Providers
    "LobsterProvider",
    "get_lobster_provider_names",
    # Plugin metadata
    "PLUGIN_NAME",
    "PLUGIN_DESCRIPTION",
]
