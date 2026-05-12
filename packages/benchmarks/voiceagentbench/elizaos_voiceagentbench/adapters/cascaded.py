"""Cascaded STT adapters for Eliza / Hermes / OpenClaw.

Each factory wraps the equivalent LifeOpsBench agent factory. The user
:class:`MessageTurn` already carries both the STT transcript (in
``content``) and the raw audio bytes (in ``audio_input``). LifeOps
adapters consume ``content``; future direct-audio adapters can opt
into the ``audio_input`` field without further runner changes.

The Eliza factory uses the same source-loaded eliza bridge as LifeOpsBench.
VoiceAgentBench's ``MessageTurn`` subclasses the LifeOps turn type, so the
cascaded text path can reuse that adapter while still carrying audio bytes for
future direct-audio adapters.
"""

from __future__ import annotations

from typing import Any

from ..types import AgentFn


def build_eliza_agent(**kwargs: Any) -> AgentFn:
    """Cascaded Eliza adapter backed by the eliza benchmark bridge."""
    from eliza_lifeops_bench.agents import build_eliza_agent as _build

    return _build(**kwargs)


def build_hermes_agent(**kwargs: Any) -> AgentFn:
    """Cascaded Hermes adapter."""
    from eliza_lifeops_bench.agents.hermes import build_hermes_agent as _build

    return _build(**kwargs)


def build_openclaw_agent(**kwargs: Any) -> AgentFn:
    """Cascaded OpenClaw adapter."""
    from eliza_lifeops_bench.agents.openclaw import (
        build_openclaw_agent as _build,
    )

    return _build(**kwargs)
