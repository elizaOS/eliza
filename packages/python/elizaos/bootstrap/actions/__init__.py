"""
Actions for the elizaOS Bootstrap Plugin.

This module exports all available actions for the bootstrap plugin.
"""

from .choice import choose_option_action
from .follow_room import follow_room_action
from .ignore import ignore_action
from .image_generation import generate_image_action
from .mute_room import mute_room_action
from .none import none_action
from .reply import reply_action
from .roles import update_role_action
from .send_message import send_message_action
from .settings import update_settings_action
from .unfollow_room import unfollow_room_action
from .unmute_room import unmute_room_action
from .update_entity import update_entity_action

__all__ = [
    "choose_option_action",
    "follow_room_action",
    "generate_image_action",
    "ignore_action",
    "mute_room_action",
    "none_action",
    "reply_action",
    "send_message_action",
    "unfollow_room_action",
    "unmute_room_action",
    "update_entity_action",
    "update_role_action",
    "update_settings_action",
    # Capability lists
    "BASIC_ACTIONS",
    "EXTENDED_ACTIONS",
    "ALL_ACTIONS",
]

# Basic actions - included by default
BASIC_ACTIONS = [
    reply_action,
    ignore_action,
    none_action,
]

# Extended actions - opt-in
EXTENDED_ACTIONS = [
    choose_option_action,
    follow_room_action,
    unfollow_room_action,
    mute_room_action,
    unmute_room_action,
    send_message_action,
    update_entity_action,
    update_role_action,
    update_settings_action,
    generate_image_action,
]

# All actions list for easy registration (backwards compatibility)
ALL_ACTIONS = BASIC_ACTIONS + EXTENDED_ACTIONS
