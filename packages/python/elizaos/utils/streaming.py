"""Streaming utilities for validation-aware content extraction.

This module provides streaming extractors that mirror the TypeScript implementation
for cross-language parity. These are used by dynamicPromptExecFromState to enable
real-time streaming while detecting context truncation.

WHY THIS EXISTS:
LLMs can silently truncate output when they hit token limits. This is catastrophic
for structured outputs - you might get half a JSON object. Traditional streaming
has no validation - you might stream half a broken response.

These extractors bridge the gap: they enable streaming while detecting truncation.
They use "validation codes" - random UUIDs that the LLM must echo. If the echoed
code matches, we know that part wasn't truncated.
"""

from collections.abc import Callable
from dataclasses import dataclass, field
from enum import StrEnum

from elizaos.types.state import SchemaRow, StreamEvent

# Maximum allowed chunk size to prevent memory issues
MAX_CHUNK_SIZE = 1024 * 1024  # 1MB


class ChunkSizeError(ValueError):
    """Error raised when a chunk exceeds the maximum allowed size."""

    pass


def validate_chunk_size(chunk: str) -> None:
    """Validate that a chunk doesn't exceed the maximum size."""
    if len(chunk) > MAX_CHUNK_SIZE:
        raise ChunkSizeError(f"Chunk size {len(chunk)} exceeds maximum {MAX_CHUNK_SIZE}")


class IStreamExtractor:
    """Interface for stream extractors.

    Stream extractors process incoming chunks and extract relevant content.
    They track completion state and can be reset for retry scenarios.
    """

    @property
    def done(self) -> bool:
        """Whether extraction is complete."""
        raise NotImplementedError

    def push(self, chunk: str) -> str:
        """Process an incoming chunk and return extracted content."""
        raise NotImplementedError

    def flush(self) -> str:
        """Flush any remaining buffered content."""
        raise NotImplementedError

    def reset(self) -> None:
        """Reset extractor state for retry."""
        raise NotImplementedError


class MarkableExtractor(IStreamExtractor):
    """Passthrough extractor that can be marked complete externally.

    WHY: When using ValidationStreamExtractor inside dynamic_prompt_exec_from_state,
    extraction/completion is handled internally. But the outer streaming context
    still needs to know when streaming is complete for retry/fallback logic.

    This extractor passes through all content and provides a mark_complete() method
    that the caller can invoke when the underlying operation completes successfully.

    Example:
        extractor = MarkableExtractor()
        ctx = create_streaming_context(extractor, callback)

        result = await dynamic_prompt_exec_from_state(...)
        if result:
            extractor.mark_complete()  # Signal success

        if ctx.is_complete():
            # Now returns True after mark_complete()
    """

    def __init__(self) -> None:
        self._done = False

    @property
    def done(self) -> bool:
        return self._done

    def push(self, chunk: str) -> str:
        validate_chunk_size(chunk)
        return chunk  # Pass through everything

    def flush(self) -> str:
        return ""

    def reset(self) -> None:
        self._done = False

    def mark_complete(self) -> None:
        """Mark the extractor as complete.

        WHY: Called by the outer code when the underlying operation completes
        successfully. This allows is_complete() to return True for retry/fallback logic.
        """
        self._done = True


class ExtractorState(StrEnum):
    """Extractor state machine for validation-aware streaming."""

    STREAMING = "streaming"  # Normal operation - actively receiving chunks
    VALIDATING = "validating"  # Stream ended, checking validation codes
    RETRYING = "retrying"  # Validation failed, preparing for retry
    COMPLETE = "complete"  # Successfully finished
    FAILED = "failed"  # Unrecoverable error


class FieldState(StrEnum):
    """Per-field state tracking for progressive validation."""

    PENDING = "pending"  # Haven't seen this field yet
    PARTIAL = "partial"  # Found opening tag but no closing tag
    COMPLETE = "complete"  # Found both tags, content extracted
    INVALID = "invalid"  # Validation codes didn't match


@dataclass
class ValidationStreamExtractorConfig:
    """Configuration for ValidationStreamExtractor."""

    level: int  # Validation level (0-3)
    schema: list[SchemaRow]
    stream_fields: list[str]
    expected_codes: dict[str, str]  # field -> expected validation code
    on_chunk: Callable[[str, str | None], None]  # chunk, field -> None
    on_event: Callable[[StreamEvent], None] | None = None
    abort_signal: Callable[[], bool] | None = None  # Returns True if aborted
    has_rich_consumer: bool = False


@dataclass
class ValidationDiagnosis:
    """Diagnosis result for error analysis."""

    missing_fields: list[str] = field(default_factory=list)  # Never started
    invalid_fields: list[str] = field(default_factory=list)  # Wrong validation codes
    incomplete_fields: list[str] = field(default_factory=list)  # Started but not completed


