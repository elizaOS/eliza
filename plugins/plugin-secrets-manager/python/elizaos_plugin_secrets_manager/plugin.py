"""
Secrets Manager Plugin for elizaOS.

Multi-level secrets management with encryption, validation, and dynamic plugin activation.
"""

from elizaos.types import Plugin

from .service import SecretsService
from .activator import PluginActivatorService
from .actions import set_secret_action, manage_secret_action
from .providers import secrets_status_provider, secrets_info_provider


secrets_manager_plugin = Plugin(
    name="secrets-manager",
    description="Multi-level secrets management with encryption and dynamic plugin activation",
    services=[SecretsService, PluginActivatorService],
    actions=[set_secret_action, manage_secret_action],
    providers=[secrets_status_provider, secrets_info_provider],
)


__all__ = [
    "secrets_manager_plugin",
    "SecretsService",
    "PluginActivatorService",
    "set_secret_action",
    "manage_secret_action",
    "secrets_status_provider",
    "secrets_info_provider",
]
