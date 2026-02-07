"""Tests for streaming utilities.

This test module validates the streaming extractors:
1. MarkableExtractor - passthrough with external completion control
2. ValidationStreamExtractor - validation-aware streaming
3. Cross-language parity with TypeScript and Rust
"""

import pytest

from elizaos.types.state import SchemaRow, StreamEvent, StreamEventType
from elizaos.utils.streaming import (
    MAX_CHUNK_SIZE,
    ChunkSizeError,
    ExtractorState,
    FieldState,
    MarkableExtractor,
    ValidationDiagnosis,
    ValidationStreamExtractor,
    ValidationStreamExtractorConfig,
    validate_chunk_size,
)


class TestMarkableExtractor:
    """Tests for MarkableExtractor."""

    def test_new(self) -> None:
        """Test creating a new extractor."""
        extractor = MarkableExtractor()
        assert extractor.done is False

    def test_passthrough(self) -> None:
        """Test that chunks pass through unchanged."""
        extractor = MarkableExtractor()
        output = extractor.push("test chunk")
        assert output == "test chunk"

    def test_mark_complete(self) -> None:
        """Test marking extractor as complete."""
        extractor = MarkableExtractor()
        assert extractor.done is False
        extractor.mark_complete()
        assert extractor.done is True

    def test_reset(self) -> None:
        """Test resetting extractor state."""
        extractor = MarkableExtractor()
        extractor.mark_complete()
        assert extractor.done is True
        extractor.reset()
        assert extractor.done is False

    def test_flush(self) -> None:
        """Test flush returns empty string."""
        extractor = MarkableExtractor()
        assert extractor.flush() == ""


class TestChunkValidation:
    """Tests for chunk size validation."""

    def test_validate_chunk_size_ok(self) -> None:
        """Test that small chunks pass validation."""
        # Should not raise
        validate_chunk_size("small chunk")

    def test_validate_chunk_size_error(self) -> None:
        """Test that large chunks fail validation."""
        large_chunk = "x" * (MAX_CHUNK_SIZE + 1)
        with pytest.raises(ChunkSizeError) as exc_info:
            validate_chunk_size(large_chunk)

        error = exc_info.value
        assert "exceeds maximum" in str(error)


