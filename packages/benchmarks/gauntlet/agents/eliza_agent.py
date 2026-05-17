#!/usr/bin/env python3
"""Compatibility shim for the Solana Gauntlet Eliza agent.

The old Python runtime agent path has been removed. This file now re-exports
the bridge-backed agent so older ``agents/eliza_agent.py`` references still run
through the TypeScript benchmark bridge.
"""

from eliza_adapter.gauntlet import Agent

__all__ = ["Agent"]
