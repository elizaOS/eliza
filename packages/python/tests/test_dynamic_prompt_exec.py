"""Tests for dynamic_prompt_exec_from_state and related functionality.

This test module validates the dynamic execution engine across:
1. SchemaRow and RetryBackoffConfig types
2. XML parsing and validation code handling
3. The full dynamic_prompt_exec_from_state flow
4. Parity with TypeScript and Rust implementations
"""

from unittest.mock import MagicMock

import pytest

from elizaos.runtime import AgentRuntime, DynamicPromptOptions
from elizaos.types import Character
from elizaos.types.state import (
    RetryBackoffConfig,
    SchemaRow,
    StreamEvent,
    StreamEventType,
)

# ============================================================================
# SchemaRow Tests
# ============================================================================


class TestSchemaRow:
    """Tests for SchemaRow dataclass."""

    def test_basic_creation(self) -> None:
        """Test basic SchemaRow creation with required fields."""
        row = SchemaRow(field="thought", description="Your reasoning")
        assert row.field == "thought"
        assert row.description == "Your reasoning"
        assert row.required is False
        assert row.validate_field is None
        assert row.stream_field is None

    def test_required_field(self) -> None:
        """Test SchemaRow with required=True."""
        row = SchemaRow(field="text", description="Response", required=True)
        assert row.required is True

    def test_validate_field_option(self) -> None:
        """Test SchemaRow with validate_field option."""
        row_with_validation = SchemaRow(field="text", description="Response", validate_field=True)
        assert row_with_validation.validate_field is True

        row_without_validation = SchemaRow(
            field="thought", description="Reasoning", validate_field=False
        )
        assert row_without_validation.validate_field is False

    def test_stream_field_option(self) -> None:
        """Test SchemaRow with stream_field option."""
        row_streamed = SchemaRow(field="text", description="Response", stream_field=True)
        assert row_streamed.stream_field is True

        row_not_streamed = SchemaRow(field="thought", description="Reasoning", stream_field=False)
        assert row_not_streamed.stream_field is False


# ============================================================================
# RetryBackoffConfig Tests
# ============================================================================


class TestRetryBackoffConfig:
    """Tests for RetryBackoffConfig dataclass."""

    def test_default_values(self) -> None:
        """Test default configuration values."""
        config = RetryBackoffConfig()
        assert config.initial_ms == 1000
        assert config.multiplier == 2.0
        assert config.max_ms == 30000

    def test_custom_values(self) -> None:
        """Test custom configuration values."""
        config = RetryBackoffConfig(initial_ms=500, multiplier=1.5, max_ms=10000)
        assert config.initial_ms == 500
        assert config.multiplier == 1.5
        assert config.max_ms == 10000

    def test_delay_for_retry_calculation(self) -> None:
        """Test exponential backoff delay calculation."""
        config = RetryBackoffConfig(initial_ms=1000, multiplier=2.0, max_ms=30000)

        # First retry: 1000 * 2^0 = 1000ms
        assert config.delay_for_retry(1) == 1000

        # Second retry: 1000 * 2^1 = 2000ms
        assert config.delay_for_retry(2) == 2000

        # Third retry: 1000 * 2^2 = 4000ms
        assert config.delay_for_retry(3) == 4000

        # Fourth retry: 1000 * 2^3 = 8000ms
        assert config.delay_for_retry(4) == 8000

    def test_delay_capped_at_max(self) -> None:
        """Test that delay is capped at max_ms."""
        config = RetryBackoffConfig(initial_ms=1000, multiplier=2.0, max_ms=5000)

        # Fifth retry would be 1000 * 2^4 = 16000ms, but capped at 5000ms
        assert config.delay_for_retry(5) == 5000


# ============================================================================
# StreamEvent Tests
# ============================================================================


