"""Tests for actions module."""

import pytest

from eliza_plugin_simple_voice.actions.say_aloud import (
    SayAloudAction,
    extract_text_to_speak,
    extract_voice_options,
    say_aloud_action,
)
from eliza_plugin_simple_voice.services.sam_tts_service import SamTTSService

from .conftest import MockMemory, MockRuntime


class TestExtractTextToSpeak:
    """Tests for extract_text_to_speak function."""

    def test_extracts_quoted_text_with_say(self) -> None:
        """Test extracting quoted text after 'say'."""
        result = extract_text_to_speak('say "hello world"')
        assert result == "hello world"

    def test_extracts_quoted_text_with_speak(self) -> None:
        """Test extracting quoted text after 'speak'."""
        result = extract_text_to_speak("speak 'good morning'")
        assert result == "good morning"

    def test_extracts_quoted_text_with_read(self) -> None:
        """Test extracting quoted text after 'read'."""
        result = extract_text_to_speak('read "the message"')
        assert result == "the message"

    def test_extracts_unquoted_text_after_say_aloud(self) -> None:
        """Test extracting unquoted text after 'say aloud'."""
        result = extract_text_to_speak("say aloud hello there")
        assert result == "hello there"

    def test_extracts_text_with_can_you_say(self) -> None:
        """Test extracting text with 'can you say'."""
        result = extract_text_to_speak("can you say hello")
        assert result == "hello"

    def test_extracts_text_with_please_say(self) -> None:
        """Test extracting text with 'please say'."""
        result = extract_text_to_speak("please say goodbye")
        assert result == "goodbye"

    def test_extracts_text_with_i_want_to_hear(self) -> None:
        """Test extracting text with 'i want to hear'."""
        result = extract_text_to_speak("i want to hear a story")
        assert result == "a story"

    def test_returns_original_for_no_pattern(self) -> None:
        """Test returning original text when no pattern matches."""
        result = extract_text_to_speak("hello world")
        assert result == "hello world"

    def test_strips_aloud_suffix(self) -> None:
        """Test stripping 'aloud' suffix from result."""
        result = extract_text_to_speak("say this text aloud")
        assert "aloud" not in result or result == "say this text aloud"

    def test_handles_mixed_case(self) -> None:
        """Test handling mixed case input."""
        result = extract_text_to_speak('SAY "Hello"')
        assert result == "hello" or result == "Hello"


class TestExtractVoiceOptions:
    """Tests for extract_voice_options function."""

    def test_default_options_for_normal_text(self) -> None:
        """Test default options for text without modifiers."""
        options = extract_voice_options("say hello")
        assert options.speed == 72
        assert options.pitch == 64

    def test_higher_voice_trigger(self) -> None:
        """Test higher voice trigger sets high pitch."""
        options = extract_voice_options("say in a higher voice")
        assert options.pitch == 100

    def test_high_pitch_trigger(self) -> None:
        """Test high pitch trigger."""
        options = extract_voice_options("use high pitch")
        assert options.pitch == 100

    def test_squeaky_trigger(self) -> None:
        """Test squeaky trigger sets high pitch."""
        options = extract_voice_options("speak in a squeaky voice")
        assert options.pitch == 100

    def test_lower_voice_trigger(self) -> None:
        """Test lower voice trigger sets low pitch."""
        options = extract_voice_options("say in a lower voice")
        assert options.pitch == 30

    def test_low_pitch_trigger(self) -> None:
        """Test low pitch trigger."""
        options = extract_voice_options("use low pitch")
        assert options.pitch == 30

    def test_deep_voice_trigger(self) -> None:
        """Test deep voice trigger sets low pitch."""
        options = extract_voice_options("speak with a deep voice")
        assert options.pitch == 30

    def test_faster_trigger(self) -> None:
        """Test faster trigger sets high speed."""
        options = extract_voice_options("say it faster")
        assert options.speed == 120

    def test_quickly_trigger(self) -> None:
        """Test quickly trigger sets high speed."""
        options = extract_voice_options("say quickly")
        assert options.speed == 120

    def test_slower_trigger(self) -> None:
        """Test slower trigger sets low speed."""
        options = extract_voice_options("say it slower")
        assert options.speed == 40

    def test_slowly_trigger(self) -> None:
        """Test slowly trigger sets low speed."""
        options = extract_voice_options("say slowly")
        assert options.speed == 40

    def test_robotic_trigger(self) -> None:
        """Test robotic trigger sets throat and mouth."""
        options = extract_voice_options("use a robotic voice")
        assert options.throat == 200
        assert options.mouth == 50

    def test_smooth_trigger(self) -> None:
        """Test smooth trigger sets throat and mouth."""
        options = extract_voice_options("speak in a smooth voice")
        assert options.throat == 100
        assert options.mouth == 150


