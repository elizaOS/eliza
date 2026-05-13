"""JSONL trace event types for agent evaluation."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Annotated, Any, Literal, Union

from pydantic import BaseModel, Field

from .message import Message


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class TokenUsage(BaseModel):
    input_tokens: int = 0
    output_tokens: int = 0


class DimensionScores(BaseModel):
    completion: float = 0.0
    robustness: float = 0.0
    communication: float = 0.0
    safety: float = 1.0  # binary gate: 0 or 1
    efficiency_turns: int = 0
    efficiency_tokens: int = 0
    efficiency_wall_time_s: float = 0.0


# --- JSONL Event Types ---


class TraceStart(BaseModel):
    type: Literal["trace_start"] = "trace_start"
    trace_id: str
    task_id: str
    model: str
    persona: str = "default"
    timestamp: str = Field(default_factory=_now)


class TraceMessage(BaseModel):
    type: Literal["message"] = "message"
    trace_id: str
    message: Message
    usage: TokenUsage = Field(default_factory=TokenUsage)
    timestamp: str = Field(default_factory=_now)


class ToolDispatch(BaseModel):
    type: Literal["tool_dispatch"] = "tool_dispatch"
    trace_id: str
    tool_use_id: str
    tool_name: str
    endpoint_url: str
    request_body: dict[str, Any] = Field(default_factory=dict)
    response_status: int = 200
    response_body: Any = None
    latency_ms: float = 0.0
    timestamp: str = Field(default_factory=_now)


class AuditSnapshot(BaseModel):
    type: Literal["audit_snapshot"] = "audit_snapshot"
    trace_id: str
    service_name: str
    audit_url: str
    audit_data: dict[str, Any] = Field(default_factory=dict)
    timestamp: str = Field(default_factory=_now)


class MediaLoad(BaseModel):
    type: Literal["media_load"] = "media_load"
    trace_id: str
    modality: Literal["image", "audio", "video", "document"]
    source_path: str
    mime_type: str
    size_bytes: int
    sha256: str
    status: Literal["loaded", "skipped", "error"] = "loaded"
    note: str = ""
    timestamp: str = Field(default_factory=_now)


class TraceEnd(BaseModel):
    type: Literal["trace_end"] = "trace_end"
    trace_id: str
    total_turns: int = 0
    model_input_tokens: int = 0
    model_output_tokens: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0
    model_time_s: float = 0.0
    tool_time_s: float = 0.0
    other_time_s: float = 0.0
    wall_time_s: float = 0.0
    scores: DimensionScores = Field(default_factory=DimensionScores)
    task_score: float = 0.0
    passed: bool = False
    failure_modes: list[str] = Field(default_factory=list)
    user_agent_rounds: int = 0
    user_agent_max_rounds: int = 0
    user_agent_done: bool = False
    timestamp: str = Field(default_factory=_now)


class CompactEvent(BaseModel):
    type: Literal["compact"] = "compact"
    trace_id: str
    layer: Literal["micro", "auto", "manual"]
    estimated_tokens_before: int = 0
    estimated_tokens_after: int = 0
    messages_before: int = 0
    messages_after: int = 0
    timestamp: str = Field(default_factory=_now)


class GradingResult(BaseModel):
    type: Literal["grading_result"] = "grading_result"
    trace_id: str
    task_id: str
    scores: DimensionScores = Field(default_factory=DimensionScores)
    task_score: float = 0.0
    passed: bool = False
    failure_modes: list[str] = Field(default_factory=list)
    judge_calls: list[dict] = Field(default_factory=list)
    user_agent_meta: dict = Field(default_factory=dict)
    timestamp: str = Field(default_factory=_now)


TraceEvent = Annotated[
    Union[TraceStart, TraceMessage, ToolDispatch, AuditSnapshot, MediaLoad, CompactEvent, TraceEnd, GradingResult],
    Field(discriminator="type"),
]
