"""Tests for Edge TTS service."""

import pytest

from eliza_plugin_edge_tts import EdgeTTSService
from eliza_plugin_edge_tts.services.edge_tts_service import (
    infer_extension,
    resolve_voice,
    speed_to_rate,
)
from eliza_plugin_edge_tts.types import EdgeTTSParams, EdgeTTSSettings


class TestResolveVoice:
    """Tests for voice resolution."""

    def test_preset_alloy(self) -> None:
        """Test 'alloy' preset maps to GuyNeural."""
        assert resolve_voice("alloy", "default") == "en-US-GuyNeural"

    def test_preset_echo(self) -> None:
        """Test 'echo' preset maps to ChristopherNeural."""
        assert resolve_voice("echo", "default") == "en-US-ChristopherNeural"

    def test_preset_fable(self) -> None:
        """Test 'fable' preset maps to RyanNeural."""
        assert resolve_voice("fable", "default") == "en-GB-RyanNeural"

    def test_preset_onyx(self) -> None:
        """Test 'onyx' preset maps to DavisNeural."""
        assert resolve_voice("onyx", "default") == "en-US-DavisNeural"

    def test_preset_nova(self) -> None:
        """Test 'nova' preset maps to JennyNeural."""
        assert resolve_voice("nova", "default") == "en-US-JennyNeural"

    def test_preset_shimmer(self) -> None:
        """Test 'shimmer' preset maps to AriaNeural."""
        assert resolve_voice("shimmer", "default") == "en-US-AriaNeural"

    def test_preset_case_insensitive(self) -> None:
        """Test preset names are case insensitive."""
        assert resolve_voice("ALLOY", "default") == "en-US-GuyNeural"
        assert resolve_voice("Nova", "default") == "en-US-JennyNeural"
        assert resolve_voice("SHIMMER", "default") == "en-US-AriaNeural"

    def test_direct_voice_id(self) -> None:
        """Test direct Edge TTS voice IDs pass through."""
        assert resolve_voice("en-US-MichelleNeural", "default") == "en-US-MichelleNeural"
        assert resolve_voice("de-DE-KatjaNeural", "default") == "de-DE-KatjaNeural"

    def test_none_returns_default(self) -> None:
        """Test None returns default voice."""
        assert resolve_voice(None, "en-US-MichelleNeural") == "en-US-MichelleNeural"

    def test_empty_returns_default(self) -> None:
        """Test empty string returns default voice."""
        assert resolve_voice("", "en-US-MichelleNeural") == "en-US-MichelleNeural"


class TestSpeedToRate:
    """Tests for speed to rate conversion."""

    def test_normal_speed(self) -> None:
        """Test 1.0 speed returns None."""
        assert speed_to_rate(1.0) is None

    def test_none_speed(self) -> None:
        """Test None speed returns None."""
        assert speed_to_rate(None) is None

    def test_faster_speed(self) -> None:
        """Test speed > 1.0 returns positive rate."""
        assert speed_to_rate(1.5) == "+50%"
        assert speed_to_rate(2.0) == "+100%"

    def test_slower_speed(self) -> None:
        """Test speed < 1.0 returns negative rate."""
        assert speed_to_rate(0.75) == "-25%"
        assert speed_to_rate(0.5) == "-50%"

    def test_slight_change(self) -> None:
        """Test small speed changes."""
        assert speed_to_rate(1.1) == "+10%"
        assert speed_to_rate(0.9) == "-10%"


class TestInferExtension:
    """Tests for file extension inference."""

    def test_mp3_format(self) -> None:
        """Test MP3 format detection."""
        assert infer_extension("audio-24khz-48kbitrate-mono-mp3") == ".mp3"

    def test_webm_format(self) -> None:
        """Test WebM format detection."""
        assert infer_extension("webm-24khz-16bit-mono-opus") == ".webm"

    def test_ogg_format(self) -> None:
        """Test OGG format detection."""
        assert infer_extension("ogg-24khz-16bit-mono-opus") == ".ogg"

    def test_wav_format(self) -> None:
        """Test WAV/RIFF format detection."""
        assert infer_extension("riff-24khz-16bit-mono-pcm") == ".wav"

    def test_pcm_format(self) -> None:
        """Test PCM format detection."""
        assert infer_extension("raw-24khz-16bit-mono-pcm") == ".wav"

    def test_unknown_format(self) -> None:
        """Test unknown format defaults to MP3."""
        assert infer_extension("some-unknown-format") == ".mp3"


