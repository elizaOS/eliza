"""Lobster plugin providers."""

from elizaos_plugin_lobster.providers.lobster import LobsterProvider

__all__ = ["LobsterProvider"]


def get_lobster_provider_names() -> list[str]:
    """Get the names of all lobster providers."""
    return ["lobster"]
