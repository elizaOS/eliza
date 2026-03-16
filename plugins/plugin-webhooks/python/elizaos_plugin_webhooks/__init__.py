"""
elizaos-plugin-webhooks – HTTP webhook ingress for elizaOS.

Usage::

    from elizaos_plugin_webhooks import webhooks_plugin

    # Register with runtime
    runtime.register_plugin(webhooks_plugin)

Public API mirrors the TypeScript implementation:
- ``extract_token`` / ``validate_token`` – auth helpers
- ``render_template`` / ``find_mapping`` / ``apply_mapping`` – mapping helpers
- ``handle_wake`` / ``handle_agent`` / ``handle_mapped`` – route handlers
- ``HookMapping`` / ``HooksConfig`` / ``AppliedMapping`` – types
"""

from .auth import extract_token, validate_token
from .error import (
    AuthenticationError,
    NotFoundError,
    TimeoutError,
    ValidationError,
    WebhookError,
)
from .handlers import handle_agent, handle_mapped, handle_wake
from .mappings import apply_mapping, find_mapping, render_template
from .plugin import WebhooksPlugin, webhooks_plugin
from .types import AppliedMapping, HookMapping, HookMatch, HooksConfig

__all__ = [
    # Plugin
    "webhooks_plugin",
    "WebhooksPlugin",
    # Auth
    "extract_token",
    "validate_token",
    # Mappings
    "render_template",
    "find_mapping",
    "apply_mapping",
    # Handlers
    "handle_wake",
    "handle_agent",
    "handle_mapped",
    # Types
    "HookMapping",
    "HookMatch",
    "HooksConfig",
    "AppliedMapping",
    # Errors
    "WebhookError",
    "AuthenticationError",
    "ValidationError",
    "NotFoundError",
    "TimeoutError",
]
