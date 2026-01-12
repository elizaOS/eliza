"""Tests for SamTTSService."""

import pytest

from eliza_plugin_simple_voice.services.sam_tts_service import SamTTSService
from eliza_plugin_simple_voice.types import SamTTSOptions


class TestSamTTSServiceMetadata:
    """Tests for SamTTSService metadata."""

    def test_service_type(self) -> None:
        """Test that service type is correct."""
        assert SamTTSService.service_type == "SAM_TTS"

    def test_capability_description(self) -> None:
        """Test capability description."""
        service = SamTTSService()
        desc = service.capability_description
        assert "SAM" in desc
        assert "TTS" in desc


class TestSamTTSServiceInitialization:
    """Tests for SamTTSService initialization."""

    def test_initialization_without_runtime(self) -> None:
        """Test initialization without runtime."""
        service = SamTTSService()
        assert service.runtime is None

    def test_initialization_with_runtime(self, mock_runtime: object) -> None:
        """Test initialization with runtime."""
        service = SamTTSService(mock_runtime)
        assert service.runtime is mock_runtime

    @pytest.mark.asyncio
    async def test_start_class_method(self, mock_runtime: object) -> None:
        """Test start class method."""
        service = await SamTTSService.start(mock_runtime)
        assert isinstance(service, SamTTSService)
        assert service.runtime is mock_runtime

    @pytest.mark.asyncio
    async def test_stop_method(self) -> None:
        """Test stop method completes without error."""
        service = SamTTSService()
        await service.stop()  # Should not raise


class TestSamTTSServiceGenerateAudio:
    """Tests for SamTTSService.generate_audio method."""

    def test_generates_audio_bytes(self) -> None:
        """Test that generate_audio returns bytes."""
        service = SamTTSService()
        audio = service.generate_audio("Hello")
        assert isinstance(audio, bytes)
        assert len(audio) > 0

    def test_with_default_options(self) -> None:
        """Test generate_audio with default options."""
        service = SamTTSService()
        audio = service.generate_audio("Hello", None)
        assert isinstance(audio, bytes)

    def test_with_custom_options(self) -> None:
        """Test generate_audio with custom options."""
        service = SamTTSService()
        options = SamTTSOptions(speed=100, pitch=80)
        audio = service.generate_audio("Hello", options)
        assert isinstance(audio, bytes)

    def test_speed_affects_output(self) -> None:
        """Test that speed option affects audio length."""
        service = SamTTSService()
        slow = service.generate_audio("Test", SamTTSOptions(speed=40))
        fast = service.generate_audio("Test", SamTTSOptions(speed=120))
        assert len(slow) != len(fast)

    def test_truncates_long_text_in_log(self) -> None:
        """Test that long text is handled."""
        service = SamTTSService()
        long_text = "a" * 100
        audio = service.generate_audio(long_text)
        assert isinstance(audio, bytes)


class TestSamTTSServiceSpeakText:
    """Tests for SamTTSService.speak_text method."""

    @pytest.mark.asyncio
    async def test_speak_text_returns_audio(self) -> None:
        """Test that speak_text returns audio bytes."""
        service = SamTTSService()
        audio = await service.speak_text("Hello")
        assert isinstance(audio, bytes)
        assert len(audio) > 0

    @pytest.mark.asyncio
    async def test_speak_text_with_options(self) -> None:
        """Test speak_text with custom options."""
        service = SamTTSService()
        options = SamTTSOptions(speed=100)
        audio = await service.speak_text("Hello", options)
        assert isinstance(audio, bytes)


class TestSamTTSServiceCreateWavBuffer:
    """Tests for SamTTSService.create_wav_buffer method."""

    def test_creates_valid_wav_header(self) -> None:
        """Test that WAV buffer has valid header."""
        service = SamTTSService()
        audio = service.generate_audio("Test")
        wav = service.create_wav_buffer(audio)

        # Check WAV header
        assert wav[:4] == b"RIFF"
        assert wav[8:12] == b"WAVE"
        assert wav[12:16] == b"fmt "
        assert wav[36:40] == b"data"

    def test_wav_size_is_audio_plus_header(self) -> None:
        """Test that WAV size is audio + 44 byte header."""
        service = SamTTSService()
        audio = service.generate_audio("Test")
        wav = service.create_wav_buffer(audio)
        assert len(wav) == len(audio) + 44

    def test_custom_sample_rate(self) -> None:
        """Test WAV buffer with custom sample rate."""
        service = SamTTSService()
        audio = b"\x80" * 100  # 100 bytes of silence
        wav = service.create_wav_buffer(audio, sample_rate=44100)
        assert len(wav) == 144  # 100 + 44

    def test_empty_audio(self) -> None:
        """Test WAV buffer with empty audio."""
        service = SamTTSService()
        wav = service.create_wav_buffer(b"")
        assert len(wav) == 44  # just header
        assert wav[:4] == b"RIFF"
