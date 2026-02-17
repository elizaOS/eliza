from .add_contact import add_contact_action
from .choice import choose_option_action
from .follow_room import follow_room_action
from .ignore import ignore_action
from .image_generation import generate_image_action
from .mute_room import mute_room_action
from .none import none_action
from .remove_contact import remove_contact_action
from .reply import reply_action
from .roles import update_role_action
from .schedule_follow_up import schedule_follow_up_action
from .search_contacts import search_contacts_action
from .send_message import send_message_action
from .settings import update_settings_action
from .unfollow_room import unfollow_room_action
from .unmute_room import unmute_room_action
from .update_contact import update_contact_action
from .update_entity import update_entity_action

__all__ = [
    "add_contact_action",
    "choose_option_action",
    "follow_room_action",
    "generate_image_action",
    "ignore_action",
    "mute_room_action",
    "none_action",
    "remove_contact_action",
    "reply_action",
    "schedule_follow_up_action",
    "search_contacts_action",
    "send_message_action",
    "unfollow_room_action",
    "unmute_room_action",
    "update_contact_action",
    "update_entity_action",
    "update_role_action",
    "update_settings_action",
    "BASIC_ACTIONS",
    "EXTENDED_ACTIONS",
    "ALL_ACTIONS",
]

BASIC_ACTIONS = [
    reply_action,
    ignore_action,
    none_action,
]

EXTENDED_ACTIONS = [
    add_contact_action,
    choose_option_action,
    follow_room_action,
    generate_image_action,
    mute_room_action,
    remove_contact_action,
    schedule_follow_up_action,
    search_contacts_action,
    send_message_action,
    unfollow_room_action,
    unmute_room_action,
    update_contact_action,
    update_entity_action,
    update_role_action,
    update_settings_action,
]

ALL_ACTIONS = BASIC_ACTIONS + EXTENDED_ACTIONS
