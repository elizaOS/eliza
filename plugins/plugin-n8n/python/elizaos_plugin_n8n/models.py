from __future__ import annotations

from enum import Enum


class ClaudeModel(str, Enum):
    SONNET_3_5 = "claude-3-5-sonnet-20241022"
    OPUS_3 = "claude-3-opus-20240229"

    @classmethod
    def default(cls) -> ClaudeModel:
        return cls.OPUS_3

    @property
    def display_name(self) -> str:
        names = {
            ClaudeModel.SONNET_3_5: "Claude 3.5 Sonnet",
            ClaudeModel.OPUS_3: "Claude 3 Opus",
        }
        return names.get(self, self.value)


class JobStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"

    @property
    def is_active(self) -> bool:
        return self in (JobStatus.PENDING, JobStatus.RUNNING)

    @property
    def is_terminal(self) -> bool:
        return self in (JobStatus.COMPLETED, JobStatus.FAILED, JobStatus.CANCELLED)
