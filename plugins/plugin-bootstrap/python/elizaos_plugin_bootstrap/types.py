"""
Local type definitions for the elizaOS Bootstrap Plugin.

These types supplement the core elizaos types with plugin-specific
structures that may not be available in all versions of the core package.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


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


