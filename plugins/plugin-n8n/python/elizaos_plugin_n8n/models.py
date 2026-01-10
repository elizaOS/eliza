"""
Model definitions for the N8n Plugin.
"""

from __future__ import annotations

from enum import Enum


class ClaudeModel(str, Enum):
    """Available Claude model identifiers."""

    SONNET_3_5 = "claude-3-5-sonnet-20241022"
    OPUS_3 = "claude-3-opus-20240229"

    @classmethod
    def default(cls) -> "ClaudeModel":
        """Get the default model."""
        return cls.OPUS_3

    @property
    def display_name(self) -> str:
        """Get a human-readable display name."""
        names = {
            ClaudeModel.SONNET_3_5: "Claude 3.5 Sonnet",
            ClaudeModel.OPUS_3: "Claude 3 Opus",
        }
        return names.get(self, self.value)


class JobStatus(str, Enum):
    """Status of a plugin creation job."""

    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"

    @property
    def is_active(self) -> bool:
        """Check if job is still active."""
        return self in (JobStatus.PENDING, JobStatus.RUNNING)

    @property
    def is_terminal(self) -> bool:
        """Check if job has reached a terminal state."""
        return self in (JobStatus.COMPLETED, JobStatus.FAILED, JobStatus.CANCELLED)

