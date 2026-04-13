"""Secrets actions."""

from .manage_secret import manage_secret_action
from .request_secret import request_secret_action
from .set_secret import set_secret_action

secrets_actions = [set_secret_action, manage_secret_action, request_secret_action]

__all__ = [
    "set_secret_action",
    "manage_secret_action",
    "request_secret_action",
    "secrets_actions",
]