class ValidationStreamExtractor(IStreamExtractor):
    """Validation-aware stream extractor for dynamic_prompt_exec_from_state.

    WHY THIS EXISTS:
    LLMs can silently truncate output when they hit token limits. This is catastrophic
    for structured outputs - you might get half a JSON object. Traditional streaming
    has no validation - you might stream half a broken response.

    This extractor bridges the gap: it enables streaming while detecting truncation.
    It uses "validation codes" - random UUIDs that the LLM must echo. If the echoed
    code matches, we know that part wasn't truncated.

    VALIDATION LEVELS:
    - Level 0 (Trusted): No codes, stream immediately. Fast but no safety.
    - Level 1 (Progressive): Per-field codes, emit as each field validates.
    - Level 2 (First Checkpoint): Code at start only, buffer until validated.
    - Level 3 (Full): Codes at start AND end, maximum safety.
    """

    def __init__(self, config: ValidationStreamExtractorConfig) -> None:
        self.config = config
        self.buffer = ""
        self.field_contents: dict[str, str] = {}
        self.validated_fields: set[str] = set()
        self.emitted_content: dict[str, str] = {}
        self.field_states: dict[str, FieldState] = {}
        self._state = ExtractorState.STREAMING

        for field_name in config.stream_fields:
            self.field_states[field_name] = FieldState.PENDING

    @property
    def done(self) -> bool:
        return self._state in (ExtractorState.COMPLETE, ExtractorState.FAILED)

    def push(self, chunk: str) -> str:
        # Check for cancellation
        if self.config.abort_signal and self.config.abort_signal():
            if self._state not in (ExtractorState.COMPLETE, ExtractorState.FAILED):
                self._state = ExtractorState.FAILED
                self._emit_event(StreamEvent.error_event("Cancelled by user"))
            return ""

        if self._state != ExtractorState.STREAMING:
            return ""

        validate_chunk_size(chunk)
        self.buffer += chunk

        # Extract field contents from buffer
        self._extract_field_contents()

        # For levels 0-1, check if we can emit validated content
        if self.config.level <= 1:
            self._check_per_field_emission()

        return ""  # We emit via callbacks, not return value

    def flush(self) -> str:
        # Don't overwrite failed state (e.g., from abort)
        if self._state == ExtractorState.FAILED:
            return ""

        # For levels 2-3, emit all buffered content when validation passes
        if self.config.level >= 2:
            for field_name in self.config.stream_fields:
                content = self.field_contents.get(field_name, "")
                if content:
                    self._emit_field_content(field_name, content)

        self._state = ExtractorState.COMPLETE
        self._emit_event(StreamEvent.complete_event())
        return ""

    def reset(self) -> None:
        self.buffer = ""
        self.field_contents.clear()
        self.validated_fields.clear()
        self.emitted_content.clear()
        for field_name in self.config.stream_fields:
            self.field_states[field_name] = FieldState.PENDING
        self._state = ExtractorState.STREAMING

    def signal_retry(self, retry_count: int) -> dict[str, list[str]]:
        """Signal a retry attempt. Returns info about validated fields for smart retry prompts."""
        self._state = ExtractorState.RETRYING

        # Emit separator for simple consumers
        if not self.config.has_rich_consumer:
            self.config.on_chunk("\n-- that's not right, let me start again:\n", None)

        self._emit_event(StreamEvent.retry_start_event(retry_count))

        return {"validated_fields": list(self.validated_fields)}

    def signal_error(self, message: str) -> None:
        """Signal an unrecoverable error."""
        self._state = ExtractorState.FAILED
        self._emit_event(StreamEvent.error_event(message))

    def get_validated_fields(self) -> dict[str, str]:
        """Get fields that passed validation (for smart retry context)."""
        result = {}
        for field_name in self.validated_fields:
            content = self.field_contents.get(field_name)
            if content:
                result[field_name] = content
        return result

    def diagnose(self) -> ValidationDiagnosis:
        """Diagnose what went wrong for error reporting."""
        missing_fields = []
        invalid_fields = []
        incomplete_fields = []

        for row in self.config.schema:
            state = self.field_states.get(row.field)
            if state == FieldState.PENDING:
                missing_fields.append(row.field)
            elif state == FieldState.INVALID:
                invalid_fields.append(row.field)
            elif state == FieldState.PARTIAL:
                incomplete_fields.append(row.field)

        return ValidationDiagnosis(
            missing_fields=missing_fields,
            invalid_fields=invalid_fields,
            incomplete_fields=incomplete_fields,
        )

    def get_state(self) -> ExtractorState:
        """Get current extractor state."""
        return self._state

    # Private helpers

    def _extract_field_contents(self) -> None:
        """Extract field contents from the buffer."""
        # Pre-compute all field tags for boundary detection
        all_open_tags = [f"<{row.field}>" for row in self.config.schema]

        for row in self.config.schema:
            field_name = row.field
            open_tag = f"<{field_name}>"
            close_tag = f"</{field_name}>"

            open_idx = self.buffer.find(open_tag)
            if open_idx == -1:
                continue

            content_start = open_idx + len(open_tag)
            close_idx = self.buffer.find(close_tag, content_start)

            if close_idx != -1:
                # Complete field found
                content = self.buffer[content_start:close_idx]
                self.field_contents[field_name] = content
                self.field_states[field_name] = FieldState.COMPLETE
            elif self.field_states.get(field_name) != FieldState.COMPLETE:
                # Partial field - still streaming
                self.field_states[field_name] = FieldState.PARTIAL

                # Find the end boundary for partial content
                partial_end = len(self.buffer)
                for other_tag in all_open_tags:
                    if other_tag == open_tag:
                        continue  # Skip self
                    other_idx = self.buffer.find(other_tag, content_start)
                    if other_idx != -1 and other_idx < partial_end:
                        partial_end = other_idx

                partial_content = self.buffer[content_start:partial_end]
                self.field_contents[field_name] = partial_content

    def _check_per_field_emission(self) -> None:
        """Check and emit validated content for levels 0-1."""
        for field_name in self.config.stream_fields:
            state = self.field_states.get(field_name)
            if state == FieldState.INVALID:
                continue  # Skip already invalid fields

            content = self.field_contents.get(field_name)
            if not content:
                continue

            # Check validation codes if required
            expected_code = self.config.expected_codes.get(field_name)
            if expected_code:
                start_code_valid = self._check_validation_code(field_name, "start", expected_code)
                end_code_valid = self._check_validation_code(field_name, "end", expected_code)

                if state == FieldState.COMPLETE:
                    if start_code_valid and end_code_valid:
                        self.validated_fields.add(field_name)
                        self._emit_field_content(field_name, content)
                        self._emit_event(StreamEvent.field_validated_event(field_name))
                    elif start_code_valid and not end_code_valid:
                        # Start valid but end invalid
                        self.field_states[field_name] = FieldState.INVALID
                        self._emit_event(
                            StreamEvent.error_event(
                                f"End validation code mismatch for {field_name}"
                            )
                        )
                    else:
                        self.field_states[field_name] = FieldState.INVALID
                        self._emit_event(
                            StreamEvent.error_event(f"Validation codes mismatch for {field_name}")
                        )
            else:
                # No validation codes for this field
                if self.config.level == 0:
                    # Level 0: Stream immediately as content arrives (no validation)
                    self._emit_field_content(field_name, content)
                elif state == FieldState.COMPLETE:
                    # Levels 1-3: Stream when field is complete
                    self._emit_field_content(field_name, content)

    def _check_validation_code(self, field_name: str, position: str, expected_code: str) -> bool:
        """Check if a validation code matches."""
        code_field = f"code_{field_name}_{position}"
        open_tag = f"<{code_field}>"
        close_tag = f"</{code_field}>"

        open_idx = self.buffer.find(open_tag)
        if open_idx == -1:
            return False

        content_start = open_idx + len(open_tag)
        close_idx = self.buffer.find(close_tag, content_start)
        if close_idx == -1:
            return False

        actual_code = self.buffer[content_start:close_idx].strip()
        return actual_code == expected_code

    def _emit_field_content(self, field_name: str, content: str) -> None:
        """Emit new content for a field, tracking what's already been emitted."""
        previously_emitted = self.emitted_content.get(field_name, "")

        # Defensive check: if content shrinks, reset and emit full content
        if len(content) < len(previously_emitted):
            self.emitted_content[field_name] = content
            if content:
                self.config.on_chunk(content, field_name)
                self._emit_event(StreamEvent.chunk_event(field_name, content))
            return

        # Emit only the new portion
        if len(content) > len(previously_emitted):
            new_content = content[len(previously_emitted) :]
            self.emitted_content[field_name] = content
            self.config.on_chunk(new_content, field_name)
            self._emit_event(StreamEvent.chunk_event(field_name, new_content))

    def _emit_event(self, event: StreamEvent) -> None:
        """Emit a rich event to the consumer if they support it."""
        if self.config.on_event:
            self.config.on_event(event)


__all__ = [
    "IStreamExtractor",
    "MarkableExtractor",
    "ValidationStreamExtractor",
    "ValidationStreamExtractorConfig",
    "ValidationDiagnosis",
    "ExtractorState",
    "FieldState",
    "validate_chunk_size",
    "ChunkSizeError",
    "MAX_CHUNK_SIZE",
]