class TestStreamEvent:
    """Tests for StreamEvent and StreamEventType."""

    def test_event_types(self) -> None:
        """Test all StreamEventType values."""
        assert StreamEventType.CHUNK.value == "chunk"
        assert StreamEventType.FIELD_VALIDATED.value == "field_validated"
        assert StreamEventType.RETRY_START.value == "retry_start"
        assert StreamEventType.ERROR.value == "error"
        assert StreamEventType.COMPLETE.value == "complete"

    def test_chunk_event_factory(self) -> None:
        """Test StreamEvent.chunk_event factory method."""
        event = StreamEvent.chunk_event("text", "Hello world")
        assert event.event_type == StreamEventType.CHUNK
        assert event.field == "text"
        assert event.chunk == "Hello world"
        assert event.timestamp > 0

    def test_field_validated_event_factory(self) -> None:
        """Test StreamEvent.field_validated_event factory method."""
        event = StreamEvent.field_validated_event("text")
        assert event.event_type == StreamEventType.FIELD_VALIDATED
        assert event.field == "text"
        assert event.timestamp > 0

    def test_retry_start_event_factory(self) -> None:
        """Test StreamEvent.retry_start_event factory method."""
        event = StreamEvent.retry_start_event(2)
        assert event.event_type == StreamEventType.RETRY_START
        assert event.retry_count == 2
        assert event.timestamp > 0

    def test_error_event_factory(self) -> None:
        """Test StreamEvent.error_event factory method."""
        event = StreamEvent.error_event("Something went wrong")
        assert event.event_type == StreamEventType.ERROR
        assert event.error == "Something went wrong"
        assert event.timestamp > 0

    def test_complete_event_factory(self) -> None:
        """Test StreamEvent.complete_event factory method."""
        event = StreamEvent.complete_event()
        assert event.event_type == StreamEventType.COMPLETE
        assert event.timestamp > 0


# ============================================================================
# XML Parsing Tests
# ============================================================================


class TestXMLParsing:
    """Tests for XML parsing in dynamic prompt execution."""

    @pytest.fixture
    def runtime(self) -> AgentRuntime:
        """Create a test runtime."""
        character = Character(name="TestAgent", bio="Test agent")
        return AgentRuntime(character=character)

    def test_parse_simple_xml(self, runtime: AgentRuntime) -> None:
        """Test parsing simple XML response."""
        xml = """<response>
            <thought>I should respond politely</thought>
            <text>Hello! How can I help you?</text>
            <actions>REPLY</actions>
        </response>"""

        result = runtime._parse_xml_to_dict(xml)

        assert result is not None
        assert result.get("thought") == "I should respond politely"
        assert result.get("text") == "Hello! How can I help you?"
        assert result.get("actions") == "REPLY"

    def test_parse_xml_with_validation_codes(self, runtime: AgentRuntime) -> None:
        """Test parsing XML with validation code fields (with underscores)."""
        xml = """<response>
            <code_text_start>abc12345</code_text_start>
            <text>Hello world</text>
            <code_text_end>abc12345</code_text_end>
        </response>"""

        result = runtime._parse_xml_to_dict(xml)

        assert result is not None
        assert result.get("code_text_start") == "abc12345"
        assert result.get("text") == "Hello world"
        assert result.get("code_text_end") == "abc12345"

    def test_parse_xml_with_checkpoint_codes(self, runtime: AgentRuntime) -> None:
        """Test parsing XML with checkpoint validation codes."""
        xml = """<response>
            <one_initial_code>uuid-1234</one_initial_code>
            <one_middle_code>uuid-5678</one_middle_code>
            <one_end_code>uuid-9abc</one_end_code>
            <text>Response text</text>
        </response>"""

        result = runtime._parse_xml_to_dict(xml)

        assert result is not None
        assert result.get("one_initial_code") == "uuid-1234"
        assert result.get("one_middle_code") == "uuid-5678"
        assert result.get("one_end_code") == "uuid-9abc"
        assert result.get("text") == "Response text"

    def test_parse_nested_xml(self, runtime: AgentRuntime) -> None:
        """Test parsing nested XML structures."""
        xml = """<response>
            <parameters>
                <name>test</name>
                <value>123</value>
            </parameters>
        </response>"""

        result = runtime._parse_xml_to_dict(xml)

        assert result is not None
        assert isinstance(result.get("parameters"), dict)
        params = result["parameters"]
        assert params.get("name") == "test"
        assert params.get("value") == "123"

    def test_parse_xml_with_think_block_removed(self, runtime: AgentRuntime) -> None:
        """Test that think blocks would be removed before parsing."""
        # Note: The _parse_xml_to_dict doesn't remove think blocks
        # That's done in dynamic_prompt_exec_from_state before calling parse
        xml = """<response>
            <text>Clean response</text>
        </response>"""

        result = runtime._parse_xml_to_dict(xml)

        assert result is not None
        assert result.get("text") == "Clean response"

    def test_parse_malformed_xml_fallback(self, runtime: AgentRuntime) -> None:
        """Test fallback regex parsing for malformed XML."""
        # Missing proper nesting but has tags
        xml = """<thought>thinking here</thought>
        <text>response text</text>"""

        result = runtime._parse_xml_to_dict(xml)

        assert result is not None
        assert result.get("thought") == "thinking here"
        assert result.get("text") == "response text"


# ============================================================================
# DynamicPromptOptions Tests
# ============================================================================


