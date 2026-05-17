"""Compatibility stubs for removed Python Eliza AgentBench actions."""

from __future__ import annotations


def create_benchmark_actions() -> list[object]:
    """Return no Python Eliza actions.

    AgentBench action handling now lives in the TypeScript benchmark bridge.
    """
    return []


def create_benchmark_plugin() -> None:
    """Compatibility stub for the removed Python Eliza plugin."""
    return None


__all__ = ["create_benchmark_actions", "create_benchmark_plugin"]
