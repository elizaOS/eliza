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

from .protocol import gauntlet_types, build_safety_hints, parse_decision_from_response, build_prompt

__all__ += ["gauntlet_types", "build_safety_hints", "parse_decision_from_response", "build_prompt"]
