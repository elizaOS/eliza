"""Prose plugin providers."""

from elizaos_plugin_prose.providers.prose import ProseProvider

__all__ = ["ProseProvider"]


def get_prose_provider_names() -> list[str]:
    """Get the names of all prose providers."""
    return ["prose"]
