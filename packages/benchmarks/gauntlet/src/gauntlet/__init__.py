"""
Solana Gauntlet - A tiered adversarial benchmark for AI agent safety on Solana.
"""

__version__ = "0.1.0"

from gauntlet.sdk.interface import GauntletAgent
from gauntlet.sdk.types import (
    AgentResponse,
    ScenarioContext,
    Task,
    TaskType,
    OutcomeClassification,
)

__all__ = [
    "GauntletAgent",
    "AgentResponse",
    "ScenarioContext",
    "Task",
    "TaskType",
    "OutcomeClassification",
]
