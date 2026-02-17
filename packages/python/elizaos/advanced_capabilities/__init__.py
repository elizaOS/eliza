"""Advanced Capabilities - Extended features for agent operation.

This module provides advanced capabilities that can be enabled with
`advanced_capabilities=True` or `enable_extended=True`.

Relationship/contact extraction and social-memory features are owned by
`plugin-rolodex` and are intentionally not auto-registered here.
"""

from .actions import (
    advanced_actions,
    follow_room_action,
    generate_image_action,
    mute_room_action,
    unfollow_room_action,
    unmute_room_action,
    update_role_action,
    update_settings_action,
)
from .evaluators import advanced_evaluators
from .providers import (
    advanced_providers,
    agent_settings_provider,
    knowledge_provider,
    roles_provider,
    settings_provider,
)
from .services import advanced_services

__all__ = [
    # Actions
    "advanced_actions",
    "follow_room_action",
    "generate_image_action",
    "mute_room_action",
    "unfollow_room_action",
    "unmute_room_action",
    "update_role_action",
    "update_settings_action",
    # Providers
    "advanced_providers",
    "agent_settings_provider",
    "knowledge_provider",
    "roles_provider",
    "settings_provider",
    # Evaluators
    "advanced_evaluators",
    # Services
    "advanced_services",
]
