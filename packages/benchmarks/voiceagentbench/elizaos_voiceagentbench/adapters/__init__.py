"""Adapter factories for VoiceAgentBench."""

from __future__ import annotations

from .mock import build_mock_agent
from .cascaded import build_eliza_agent, build_hermes_agent, build_openclaw_agent

__all__ = [
    "build_mock_agent",
    "build_eliza_agent",
    "build_hermes_agent",
    "build_openclaw_agent",
]