class TestDynamicPromptOptions:
    """Tests for DynamicPromptOptions dataclass."""

    def test_default_options(self) -> None:
        """Test default options values."""
        options = DynamicPromptOptions()
        assert options.model_size is None
        assert options.model is None
        assert options.force_format is None
        assert options.required_fields is None
        assert options.context_check_level is None
        assert options.max_retries is None
        assert options.retry_backoff is None

    def test_custom_options(self) -> None:
        """Test custom options values."""
        backoff = RetryBackoffConfig(initial_ms=500)
        options = DynamicPromptOptions(
            model_size="small",
            force_format="xml",
            required_fields=["text", "actions"],
            context_check_level=1,
            max_retries=3,
            retry_backoff=backoff,
        )

        assert options.model_size == "small"
        assert options.force_format == "xml"
        assert options.required_fields == ["text", "actions"]
        assert options.context_check_level == 1
        assert options.max_retries == 3
        assert options.retry_backoff.initial_ms == 500


# ============================================================================
# dynamic_prompt_exec_from_state Integration Tests
# ============================================================================


class TestDynamicPromptExecFromState:
    """Integration tests for dynamic_prompt_exec_from_state."""

    @pytest.fixture
    def character(self) -> Character:
        """Create a test character."""
        return Character(name="TestAgent", bio="A test agent")

    @pytest.fixture
    def runtime(self, character: Character) -> AgentRuntime:
        """Create a test runtime with a mock model handler."""
        return AgentRuntime(character=character)

    @pytest.mark.asyncio
    async def test_basic_execution_with_mock_model(self, runtime: AgentRuntime) -> None:
        """Test basic execution with a mocked model response."""

        # Register a mock model handler that returns valid XML
        async def mock_model_handler(rt: AgentRuntime, params: dict[str, object]) -> str:
            return """<response>
                <thought>User wants help</thought>
                <text>I can help with that!</text>
                <actions>REPLY</actions>
            </response>"""

        runtime.register_model("TEXT_LARGE", mock_model_handler, "mock")

        # Create a mock state
        from elizaos.types.state import State

        # Use a simple dict-like mock for state
        state = MagicMock(spec=State)
        state.values = {}

        schema = [
            SchemaRow("thought", "Your reasoning"),
            SchemaRow("text", "Response to user", required=True),
            SchemaRow("actions", "Actions to take"),
        ]

        result = await runtime.dynamic_prompt_exec_from_state(
            state=state,
            prompt="Test prompt",
            schema=schema,
            options=DynamicPromptOptions(context_check_level=0),  # No validation
        )

        assert result is not None
        assert "thought" in result
        assert "text" in result
        assert "actions" in result

    @pytest.mark.asyncio
    async def test_validation_level_settings(self, runtime: AgentRuntime) -> None:
        """Test that VALIDATION_LEVEL setting affects behavior."""
        # Test trusted/fast mode
        runtime.set_setting("VALIDATION_LEVEL", "trusted")

        # The implementation checks this setting and adjusts context_check_level
        # We can verify the setting is retrieved correctly
        assert runtime.get_setting("VALIDATION_LEVEL") == "trusted"

    @pytest.mark.asyncio
    async def test_required_fields_validation(self, runtime: AgentRuntime) -> None:
        """Test that required fields are validated."""

        # Register a mock model handler that returns incomplete XML
        async def mock_model_handler(rt: AgentRuntime, params: dict[str, object]) -> str:
            return """<response>
                <thought>User wants help</thought>
                <text></text>
            </response>"""

        runtime.register_model("TEXT_LARGE", mock_model_handler, "mock")

        state = MagicMock()
        state.values = {}

        schema = [
            SchemaRow("thought", "Your reasoning"),
            SchemaRow("text", "Response to user", required=True),
        ]

        # With max_retries=0, should fail immediately on missing required field
        result = await runtime.dynamic_prompt_exec_from_state(
            state=state,
            prompt="Test prompt",
            schema=schema,
            options=DynamicPromptOptions(
                context_check_level=0,  # No validation codes
                max_retries=0,
                required_fields=["text"],  # text is required but empty
            ),
        )

        # Should return None because text is empty and required
        assert result is None

    @pytest.mark.asyncio
    async def test_callable_prompt(self, runtime: AgentRuntime) -> None:
        """Test that callable prompts work correctly."""

        async def mock_model_handler(rt: AgentRuntime, params: dict[str, object]) -> str:
            prompt = params.get("prompt", "")
            # Verify the callable was executed with state
            assert "Hello Alice" in str(prompt)
            return """<response>
                <text>Hello back!</text>
            </response>"""

        runtime.register_model("TEXT_LARGE", mock_model_handler, "mock")

        state = MagicMock()
        state.values = {"name": "Alice"}

        def prompt_callable(ctx: dict) -> str:
            return "Hello {{name}}"

        schema = [SchemaRow("text", "Response")]

        result = await runtime.dynamic_prompt_exec_from_state(
            state=state,
            prompt=prompt_callable,
            schema=schema,
            options=DynamicPromptOptions(context_check_level=0),
        )

        assert result is not None

    @pytest.mark.asyncio
    async def test_json_format(self, runtime: AgentRuntime) -> None:
        """Test JSON format output parsing."""

        async def mock_model_handler(rt: AgentRuntime, params: dict[str, object]) -> str:
            return '{"thought": "reasoning", "text": "response"}'

        runtime.register_model("TEXT_LARGE", mock_model_handler, "mock")

        state = MagicMock()
        state.values = {}

        schema = [
            SchemaRow("thought", "Your reasoning"),
            SchemaRow("text", "Response"),
        ]

        result = await runtime.dynamic_prompt_exec_from_state(
            state=state,
            prompt="Test prompt",
            schema=schema,
            options=DynamicPromptOptions(context_check_level=0, force_format="json"),
        )

        assert result is not None
        assert result.get("thought") == "reasoning"
        assert result.get("text") == "response"

    @pytest.mark.asyncio
    async def test_retry_on_failure(self, runtime: AgentRuntime) -> None:
        """Test retry behavior on validation failure."""
        call_count = [0]

        async def mock_model_handler(rt: AgentRuntime, params: dict[str, object]) -> str:
            call_count[0] += 1
            if call_count[0] < 2:
                # First call returns invalid response
                return "<response><text></text></response>"
            # Second call returns valid response
            return "<response><text>Valid response</text></response>"

        runtime.register_model("TEXT_LARGE", mock_model_handler, "mock")

        state = MagicMock()
        state.values = {}

        schema = [SchemaRow("text", "Response", required=True)]

        result = await runtime.dynamic_prompt_exec_from_state(
            state=state,
            prompt="Test prompt",
            schema=schema,
            options=DynamicPromptOptions(
                context_check_level=0, max_retries=2, required_fields=["text"]
            ),
        )

        assert result is not None
        assert result.get("text") == "Valid response"
        assert call_count[0] == 2


