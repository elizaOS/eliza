"""Cascaded STT adapters for Eliza / Hermes / OpenClaw.

Each factory wraps the equivalent LifeOpsBench agent factory. The user
:class:`MessageTurn` already carries both the STT transcript (in
``content``) and the raw audio bytes (in ``audio_input``). LifeOps
adapters consume ``content``; future direct-audio adapters can opt
into the ``audio_input`` field without further runner changes.

The Eliza factory currently delegates to ``cerebras-direct`` because
the eliza-adapter LifeOps bridge requires a scenario-bound runtime
state that VoiceAgentBench does not synthesize.
"""

from __future__ import annotations

from typing import Any

from ..types import AgentFn


def build_eliza_agent(**kwargs: Any) -> AgentFn:
    """Cascaded Eliza adapter - delegates to LifeOps cerebras-direct."""
    from eliza_lifeops_bench.agents.cerebras_direct import (
        build_cerebras_direct_agent,
    )

    return build_cerebras_direct_agent(**kwargs)


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
