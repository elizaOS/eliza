"""
Environment adapters for AgentBench.

Each adapter interfaces between the ElizaOS runtime and a specific
AgentBench environment. Adapters preserve upstream's scoring contract
where possible (label-set equality for DB, set match + F1 for KG,
match/check scripts for OS, BLEU-key match for LTP, etc.).
"""

from elizaos_agentbench.adapters.base import EnvironmentAdapter
from elizaos_agentbench.adapters.card_game_adapter import CardGameAdapter
from elizaos_agentbench.adapters.db_adapter import DatabaseEnvironmentAdapter
from elizaos_agentbench.adapters.householding_adapter import HouseholdingEnvironmentAdapter
from elizaos_agentbench.adapters.kg_adapter import KnowledgeGraphAdapter
from elizaos_agentbench.adapters.lateral_thinking_adapter import LateralThinkingAdapter
from elizaos_agentbench.adapters.os_adapter import OSEnvironmentAdapter
from elizaos_agentbench.adapters.web_browsing_adapter import WebBrowsingAdapter
from elizaos_agentbench.adapters.webshop_adapter import WebShopEnvironmentAdapter

__all__ = [
    "EnvironmentAdapter",
    "CardGameAdapter",
    "DatabaseEnvironmentAdapter",
    "HouseholdingEnvironmentAdapter",
    "KnowledgeGraphAdapter",
    "LateralThinkingAdapter",
    "OSEnvironmentAdapter",
    "WebBrowsingAdapter",
    "WebShopEnvironmentAdapter",
]
