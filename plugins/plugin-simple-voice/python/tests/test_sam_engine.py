"""Tests for SAM engine module."""

from eliza_plugin_simple_voice.sam_engine import (
    FORMANT_FREQUENCIES,
    PHONEME_MAP,
    SamEngine,
)


class TestFormantFrequencies:
    """Tests for FORMANT_FREQUENCIES constant."""

    def test_has_32_entries(self) -> None:
        """Test that there are 32 formant frequency entries."""
        assert len(FORMANT_FREQUENCIES) == 32

    def test_all_entries_are_tuples(self) -> None:
        """Test that all entries are 3-tuples."""
        for key, value in FORMANT_FREQUENCIES.items():
            assert isinstance(value, tuple)
            assert len(value) == 3

    def test_silence_entry(self) -> None:
        """Test that silence entry has zero frequencies."""
        assert FORMANT_FREQUENCIES[31] == (0, 0, 0)


class TestPhonemeMap:
    """Tests for PHONEME_MAP constant."""

    def test_vowels_have_two_phonemes(self) -> None:
        """Test that vowels map to two phonemes."""
        vowels = ["a", "e", "i", "o", "u"]
        for vowel in vowels:
            assert len(PHONEME_MAP[vowel]) == 2

    def test_consonants_have_one_phoneme(self) -> None:
        """Test that consonants map to one phoneme."""
        consonants = [
            "b",
            "c",
            "d",
            "f",
            "g",
            "h",
            "j",
            "k",
            "l",
            "m",
            "n",
            "p",
            "q",
            "r",
            "s",
            "t",
            "v",
            "w",
            "x",
            "y",
            "z",
        ]
        for consonant in consonants:
            assert len(PHONEME_MAP[consonant]) == 1

    def test_space_maps_to_silence(self) -> None:
        """Test that space maps to silence phoneme."""
        assert PHONEME_MAP[" "] == (31,)


class TestSamEngine:
    """Tests for SamEngine class."""

    def test_default_initialization(self) -> None:
        """Test default engine initialization."""
        engine = SamEngine()
        assert engine.speed == 72
        assert engine.pitch == 64
        assert engine.throat == 128
        assert engine.mouth == 128
        assert engine.sample_rate == 22050

    def test_custom_initialization(self) -> None:
        """Test custom engine initialization."""
        engine = SamEngine(speed=100, pitch=80, throat=150, mouth=160)
        assert engine.speed == 100
        assert engine.pitch == 80
        assert engine.throat == 150
        assert engine.mouth == 160


class TestSamEngineTextToPhonemes:
    """Tests for SamEngine.text_to_phonemes method."""

    def test_simple_word(self) -> None:
        """Test phoneme conversion for simple word."""
        engine = SamEngine()
        phonemes = engine.text_to_phonemes("hello")
        assert isinstance(phonemes, list)
        assert len(phonemes) > 0

    def test_uppercase_is_lowercased(self) -> None:
        """Test that uppercase text is converted to lowercase."""
        engine = SamEngine()
        phonemes_lower = engine.text_to_phonemes("hello")
        phonemes_upper = engine.text_to_phonemes("HELLO")
        assert phonemes_lower == phonemes_upper

    def test_punctuation_becomes_silence(self) -> None:
        """Test that punctuation becomes silence phonemes."""
        engine = SamEngine()
        phonemes = engine.text_to_phonemes("hi.")
        # Should have silence (31, 31) at the end
        assert 31 in phonemes

    def test_space_becomes_silence(self) -> None:
        """Test that spaces become silence phonemes."""
        engine = SamEngine()
        phonemes = engine.text_to_phonemes("hi there")
        assert 31 in phonemes


class TestSamEngineSynthesizePhoneme:
    """Tests for SamEngine.synthesize_phoneme method."""

    def test_returns_numpy_array(self) -> None:
        """Test that synthesize_phoneme returns numpy array."""
        import numpy as np

        engine = SamEngine()
        audio = engine.synthesize_phoneme(0, 80)
        assert isinstance(audio, np.ndarray)
        assert audio.dtype == np.float32

    def test_silence_phoneme(self) -> None:
        """Test synthesizing silence phoneme."""
        engine = SamEngine()
        audio = engine.synthesize_phoneme(31, 80)
        assert len(audio) > 0

    def test_zero_duration_returns_empty(self) -> None:
        """Test that zero duration returns empty array."""
        engine = SamEngine()
        audio = engine.synthesize_phoneme(0, 0)
        assert len(audio) == 0

    def test_speed_affects_duration(self) -> None:
        """Test that speed affects audio duration."""
        slow = SamEngine(speed=40)
        fast = SamEngine(speed=120)

        slow_audio = slow.synthesize_phoneme(0, 80)
        fast_audio = fast.synthesize_phoneme(0, 80)

        assert len(slow_audio) > len(fast_audio)


class TestSamEngineSynthesize:
    """Tests for SamEngine.synthesize method."""

    def test_returns_bytes(self) -> None:
        """Test that synthesize returns bytes."""
        engine = SamEngine()
        audio = engine.synthesize("Hello")
        assert isinstance(audio, bytes)
        assert len(audio) > 0

    def test_empty_text_returns_silence(self) -> None:
        """Test that empty text returns silence buffer."""
        engine = SamEngine()
        audio = engine.synthesize("")
        assert isinstance(audio, bytes)
        assert len(audio) == 100  # silence buffer

    def test_speed_affects_length(self) -> None:
        """Test that speed affects audio length."""
        slow = SamEngine(speed=40)
        fast = SamEngine(speed=120)

        slow_audio = slow.synthesize("Test")
        fast_audio = fast.synthesize("Test")

        assert len(slow_audio) > len(fast_audio)

    def test_pitch_affects_output(self) -> None:
        """Test that pitch affects audio output."""
        low = SamEngine(pitch=30)
        high = SamEngine(pitch=100)

        low_audio = low.synthesize("Test")
        high_audio = high.synthesize("Test")

        # Audio should be different
        assert low_audio != high_audio


class TestSamEngineBuf8:
    """Tests for SamEngine.buf8 method."""

    def test_buf8_returns_bytes(self) -> None:
        """Test that buf8 returns bytes."""
        engine = SamEngine()
        audio = engine.buf8("Hello")
        assert isinstance(audio, bytes)

    def test_buf8_same_as_synthesize(self) -> None:
        """Test that buf8 returns same result as synthesize."""
        engine = SamEngine()
        synth_audio = engine.synthesize("Hello")
        buf8_audio = engine.buf8("Hello")
        assert synth_audio == buf8_audio
