"""Benchmark adapter for the TypeScript eliza agent.

Bridges Python benchmark runners with the eliza benchmark HTTP server.
"""

from eliza_adapter.client import ElizaClient
from eliza_adapter.server_manager import ElizaServerManager

__all__ = ["ElizaClient", "ElizaServerManager"]
