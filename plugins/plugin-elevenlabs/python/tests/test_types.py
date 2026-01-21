"""Tests for ElevenLabs plugin types."""

from eliza_plugin_elevenlabs.types import (
    DEFAULT_STT_OPTIONS,
    DEFAULT_TTS_OPTIONS,
    STT_MODELS,
    TTS_MODELS,
    TTS_OUTPUT_FORMATS,
    ElevenLabsSTTOptions,
    ElevenLabsTTSOptions,
    TranscriptionSettings,
    VoiceSettings,
)


class TestVoiceSettings:
    """Tests for VoiceSettings dataclass."""

    def test_default_values(self) -> None:
        """Test default voice settings values."""
        settings = VoiceSettings()
        assert settings.stability == 0.5
        assert settings.similarity_boost == 0.75
        assert settings.style == 0.0
        assert settings.use_speaker_boost is True

    def test_custom_values(self) -> None:
        """Test custom voice settings values."""
        settings = VoiceSettings(
            stability=0.8,
            similarity_boost=0.9,
            style=0.5,
            use_speaker_boost=False,
        )
        assert settings.stability == 0.8
        assert settings.similarity_boost == 0.9
        assert settings.style == 0.5
        assert settings.use_speaker_boost is False

    def test_stability_range(self) -> None:
        """Test stability accepts values in valid range."""
        for value in [0.0, 0.5, 1.0]:
            settings = VoiceSettings(stability=value)
            assert settings.stability == value


class TestTranscriptionSettings:
    """Tests for TranscriptionSettings dataclass."""

    def test_default_values(self) -> None:
        """Test default transcription settings values."""
        settings = TranscriptionSettings()
        assert settings.timestamps_granularity == "word"
        assert settings.diarize is False
        assert settings.num_speakers is None
        assert settings.tag_audio_events is False

    def test_custom_values(self) -> None:
        """Test custom transcription settings values."""
        settings = TranscriptionSettings(
            timestamps_granularity="character",
            diarize=True,
            num_speakers=3,
            tag_audio_events=True,
        )
        assert settings.timestamps_granularity == "character"
        assert settings.diarize is True
        assert settings.num_speakers == 3
        assert settings.tag_audio_events is True


class TestElevenLabsTTSOptions:
    """Tests for ElevenLabsTTSOptions dataclass."""

    def test_default_values(self) -> None:
        """Test default TTS options values."""
        options = ElevenLabsTTSOptions()
        assert options.api_key == ""
        assert options.voice_id == "EXAVITQu4vr4xnSDxMaL"
        assert options.model_id == "eleven_monolingual_v1"
        assert options.output_format == "mp3_44100_128"
        assert options.optimize_streaming_latency == 0
        assert isinstance(options.voice_settings, VoiceSettings)

    def test_custom_api_key(self) -> None:
        """Test custom API key."""
        options = ElevenLabsTTSOptions(api_key="my-api-key")
        assert options.api_key == "my-api-key"


class TestElevenLabsSTTOptions:
    """Tests for ElevenLabsSTTOptions dataclass."""

    def test_default_values(self) -> None:
        """Test default STT options values."""
        options = ElevenLabsSTTOptions()
        assert options.api_key == ""
        assert options.model_id == "scribe_v1"
        assert options.language_code is None
        assert isinstance(options.transcription_settings, TranscriptionSettings)


class TestDefaultOptions:
    """Tests for default option constants."""

    def test_default_tts_options(self) -> None:
        """Test DEFAULT_TTS_OPTIONS is properly configured."""
        assert DEFAULT_TTS_OPTIONS.voice_id == "EXAVITQu4vr4xnSDxMaL"
        assert DEFAULT_TTS_OPTIONS.model_id == "eleven_monolingual_v1"

    def test_default_stt_options(self) -> None:
        """Test DEFAULT_STT_OPTIONS is properly configured."""
        assert DEFAULT_STT_OPTIONS.model_id == "scribe_v1"


class TestSupportedFormats:
    """Tests for supported formats and models."""

    def test_tts_output_formats(self) -> None:
        """Test TTS output formats list."""
        assert "mp3_44100_128" in TTS_OUTPUT_FORMATS
        assert "pcm_16000" in TTS_OUTPUT_FORMATS
        assert len(TTS_OUTPUT_FORMATS) > 0

    def test_stt_models(self) -> None:
        """Test STT models list."""
        assert "scribe_v1" in STT_MODELS

    def test_tts_models(self) -> None:
        """Test TTS models list."""
        assert "eleven_monolingual_v1" in TTS_MODELS
        assert "eleven_multilingual_v2" in TTS_MODELS