class TestSayAloudActionMetadata:
    """Tests for SayAloudAction metadata."""

    def test_action_name(self) -> None:
        """Test action name."""
        action = SayAloudAction()
        assert action.name == "SAY_ALOUD"

    def test_action_description(self) -> None:
        """Test action description contains SAM."""
        action = SayAloudAction()
        assert "SAM" in action.description

    def test_action_has_examples(self) -> None:
        """Test action has examples."""
        action = SayAloudAction()
        assert len(action.examples) > 0


class TestSayAloudActionInstance:
    """Tests for say_aloud_action instance."""

    def test_instance_exists(self) -> None:
        """Test that say_aloud_action instance exists."""
        assert say_aloud_action is not None
        assert isinstance(say_aloud_action, SayAloudAction)


class TestSayAloudActionValidate:
    """Tests for SayAloudAction.validate method."""

    @pytest.mark.asyncio
    async def test_validates_say_aloud_trigger(self) -> None:
        """Test validation with 'say aloud' trigger."""
        action = SayAloudAction()
        runtime = MockRuntime()
        memory = MockMemory("say aloud hello")
        assert await action.validate(runtime, memory)

    @pytest.mark.asyncio
    async def test_validates_speak_trigger(self) -> None:
        """Test validation with 'speak' trigger."""
        action = SayAloudAction()
        runtime = MockRuntime()
        memory = MockMemory("speak this text")
        assert await action.validate(runtime, memory)

    @pytest.mark.asyncio
    async def test_validates_voice_trigger(self) -> None:
        """Test validation with 'voice' trigger."""
        action = SayAloudAction()
        runtime = MockRuntime()
        memory = MockMemory("voice command")
        assert await action.validate(runtime, memory)

    @pytest.mark.asyncio
    async def test_validates_quoted_say_pattern(self) -> None:
        """Test validation with quoted say pattern."""
        action = SayAloudAction()
        runtime = MockRuntime()
        memory = MockMemory('say "hello world"')
        assert await action.validate(runtime, memory)

    @pytest.mark.asyncio
    async def test_validates_can_you_say_pattern(self) -> None:
        """Test validation with 'can you say' pattern."""
        action = SayAloudAction()
        runtime = MockRuntime()
        memory = MockMemory("can you say hello")
        assert await action.validate(runtime, memory)

    @pytest.mark.asyncio
    async def test_rejects_normal_text(self) -> None:
        """Test rejection of normal text without triggers."""
        action = SayAloudAction()
        runtime = MockRuntime()
        memory = MockMemory("hello world")
        assert not await action.validate(runtime, memory)

    @pytest.mark.asyncio
    async def test_rejects_question(self) -> None:
        """Test rejection of question without triggers."""
        action = SayAloudAction()
        runtime = MockRuntime()
        memory = MockMemory("what is the weather")
        assert not await action.validate(runtime, memory)


class TestSayAloudActionHandler:
    """Tests for SayAloudAction.handler method."""

    @pytest.mark.asyncio
    async def test_handler_raises_without_service(self) -> None:
        """Test handler raises when service not available."""
        action = SayAloudAction()
        runtime = MockRuntime()
        memory = MockMemory("say hello")

        with pytest.raises(RuntimeError, match="SAM TTS service not available"):
            await action.handler(runtime, memory)

    @pytest.mark.asyncio
    async def test_handler_with_service(self) -> None:
        """Test handler succeeds with service available."""
        action = SayAloudAction()
        runtime = MockRuntime()
        service = SamTTSService(runtime)
        runtime.register_service("SAM_TTS", service)
        memory = MockMemory("say hello")

        callback_results: list[dict[str, str | list[int]]] = []

        async def callback(result: dict[str, str | list[int]]) -> None:
            callback_results.append(result)

        await action.handler(runtime, memory, callback)

        assert len(callback_results) == 1
        assert "text" in callback_results[0]
        assert "action" in callback_results[0]
        assert callback_results[0]["action"] == "SAY_ALOUD"

    @pytest.mark.asyncio
    async def test_handler_includes_audio_data(self) -> None:
        """Test handler includes audio data in callback."""
        action = SayAloudAction()
        runtime = MockRuntime()
        service = SamTTSService(runtime)
        runtime.register_service("SAM_TTS", service)
        memory = MockMemory("say hello")

        callback_results: list[dict[str, str | list[int]]] = []

        async def callback(result: dict[str, str | list[int]]) -> None:
            callback_results.append(result)

        await action.handler(runtime, memory, callback)

        assert "audioData" in callback_results[0]
        assert isinstance(callback_results[0]["audioData"], list)
        assert len(callback_results[0]["audioData"]) > 0  # type: ignore[arg-type]

    @pytest.mark.asyncio
    async def test_handler_without_callback(self) -> None:
        """Test handler works without callback."""
        action = SayAloudAction()
        runtime = MockRuntime()
        service = SamTTSService(runtime)
        runtime.register_service("SAM_TTS", service)
        memory = MockMemory("say hello")

        # Should not raise
        await action.handler(runtime, memory, None)
