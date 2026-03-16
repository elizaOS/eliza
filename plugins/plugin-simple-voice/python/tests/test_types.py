"""Tests for types module."""

from eliza_plugin_simple_voice.types import (
    DEFAULT_SAM_OPTIONS,
    SPEECH_TRIGGERS,
    VOCALIZATION_PATTERNS,
    SamTTSOptions,
)


class TestSamTTSOptions:
    """Tests for SamTTSOptions dataclass."""

    def test_default_values(self) -> None:
        """Test default option values."""
        options = SamTTSOptions()
        assert options.speed == 72
        assert options.pitch == 64
        assert options.throat == 128
        assert options.mouth == 128

    def test_custom_values(self) -> None:
        """Test custom option values."""
        options = SamTTSOptions(speed=100, pitch=80, throat=150, mouth=160)
        assert options.speed == 100
        assert options.pitch == 80
        assert options.throat == 150
        assert options.mouth == 160

    def test_partial_custom_values(self) -> None:
        """Test partial custom values with defaults."""
        options = SamTTSOptions(speed=50)
        assert options.speed == 50
        assert options.pitch == 64  # default
        assert options.throat == 128  # default
        assert options.mouth == 128  # default


class TestDefaultSamOptions:
    """Tests for DEFAULT_SAM_OPTIONS constant."""

    def test_default_sam_options_values(self) -> None:
        """Test default SAM options constant."""
        assert DEFAULT_SAM_OPTIONS.speed == 72
        assert DEFAULT_SAM_OPTIONS.pitch == 64
        assert DEFAULT_SAM_OPTIONS.throat == 128
        assert DEFAULT_SAM_OPTIONS.mouth == 128


class TestSpeechTriggers:
    """Tests for SPEECH_TRIGGERS constant."""

    def test_speech_triggers_not_empty(self) -> None:
        """Test that speech triggers list is not empty."""
        assert len(SPEECH_TRIGGERS) > 0

    def test_contains_common_triggers(self) -> None:
        """Test that common triggers are included."""
        assert "say aloud" in SPEECH_TRIGGERS
        assert "speak" in SPEECH_TRIGGERS
        assert "read aloud" in SPEECH_TRIGGERS
        assert "voice" in SPEECH_TRIGGERS

    def test_contains_voice_modifiers(self) -> None:
        """Test that voice modifier triggers are included."""
        assert "higher voice" in SPEECH_TRIGGERS
        assert "lower voice" in SPEECH_TRIGGERS
        assert "robotic voice" in SPEECH_TRIGGERS

    def test_all_triggers_are_lowercase(self) -> None:
        """Test that all triggers are lowercase."""
        for trigger in SPEECH_TRIGGERS:
            assert trigger == trigger.lower()


class TestVocalizationPatterns:
    """Tests for VOCALIZATION_PATTERNS constant."""

    def test_vocalization_patterns_not_empty(self) -> None:
        """Test that vocalization patterns list is not empty."""
        assert len(VOCALIZATION_PATTERNS) > 0

    def test_contains_common_patterns(self) -> None:
        """Test that common patterns are included."""
        assert "can you say" in VOCALIZATION_PATTERNS
        assert "please say" in VOCALIZATION_PATTERNS
        assert "i want to hear" in VOCALIZATION_PATTERNS
        assert "let me hear" in VOCALIZATION_PATTERNS

    def test_all_patterns_are_lowercase(self) -> None:
        """Test that all patterns are lowercase."""
        for pattern in VOCALIZATION_PATTERNS:
            assert pattern == pattern.lower()
