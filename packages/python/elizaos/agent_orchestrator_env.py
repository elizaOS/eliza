"""Parity with TypeScript `plugin-collector`: optional agent orchestrator (PTY) via env."""

from __future__ import annotations

import os


def eliza_agent_orchestrator_load_requested() -> bool:
    """Match `elizaAgentOrchestratorLoadRequested()` in `plugin-collector.ts`."""
    raw = (os.environ.get("ELIZA_AGENT_ORCHESTRATOR") or "").strip().lower()
    if raw in ("0", "false", "no"):
        return False
    return raw in ("1", "true", "yes")
