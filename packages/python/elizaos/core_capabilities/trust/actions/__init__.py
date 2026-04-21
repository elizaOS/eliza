"""Trust actions."""

from .evaluate_trust import evaluate_trust_action
from .record_interaction import record_interaction_action
from .request_elevation import request_elevation_action
from .roles import update_role_action
from .settings import update_settings_action

trust_actions = [
    evaluate_trust_action,
    record_interaction_action,
    request_elevation_action,
    update_role_action,
    update_settings_action,
]

__all__ = [
    "evaluate_trust_action",
    "record_interaction_action",
    "request_elevation_action",
    "update_role_action",
    "update_settings_action",
    "trust_actions",
]
