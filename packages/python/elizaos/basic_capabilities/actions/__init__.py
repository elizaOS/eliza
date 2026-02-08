"""Basic Actions - Core response actions.

Fundamental actions included by default in the bootstrap plugin.
"""

from .choice import choose_option_action as choice_action
from .ignore import ignore_action
from .none import none_action
from .reply import reply_action

__all__ = [
    "choice_action",
    "ignore_action",
    "none_action",
    "reply_action",
    "basic_actions",
]

basic_actions = [
    choice_action,
    reply_action,
    ignore_action,
    none_action,
]
