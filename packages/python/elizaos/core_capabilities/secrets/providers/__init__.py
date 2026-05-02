"""Secrets providers."""

from .secrets_status import secrets_status_provider

secrets_providers = [secrets_status_provider]

__all__ = [
    "secrets_status_provider",
    "secrets_providers",
]
