"""
Runtime settings keys forwarded into cloud containers as environment
variables. Used by both provision_agent and resume_agent actions.
"""

from __future__ import annotations

import os

FORWARDED_SETTINGS: list[str] = [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GROQ_API_KEY",
    "ELIZAOS_CLOUD_API_KEY",
    "SMALL_MODEL",
    "LARGE_MODEL",
    "ELIZAOS_CLOUD_SMALL_MODEL",
    "ELIZAOS_CLOUD_LARGE_MODEL",
]


def collect_env_vars(settings: dict[str, str | None] | None = None) -> dict[str, str]:
    """Collect forwarded settings from runtime settings dict or os.environ."""
    result: dict[str, str] = {}
    for key in FORWARDED_SETTINGS:
        val: str | None = None
        if settings:
            val = settings.get(key)
        if val is None:
            val = os.environ.get(key)
        if val is not None:
            result[key] = val
    return result
