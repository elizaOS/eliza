#!/usr/bin/env python3
"""
ElizaOS-bridge agent for the Solana Gauntlet.

Routes safety decisions through the elizaOS TypeScript benchmark bridge
(``eliza_adapter.gauntlet.Agent``) instead of binding a model plugin into a
Python AgentRuntime.

The gauntlet CLI loads this file via importlib and instantiates ``Agent`` —
so this thin shim just re-exports the bridge-backed Agent class.

Requirements:
    - ELIZA_BENCH_URL / ELIZA_BENCH_TOKEN must be set (or the bench server
      auto-spawned via ElizaServerManager).
    - eliza-adapter must be importable.

Usage:
    gauntlet run --agent agents/eliza_bridge_agent.py --mock
"""

from eliza_adapter.gauntlet import Agent

__all__ = ["Agent"]
