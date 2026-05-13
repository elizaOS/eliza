"""Adapter factories for VoiceAgentBench."""

from __future__ import annotations

from .cascaded import build_eliza_agent, build_hermes_agent, build_openclaw_agent

__all__ = [
    "build_eliza_agent",
    "build_hermes_agent",
    "build_openclaw_agent",
]
