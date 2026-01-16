"""Local type definitions for the elizaOS Bootstrap Plugin."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from pydantic import BaseModel, Field


@dataclass
class CapabilityConfig:
    """Configuration for bootstrap capabilities.

    Attributes:
        disable_basic: If True, disables basic capabilities (reply, ignore, none, choice).
        enable_extended: If True, enables extended/advanced capabilities.
        advanced_capabilities: Alias for enable_extended (for consistency with TypeScript).
        skip_character_provider: If True, excludes the CHARACTER provider.
        enable_autonomy: If True, enables autonomy capabilities.
    """

    disable_basic: bool = False
    enable_extended: bool = False
    advanced_capabilities: bool = False  # Alias for enable_extended
    skip_character_provider: bool = False
    enable_autonomy: bool = False

    def __post_init__(self) -> None:
        """Post-initialization to handle aliasing."""
        # Support both enable_extended and advanced_capabilities
        if self.advanced_capabilities and not self.enable_extended:
            self.enable_extended = True


class EvaluatorResult(BaseModel):
    """Result from an evaluator."""

    score: int = Field(..., description="Numeric score 0-100")
    passed: bool = Field(..., description="Whether evaluation passed")
    reason: str = Field(..., description="Reason for the result")
    details: dict[str, Any] = Field(default_factory=dict, description="Additional details")

    model_config = {"populate_by_name": True}

    @classmethod
    def pass_result(cls, score: int, reason: str) -> EvaluatorResult:
        """Create a passing evaluation result."""
        return cls(score=score, passed=True, reason=reason)

    @classmethod
    def fail_result(cls, score: int, reason: str) -> EvaluatorResult:
        """Create a failing evaluation result."""
        return cls(score=score, passed=False, reason=reason)
