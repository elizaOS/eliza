"""
Matrix messaging integration plugin for elizaOS agents.

This plugin provides Matrix protocol integration using matrix-nio.
"""

from elizaos_plugin_matrix.types import (
    MatrixEventTypes,
    MatrixMessage,
    MatrixMessageSendOptions,
    MatrixRoom,
    MatrixSendResult,
    MatrixSettings,
    MatrixUserInfo,
    MatrixApiError,
    MatrixConfigurationError,
    MatrixNotConnectedError,
    MatrixPluginError,
    MatrixServiceNotInitializedError,
    get_matrix_localpart,
    get_matrix_serverpart,
    get_matrix_user_display_name,
    is_valid_matrix_room_alias,
    is_valid_matrix_room_id,
    is_valid_matrix_user_id,
    matrix_mxc_to_http,
    MAX_MATRIX_MESSAGE_LENGTH,
    MATRIX_SERVICE_NAME,
)
from elizaos_plugin_matrix.service import MatrixService
from elizaos_plugin_matrix.actions import (
    send_message_action,
    send_reaction_action,
    list_rooms_action,
    join_room_action,
)
from elizaos_plugin_matrix.providers import (
    room_state_provider,
    user_context_provider,
)

__all__ = [
    # Service
    "MatrixService",
    # Types
    "MatrixEventTypes",
    "MatrixMessage",
    "MatrixMessageSendOptions",
    "MatrixRoom",
    "MatrixSendResult",
    "MatrixSettings",
    "MatrixUserInfo",
    # Errors
    "MatrixApiError",
    "MatrixConfigurationError",
    "MatrixNotConnectedError",
    "MatrixPluginError",
    "MatrixServiceNotInitializedError",
    # Utilities
    "get_matrix_localpart",
    "get_matrix_serverpart",
    "get_matrix_user_display_name",
    "is_valid_matrix_room_alias",
    "is_valid_matrix_room_id",
    "is_valid_matrix_user_id",
    "matrix_mxc_to_http",
    # Constants
    "MAX_MATRIX_MESSAGE_LENGTH",
    "MATRIX_SERVICE_NAME",
    # Actions
    "send_message_action",
    "send_reaction_action",
    "list_rooms_action",
    "join_room_action",
    # Providers
    "room_state_provider",
    "user_context_provider",
]

# Plugin metadata
PLUGIN_NAME = "matrix"
PLUGIN_DESCRIPTION = "Matrix messaging integration plugin for elizaOS with E2EE support"
PLUGIN_VERSION = "2.0.0-alpha"


def get_plugin():
    """Return the plugin definition for elizaOS registration."""
    return {
        "name": PLUGIN_NAME,
        "description": PLUGIN_DESCRIPTION,
        "version": PLUGIN_VERSION,
        "services": [MatrixService],
        "actions": [
            send_message_action,
            send_reaction_action,
            list_rooms_action,
            join_room_action,
        ],
        "providers": [
            room_state_provider,
            user_context_provider,
        ],
    }