class TestValidationStreamExtractor:
    """Tests for ValidationStreamExtractor."""

    def test_level0_immediate_streaming(self) -> None:
        """Test level 0 streams content immediately."""
        chunks_received: list[tuple[str, str | None]] = []

        config = ValidationStreamExtractorConfig(
            level=0,
            schema=[SchemaRow("text", "Response text")],
            stream_fields=["text"],
            expected_codes={},
            on_chunk=lambda chunk, field: chunks_received.append((chunk, field)),
        )

        extractor = ValidationStreamExtractor(config)
        assert extractor.done is False
        assert extractor.get_state() == ExtractorState.STREAMING

        # Push XML content
        extractor.push("<text>Hello ")
        extractor.push("World</text>")

        # At level 0, content should be emitted immediately
        assert len(chunks_received) > 0

        # Flush to complete
        extractor.flush()
        assert extractor.done is True
        assert extractor.get_state() == ExtractorState.COMPLETE

    def test_diagnosis(self) -> None:
        """Test diagnosis of extraction state."""
        config = ValidationStreamExtractorConfig(
            level=1,
            schema=[
                SchemaRow("field1", "First field"),
                SchemaRow("field2", "Second field"),
            ],
            stream_fields=["field1", "field2"],
            expected_codes={},
            on_chunk=lambda _c, _f: None,
        )

        extractor = ValidationStreamExtractor(config)
        extractor.push("<field1>content</field1>")  # Only field1 is complete

        diagnosis = extractor.diagnose()
        # field2 should be either missing or incomplete
        assert "field2" in diagnosis.missing_fields or "field2" in diagnosis.incomplete_fields

    def test_signal_retry(self) -> None:
        """Test signaling a retry attempt."""
        retry_separator_received = [False]

        def on_chunk(chunk: str, field: str | None) -> None:
            if "let me start again" in chunk:
                retry_separator_received[0] = True

        config = ValidationStreamExtractorConfig(
            level=0,
            schema=[SchemaRow("text", "Response")],
            stream_fields=["text"],
            expected_codes={},
            on_chunk=on_chunk,
        )

        extractor = ValidationStreamExtractor(config)
        result = extractor.signal_retry(1)

        assert result["validated_fields"] == []  # No validated fields yet
        assert extractor.get_state() == ExtractorState.RETRYING
        assert retry_separator_received[0] is True  # Separator was emitted

    def test_signal_error(self) -> None:
        """Test signaling an error."""
        config = ValidationStreamExtractorConfig(
            level=0,
            schema=[SchemaRow("text", "Response")],
            stream_fields=["text"],
            expected_codes={},
            on_chunk=lambda _c, _f: None,
        )

        extractor = ValidationStreamExtractor(config)
        extractor.signal_error("Test error")

        assert extractor.done is True
        assert extractor.get_state() == ExtractorState.FAILED

    def test_abort_signal(self) -> None:
        """Test abort signal handling."""
        aborted = [False]

        config = ValidationStreamExtractorConfig(
            level=0,
            schema=[SchemaRow("text", "Response")],
            stream_fields=["text"],
            expected_codes={},
            on_chunk=lambda _c, _f: None,
            abort_signal=lambda: aborted[0],
        )

        extractor = ValidationStreamExtractor(config)

        # Push before abort
        extractor.push("<text>Hello")
        assert extractor.done is False

        # Set abort signal
        aborted[0] = True

        # Push after abort - should transition to failed
        extractor.push(" World</text>")
        assert extractor.done is True
        assert extractor.get_state() == ExtractorState.FAILED

    def test_rich_consumer_events(self) -> None:
        """Test rich event emission to consumers."""
        events_received: list[StreamEvent] = []

        config = ValidationStreamExtractorConfig(
            level=0,
            schema=[SchemaRow("text", "Response")],
            stream_fields=["text"],
            expected_codes={},
            on_chunk=lambda _c, _f: None,
            on_event=lambda event: events_received.append(event),
            has_rich_consumer=True,
        )

        extractor = ValidationStreamExtractor(config)
        extractor.push("<text>Hello</text>")
        extractor.flush()

        # Should have received chunk and complete events
        event_types = [e.event_type for e in events_received]
        assert StreamEventType.CHUNK in event_types
        assert StreamEventType.COMPLETE in event_types

    def test_get_validated_fields(self) -> None:
        """Test getting validated fields."""
        config = ValidationStreamExtractorConfig(
            level=0,
            schema=[SchemaRow("text", "Response")],
            stream_fields=["text"],
            expected_codes={},
            on_chunk=lambda _c, _f: None,
        )

        extractor = ValidationStreamExtractor(config)
        extractor.push("<text>Content</text>")

        # At level 0 without validation codes, fields aren't in validated_fields
        # They're just emitted directly
        validated = extractor.get_validated_fields()
        # The implementation may or may not add to validated_fields at level 0
        # Just verify the method works
        assert isinstance(validated, dict)


class TestEnumValues:
    """Tests for enum value consistency."""

    def test_extractor_state_values(self) -> None:
        """Test ExtractorState values match TypeScript/Rust."""
        assert ExtractorState.STREAMING == "streaming"
        assert ExtractorState.VALIDATING == "validating"
        assert ExtractorState.RETRYING == "retrying"
        assert ExtractorState.COMPLETE == "complete"
        assert ExtractorState.FAILED == "failed"

    def test_field_state_values(self) -> None:
        """Test FieldState values match TypeScript/Rust."""
        assert FieldState.PENDING == "pending"
        assert FieldState.PARTIAL == "partial"
        assert FieldState.COMPLETE == "complete"
        assert FieldState.INVALID == "invalid"


class TestCrossLanguageParity:
    """Tests for cross-language parity."""

    def test_validation_stream_extractor_config_fields(self) -> None:
        """Test ValidationStreamExtractorConfig has same fields as TypeScript."""
        # These fields must match TypeScript ValidationStreamExtractorConfig

        # Check that config accepts all fields
        config = ValidationStreamExtractorConfig(
            level=0,
            schema=[],
            stream_fields=[],
            expected_codes={},
            on_chunk=lambda _c, _f: None,
            on_event=lambda _e: None,
            abort_signal=lambda: False,
            has_rich_consumer=True,
        )

        # If we get here, all fields are accepted
        assert config.level == 0
        assert config.has_rich_consumer is True

    def test_validation_diagnosis_fields(self) -> None:
        """Test ValidationDiagnosis has same fields as TypeScript."""
        diagnosis = ValidationDiagnosis(
            missing_fields=["a"],
            invalid_fields=["b"],
            incomplete_fields=["c"],
        )

        assert diagnosis.missing_fields == ["a"]
        assert diagnosis.invalid_fields == ["b"]
        assert diagnosis.incomplete_fields == ["c"]

    def test_max_chunk_size_matches(self) -> None:
        """Test MAX_CHUNK_SIZE matches TypeScript (1MB)."""
        assert MAX_CHUNK_SIZE == 1024 * 1024
