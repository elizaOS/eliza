"""
ElizaOS Atropos Diplomacy Environment

A multi-agent Diplomacy game environment for training ElizaOS agents.
"""

from elizaos_atropos_diplomacy.types import (
    Power,
    Province,
    UnitType,
    OrderType,
    Phase,
    Season,
    Unit,
    Order,
    GameState,
    PowerState,
    Message,
)
from elizaos_atropos_diplomacy.environment import DiplomacyEnvironment
from elizaos_atropos_diplomacy.agent import DiplomacyAgent
from elizaos_atropos_diplomacy.map_data import PROVINCES, SUPPLY_CENTERS, ADJACENCIES

__version__ = "1.0.0"

__all__ = [
    # Types
    "Power",
    "Province",
    "UnitType",
    "OrderType",
    "Phase",
    "Season",
    "Unit",
    "Order",
    "GameState",
    "PowerState",
    "Message",
    # Environment
    "DiplomacyEnvironment",
    # Agent
    "DiplomacyAgent",
    # Map data
    "PROVINCES",
    "SUPPLY_CENTERS",
    "ADJACENCIES",
]
