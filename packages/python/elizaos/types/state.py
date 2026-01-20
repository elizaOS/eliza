from __future__ import annotations

import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional

from elizaos.types.generated.eliza.v1 import state_pb2

ActionPlanStep = state_pb2.ActionPlanStep
ActionPlan = state_pb2.ActionPlan
ProviderCacheEntry = state_pb2.ProviderCacheEntry
WorkingMemoryItem = state_pb2.WorkingMemoryItem
StateData = state_pb2.StateData
StateValues = state_pb2.StateValues
State = state_pb2.State


# ============================================================================
# Dynamic Prompt Execution Types
# ============================================================================


@dataclass
class SchemaRow:
    """Schema row for dynamic prompt execution.

    WHY: dynamic_prompt_exec_from_state generates structured prompts that ask the LLM
    to output specific fields. Each SchemaRow defines one field the LLM must produce.
    The schema also controls validation behavior for streaming scenarios.

    Example:
        schema = [
            SchemaRow("thought", "Your internal reasoning"),
            SchemaRow("text", "Response to user", required=True),
            SchemaRow("actions", "Actions to execute"),
        ]
    """

    field: str
    """Field name - will become an XML tag or JSON property"""

    description: str
    """Description shown to LLM - explains what to put in this field"""

    required: bool = False
    """If true, validation fails when field is empty/missing"""

    validate_field: Optional[bool] = None
    """Control per-field validation codes for streaming (levels 0-1 only).

    WHY: Validation codes are UUID snippets that surround each field. If the LLM
    outputs the same code before and after a field, we know the context window
    wasn't truncated mid-field. This trades off token usage for reliability.

    Behavior by level:
    - Level 0 (Trusted): default False. Set to True to opt-in to per-field codes.
    - Level 1 (Progressive): default True. Set to False to opt-out of codes.
    - Levels 2-3: ignored (uses checkpoint codes at start/end of response instead).
    """

    stream_field: Optional[bool] = None
    """Control whether this field's content is streamed to the consumer.

    WHY: Not all fields should be shown to users in real-time:
    - 'thought': Internal reasoning - might be verbose or confusing to show
    - 'actions': System field for action routing - not user-visible
    - 'text': The actual response - should definitely stream

    Default: True for 'text' field, False for others.
    """


@dataclass
class RetryBackoffConfig:
    """Configuration for retry backoff timing.

    WHY: When retries happen, immediate retries can:
    - Overwhelm rate-limited APIs
    - Hit transient failures repeatedly
    - Waste resources on brief outages

    Backoff gives the system time to recover between attempts.
    """

    initial_ms: int = 1000
    """Initial delay in milliseconds before first retry. Default: 1000ms (1 second)"""

    multiplier: float = 2.0
    """Multiplier for exponential backoff. delay = initial_ms * multiplier^(retry_count - 1). Default: 2"""

    max_ms: int = 30000
    """Maximum delay in milliseconds. Caps exponential growth. Default: 30000ms (30 seconds)"""

    def delay_for_retry(self, retry_count: int) -> int:
        """Calculate the delay for a given retry attempt (1-indexed)."""
        delay = self.initial_ms * (self.multiplier ** (retry_count - 1))
        return min(int(delay), self.max_ms)


class StreamEventType(str, Enum):
    """Stream event types for validation-aware streaming.

    Rich consumers receive these typed events for custom UX handling.
    """

    CHUNK = "chunk"
    """Regular content chunk being streamed"""

    FIELD_VALIDATED = "field_validated"
    """A field passed validation (level 1)"""

    RETRY_START = "retry_start"
    """Starting a retry attempt"""

    ERROR = "error"
    """Unrecoverable error occurred"""

    COMPLETE = "complete"
    """Successfully finished all validation"""


@dataclass
class StreamEvent:
    """Rich stream event for sophisticated consumers.

    WHY: Simple consumers just want text chunks. Advanced UIs want to know
    about validation progress, retries, and errors to show appropriate UI
    (spinners, clear partial content, error messages).
    """

    event_type: StreamEventType
    """Event type"""

    timestamp: int = field(default_factory=lambda: int(time.time() * 1000))
    """Timestamp of the event (milliseconds since epoch)"""

    field: Optional[str] = None
    """Field name (for chunk and field_validated events)"""

    chunk: Optional[str] = None
    """Content chunk (for chunk events)"""

    retry_count: Optional[int] = None
    """Retry attempt number (for retry_start events)"""

    error: Optional[str] = None
    """Error message (for error events)"""

    @classmethod
    def chunk_event(cls, field: str, chunk: str) -> "StreamEvent":
        """Create a chunk event."""
        return cls(event_type=StreamEventType.CHUNK, field=field, chunk=chunk)

    @classmethod
    def field_validated_event(cls, field: str) -> "StreamEvent":
        """Create a field_validated event."""
        return cls(event_type=StreamEventType.FIELD_VALIDATED, field=field)

    @classmethod
    def retry_start_event(cls, retry_count: int) -> "StreamEvent":
        """Create a retry_start event."""
        return cls(event_type=StreamEventType.RETRY_START, retry_count=retry_count)

    @classmethod
    def error_event(cls, message: str) -> "StreamEvent":
        """Create an error event."""
        return cls(event_type=StreamEventType.ERROR, error=message)

    @classmethod
    def complete_event(cls) -> "StreamEvent":
        """Create a complete event."""
        return cls(event_type=StreamEventType.COMPLETE)


__all__ = [
    "ActionPlanStep",
    "ActionPlan",
    "ProviderCacheEntry",
    "WorkingMemoryItem",
    "StateData",
    "StateValues",
    "State",
    # Dynamic prompt execution types
    "SchemaRow",
    "RetryBackoffConfig",
    "StreamEventType",
    "StreamEvent",
]
