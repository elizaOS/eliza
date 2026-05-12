"""
Environment adapters for AgentBench.

Each adapter interfaces between the ElizaOS runtime and a specific
AgentBench environment.
"""

from elizaos_agentbench.adapters.base import EnvironmentAdapter
from elizaos_agentbench.adapters.os_adapter import OSEnvironmentAdapter
from elizaos_agentbench.adapters.db_adapter import DatabaseEnvironmentAdapter
from elizaos_agentbench.adapters.webshop_adapter import WebShopEnvironmentAdapter
from elizaos_agentbench.adapters.kg_adapter import KnowledgeGraphAdapter
from elizaos_agentbench.adapters.lateral_thinking_adapter import LateralThinkingAdapter

__all__ = [
    "EnvironmentAdapter",
    "OSEnvironmentAdapter",
    "DatabaseEnvironmentAdapter",
    "WebShopEnvironmentAdapter",
    "KnowledgeGraphAdapter",
    "LateralThinkingAdapter",
]
