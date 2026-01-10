"""
Local type definitions for the elizaOS Bootstrap Plugin.

These types supplement the core elizaos types with plugin-specific
structures that may not be available in all versions of the core package.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from pydantic import BaseModel, Field


@dataclass
class CapabilityConfig:
    """
    Configuration for bootstrap capabilities.
    
    - Basic: Core functionality (reply, ignore, none actions; core providers; task/embedding services)
    - Extended: Additional features (choice, mute/follow room, roles, settings, image generation)
    """
    
    disable_basic: bool = False
    """Disable basic capabilities (default: False)"""
    
    enable_extended: bool = False
    """Enable extended capabilities (default: False)"""


class EvaluatorResult(BaseModel):
    """Result from an evaluator."""

    score: int = Field(..., description="Numeric score 0-100")
    passed: bool = Field(..., description="Whether evaluation passed")
    reason: str = Field(..., description="Reason for the result")
    details: dict[str, Any] = Field(default_factory=dict, description="Additional details")

    model_config = {"populate_by_name": True}

    @classmethod
    def pass_result(cls, score: int, reason: str) -> "EvaluatorResult":
        """Create a passing evaluation result."""
        return cls(score=score, passed=True, reason=reason)

    @classmethod
    def fail_result(cls, score: int, reason: str) -> "EvaluatorResult":
        """Create a failing evaluation result."""
        return cls(score=score, passed=False, reason=reason)


