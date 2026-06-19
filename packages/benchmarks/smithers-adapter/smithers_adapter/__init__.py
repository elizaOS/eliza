"""Benchmark adapter for the Smithers agent harness.

Smithers (``smithers-orchestrator``) is a Bun + JSX durable workflow engine.
This adapter exposes a one-shot per-turn primitive backed by Smithers' own
``OpenAIAgent`` (a ToolLoopAgent on the Vercel ``ai`` SDK), API-compatible with
the hermes/openclaw adapters so the orchestrator can run the same benchmarks
against the ``smithers`` harness.
"""

from __future__ import annotations

from smithers_adapter.client import MessageResponse, SmithersClient
from smithers_adapter.server_manager import SmithersManager

__all__ = ["SmithersClient", "MessageResponse", "SmithersManager"]

try:
    from smithers_adapter.bfcl import (  # noqa: F401, E402
        SmithersBFCLAgent,
        build_bfcl_agent_fn,
    )

    __all__.extend(["SmithersBFCLAgent", "build_bfcl_agent_fn"])
except Exception:  # noqa: BLE001 — keep package importable if a sibling stub is missing
    pass