class TestEdgeTTSServiceInit:
    """Tests for EdgeTTSService initialization."""

    def test_default_init(self) -> None:
        """Test default service initialization."""
        service = EdgeTTSService()
        assert service.settings.voice == "en-US-MichelleNeural"
        assert service.settings.lang == "en-US"

    def test_init_with_settings(self) -> None:
        """Test service initialization with custom settings."""
        settings = EdgeTTSSettings(voice="en-US-GuyNeural", rate="+10%")
        service = EdgeTTSService(settings=settings)
        assert service.settings.voice == "en-US-GuyNeural"
        assert service.settings.rate == "+10%"

    def test_init_from_env(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Test service reads settings from environment."""
        monkeypatch.setenv("EDGE_TTS_VOICE", "en-GB-RyanNeural")
        monkeypatch.setenv("EDGE_TTS_RATE", "+20%")
        monkeypatch.setenv("EDGE_TTS_PITCH", "+5Hz")
        monkeypatch.setenv("EDGE_TTS_VOLUME", "-10%")
        monkeypatch.setenv("EDGE_TTS_TIMEOUT_MS", "15000")
        service = EdgeTTSService()
        assert service.settings.voice == "en-GB-RyanNeural"
        assert service.settings.rate == "+20%"
        assert service.settings.pitch == "+5Hz"
        assert service.settings.volume == "-10%"
        assert service.settings.timeout_ms == 15000

    def test_settings_property(self) -> None:
        """Test settings property returns correct settings."""
        settings = EdgeTTSSettings(voice="en-US-AriaNeural")
        service = EdgeTTSService(settings=settings)
        assert service.settings.voice == "en-US-AriaNeural"


class TestEdgeTTSServiceValidation:
    """Tests for input validation."""

    @pytest.mark.asyncio
    async def test_empty_text_raises(self) -> None:
        """Test empty text raises ValueError."""
        service = EdgeTTSService()
        with pytest.raises(ValueError, match="empty"):
            await service.text_to_speech("")

    @pytest.mark.asyncio
    async def test_whitespace_only_raises(self) -> None:
        """Test whitespace-only text raises ValueError."""
        service = EdgeTTSService()
        with pytest.raises(ValueError, match="empty"):
            await service.text_to_speech("   ")

    @pytest.mark.asyncio
    async def test_too_long_text_raises(self) -> None:
        """Test text exceeding limit raises ValueError."""
        service = EdgeTTSService()
        long_text = "a" * 5001
        with pytest.raises(ValueError, match="5000"):
            await service.text_to_speech(long_text)


class TestEdgeTTSServiceLiveTTS:
    """Live tests for Edge TTS service (requires network).

    These tests make real requests to the Edge TTS service.
    No API key is required - Edge TTS is free.
    """

    @pytest.mark.asyncio
    async def test_basic_tts(self) -> None:
        """Test basic text-to-speech generation."""
        service = EdgeTTSService()
        try:
            audio_data = await service.text_to_speech("Hello, this is a test of Edge TTS.")
            assert isinstance(audio_data, bytes)
            assert len(audio_data) > 0
            # Check for MP3 header (ID3 tag or MPEG frame sync)
            is_id3 = audio_data[:3] == b"ID3"
            is_frame_sync = (
                len(audio_data) >= 2
                and audio_data[0] == 0xFF
                and (audio_data[1] & 0xE0) == 0xE0
            )
            assert is_id3 or is_frame_sync or len(audio_data) > 100, (
                f"Audio data doesn't look like valid MP3 (first bytes: {audio_data[:10]!r})"
            )
        except Exception as e:
            error_msg = str(e).lower()
            if "network" in error_msg or "enotfound" in error_msg or "connect" in error_msg:
                pytest.skip(f"Network unavailable: {e}")
            raise

    @pytest.mark.asyncio
    async def test_different_voices(self) -> None:
        """Test TTS with different voices."""
        voices = [
            ("en-US-MichelleNeural", "Testing Michelle voice."),
            ("en-US-GuyNeural", "Testing Guy voice."),
        ]
        service = EdgeTTSService()
        for voice_id, text in voices:
            try:
                audio_data = await service.text_to_speech(text, voice=voice_id)
                assert len(audio_data) > 0, f"Voice {voice_id} returned empty data"
            except Exception as e:
                error_msg = str(e).lower()
                if "network" in error_msg or "connect" in error_msg:
                    pytest.skip(f"Network unavailable: {e}")
                raise

    @pytest.mark.asyncio
    async def test_voice_preset(self) -> None:
        """Test TTS using OpenAI-style voice preset."""
        service = EdgeTTSService()
        try:
            audio_data = await service.text_to_speech(
                "Testing voice preset.", voice="alloy"
            )
            assert len(audio_data) > 0
        except Exception as e:
            error_msg = str(e).lower()
            if "network" in error_msg or "connect" in error_msg:
                pytest.skip(f"Network unavailable: {e}")
            raise

    @pytest.mark.asyncio
    async def test_speed_adjustment(self) -> None:
        """Test TTS with speed adjustment."""
        service = EdgeTTSService()
        try:
            audio_normal = await service.text_to_speech("Testing speed.")
            audio_fast = await service.text_to_speech("Testing speed.", speed=1.5)
            assert len(audio_normal) > 0
            assert len(audio_fast) > 0
        except Exception as e:
            error_msg = str(e).lower()
            if "network" in error_msg or "connect" in error_msg:
                pytest.skip(f"Network unavailable: {e}")
            raise

    @pytest.mark.asyncio
    async def test_rate_adjustment(self) -> None:
        """Test TTS with rate adjustment."""
        service = EdgeTTSService()
        try:
            audio_data = await service.text_to_speech(
                "Testing rate adjustment.", rate="+20%"
            )
            assert len(audio_data) > 0
        except Exception as e:
            error_msg = str(e).lower()
            if "network" in error_msg or "connect" in error_msg:
                pytest.skip(f"Network unavailable: {e}")
            raise

    @pytest.mark.asyncio
    async def test_pitch_adjustment(self) -> None:
        """Test TTS with pitch adjustment."""
        service = EdgeTTSService()
        try:
            audio_data = await service.text_to_speech(
                "Testing pitch adjustment.", pitch="+10Hz"
            )
            assert len(audio_data) > 0
        except Exception as e:
            error_msg = str(e).lower()
            if "network" in error_msg or "connect" in error_msg:
                pytest.skip(f"Network unavailable: {e}")
            raise

    @pytest.mark.asyncio
    async def test_volume_adjustment(self) -> None:
        """Test TTS with volume adjustment."""
        service = EdgeTTSService()
        try:
            audio_data = await service.text_to_speech(
                "Testing volume adjustment.", volume="+20%"
            )
            assert len(audio_data) > 0
        except Exception as e:
            error_msg = str(e).lower()
            if "network" in error_msg or "connect" in error_msg:
                pytest.skip(f"Network unavailable: {e}")
            raise

    @pytest.mark.asyncio
    async def test_with_params(self) -> None:
        """Test TTS using EdgeTTSParams object."""
        service = EdgeTTSService()
        params = EdgeTTSParams(
            text="Testing with params object.",
            voice="nova",
            speed=1.2,
        )
        try:
            audio_data = await service.text_to_speech_with_params(params)
            assert len(audio_data) > 0
        except Exception as e:
            error_msg = str(e).lower()
            if "network" in error_msg or "connect" in error_msg:
                pytest.skip(f"Network unavailable: {e}")
            raise

    @pytest.mark.asyncio
    async def test_longer_text(self) -> None:
        """Test TTS with longer text input."""
        service = EdgeTTSService()
        long_text = (
            "This is a longer text to test the Edge TTS functionality. "
            "We want to ensure that the service can handle sentences of reasonable length "
            "and that the audio quality remains consistent throughout the entire speech. "
            "This test verifies that longer inputs are processed correctly."
        )
        try:
            audio_data = await service.text_to_speech(long_text)
            assert len(audio_data) > 1000, (
                f"Long text produced too little audio: {len(audio_data)} bytes"
            )
        except Exception as e:
            error_msg = str(e).lower()
            if "network" in error_msg or "connect" in error_msg:
                pytest.skip(f"Network unavailable: {e}")
            raise