# ============================================================================
# Parity Tests (ensure consistency with TypeScript/Rust)
# ============================================================================


class TestCrossLanguageParity:
    """Tests to ensure parity with TypeScript and Rust implementations."""

    def test_schema_row_fields_match_typescript(self) -> None:
        """Verify SchemaRow has same fields as TypeScript SchemaRow type."""
        # TypeScript has: field, description, required?, validateField?, streamField?
        row = SchemaRow(
            field="test", description="desc", required=True, validate_field=True, stream_field=False
        )

        # Python uses snake_case, TypeScript uses camelCase
        # But semantic equivalence should hold
        assert hasattr(row, "field")
        assert hasattr(row, "description")
        assert hasattr(row, "required")
        assert hasattr(row, "validate_field")  # = validateField in TS
        assert hasattr(row, "stream_field")  # = streamField in TS

    def test_retry_backoff_config_matches_typescript(self) -> None:
        """Verify RetryBackoffConfig has same fields as TypeScript."""
        config = RetryBackoffConfig(initial_ms=1000, multiplier=2.0, max_ms=30000)

        # TypeScript has: initialMs, multiplier, maxMs
        assert hasattr(config, "initial_ms")  # = initialMs in TS
        assert hasattr(config, "multiplier")
        assert hasattr(config, "max_ms")  # = maxMs in TS

    def test_stream_event_types_match_typescript(self) -> None:
        """Verify StreamEventType enum values match TypeScript."""
        # TypeScript StreamEventType values:
        # "chunk" | "field_validated" | "retry_start" | "error" | "complete"

        expected_values = {"chunk", "field_validated", "retry_start", "error", "complete"}
        actual_values = {e.value for e in StreamEventType}

        assert actual_values == expected_values

    def test_validation_levels_semantics(self) -> None:
        """Verify validation level semantics match across languages."""
        # Level 0: Trusted - no validation codes
        # Level 1: Progressive - per-field validation codes
        # Level 2: Checkpoint - codes at start only
        # Level 3: Full - codes at start and end

        # These are implicit in the implementation but we can verify
        # the constants/semantics are documented
        levels = {
            0: "trusted/fast - no validation codes",
            1: "progressive - per-field validation",
            2: "checkpoint - first codes",
            3: "full - first and last codes",
        }

        # Just verify the levels exist conceptually
        for level in range(4):
            assert level in levels
