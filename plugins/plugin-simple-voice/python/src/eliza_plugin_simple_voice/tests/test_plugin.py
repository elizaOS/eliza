import pytest

from eliza_plugin_simple_voice import (
    SamTTSOptions,
    SamTTSService,
    say_aloud_action,
    simple_voice_plugin,
)


class MockMemory:
    """Mock memory class for testing."""

    def __init__(self, text: str):
        self._content = {"text": text}

    @property
    def content(self) -> dict[str, str]:
        return self._content


class MockRuntime:
    """Mock runtime class for testing."""

    def __init__(self) -> None:
        self._services: dict[str, object] = {}

    def get_service(self, service_type: str) -> object | None:
        return self._services.get(service_type)


class TestPlugin:
    def test_has_correct_metadata(self):
        assert simple_voice_plugin.name == "@elizaos/plugin-simple-voice"
        assert "SAM" in simple_voice_plugin.description

    def test_registers_action(self):
        assert len(simple_voice_plugin.actions) == 1
        assert simple_voice_plugin.actions[0].name == "SAY_ALOUD"

    def test_registers_service(self):
        assert len(simple_voice_plugin.services) == 1
        assert simple_voice_plugin.services[0] == SamTTSService


class TestSayAloudAction:
    @pytest.mark.asyncio
    async def test_validates_triggers(self) -> None:
        runtime = MockRuntime()

        for text in ["say aloud hello", "speak this", "voice command"]:
            assert await say_aloud_action.validate(runtime, MockMemory(text))

    @pytest.mark.asyncio
    async def test_rejects_non_triggers(self) -> None:
        runtime = MockRuntime()

        for text in ["hello world", "what is the weather"]:
            assert not await say_aloud_action.validate(runtime, MockMemory(text))


class TestSamTTSService:
    def test_has_correct_type(self):
        assert SamTTSService.service_type == "SAM_TTS"

    def test_generates_audio(self):
        service = SamTTSService()
        audio = service.generate_audio("Hello")

        assert isinstance(audio, bytes)
        assert len(audio) > 0

    def test_applies_voice_options(self):
        service = SamTTSService()

        slow = service.generate_audio("Test", SamTTSOptions(speed=40))
        fast = service.generate_audio("Test", SamTTSOptions(speed=120))

        assert len(slow) != len(fast)

    def test_creates_wav_buffer(self):
        service = SamTTSService()
        audio = service.generate_audio("Test")
        wav = service.create_wav_buffer(audio)

        assert len(wav) == len(audio) + 44
        assert wav[:4] == b"RIFF"
        assert wav[8:12] == b"WAVE"
