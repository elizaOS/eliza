"""HyperliquidBench Actions for ElizaOS."""

from .execute_plan import execute_plan_action
from .generate_plan import generate_plan_action

__all__ = [
    "generate_plan_action",
    "execute_plan_action",
    "HL_ACTIONS",
]

HL_ACTIONS = [
    generate_plan_action,
    execute_plan_action,
]
