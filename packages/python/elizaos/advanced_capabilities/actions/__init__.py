"""Advanced Actions - Extended actions for agent operation.

Extended actions that can be enabled with `advanced_capabilities=True`.
"""

from .follow_room import follow_room_action
from .image_generation import generate_image_action
from .mute_room import mute_room_action
from .roles import update_role_action
from .settings import update_settings_action
from .unfollow_room import unfollow_room_action
from .unmute_room import unmute_room_action

__all__ = [
    "follow_room_action",
    "generate_image_action",
    "mute_room_action",
    "unfollow_room_action",
    "unmute_room_action",
    "update_role_action",
    "update_settings_action",
    "advanced_actions",
]

# Rolodex/contact actions are provided by plugin-rolodex.
advanced_actions = [
    follow_room_action,
    generate_image_action,
    mute_room_action,
    unfollow_room_action,
    unmute_room_action,
    update_role_action,
    update_settings_action,
]
