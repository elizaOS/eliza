"""Type definitions for plugin-lobster."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class LobsterAction(str, Enum):
    """Lobster pipeline actions."""

    RUN = "run"
    RESUME = "resume"


@dataclass
class LobsterRunParams:
    """Parameters for running a Lobster pipeline."""

    pipeline: str
    args: dict[str, Any] = field(default_factory=dict)
    cwd: str | None = None


@dataclass
class LobsterResumeParams:
    """Parameters for resuming a paused Lobster pipeline."""

    token: str
    approve: bool = True


@dataclass
class LobsterApprovalRequest:
    """Approval request from a paused pipeline."""

    step_name: str
    description: str
    resume_token: str


@dataclass
class LobsterSuccessEnvelope:
    """Success response from Lobster."""

    status: str  # "success" | "needs_approval"
    outputs: dict[str, Any] | None = None
    approval: LobsterApprovalRequest | None = None


@dataclass
class LobsterErrorEnvelope:
    """Error response from Lobster."""

    status: str  # "error"
    error: str
    code: str | None = None


LobsterEnvelope = LobsterSuccessEnvelope | LobsterErrorEnvelope


@dataclass
class LobsterConfig:
    """Configuration for the Lobster service."""

    lobster_path: str = "lobster"
    timeout_ms: int = 300000  # 5 minutes
    max_stdout_bytes: int = 1048576  # 1MB


@dataclass
class LobsterResult:
    """Result from a Lobster operation."""

    success: bool
    status: str
    outputs: dict[str, Any] | None = None
    approval: LobsterApprovalRequest | None = None
    error: str | None = None
