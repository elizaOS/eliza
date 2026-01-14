"""Integration tests for ElevenLabs TTS functionality.

These tests require a valid ELEVENLABS_API_KEY to run real API calls.
Tests will be skipped gracefully if no API key is available.
"""

import os

import pytest

from eliza_plugin_elevenlabs import ElevenLabsPlugin, ElevenLabsService
from eliza_plugin_elevenlabs.types import ElevenLabsTTSOptions, VoiceSettings


def get_api_key() -> str | None:
    """Get API key from environment."""
    return os.getenv("ELEVENLABS_API_KEY")


def skip_without_api_key() -> None:
    """Skip test if no API key is available."""
    if not get_api_key():
        pytest.skip("ELEVENLABS_API_KEY not set - skipping live API test")


class TestPluginStructure:
    """Tests for basic plugin structure."""

    def test_should_have_basic_plugin_structure(self) -> None:
        """Test that plugin has basic structure."""
        plugin = ElevenLabsPlugin()
        assert plugin.name == "elevenLabs"
        assert plugin.description is not None
        assert len(plugin.description) > 0


class TestRealTTSFunctionality:
    """Tests for real TTS API functionality."""

    @pytest.mark.asyncio
    async def test_should_convert_text_to_speech_with_real_api(self) -> None:
        """Test real TTS generation with API."""
        api_key = get_api_key()
        if not api_key:
            print("⚠️ Skipping real TTS test - no ELEVENLABS_API_KEY found")
            pytest.skip("No API key")

        test_text = "Hello, this is a test of ElevenLabs text to speech."
        print(f"🎤 Testing real TTS with text: {test_text}")

        try:
            async with ElevenLabsService(api_key=api_key) as service:
                audio_data = await service.text_to_speech_bytes(test_text)

                if not audio_data or len(audio_data) == 0:
                    raise AssertionError("No audio data received")

                print(f"✅ SUCCESS: Generated {len(audio_data)} bytes of audio")

        except Exception as e:
            error_msg = str(e)
            if "quota_exceeded" in error_msg.lower():
                print("⚠️ ElevenLabs quota exceeded - test skipped")
                pytest.skip("Quota exceeded")

            print(f"❌ TTS test failed: {error_msg}")
            raise

    @pytest.mark.asyncio
    async def test_should_stream_text_to_speech(self) -> None:
        """Test streaming TTS generation."""
        api_key = get_api_key()
        if not api_key:
            print("⚠️ Skipping streaming test - no API key")
            pytest.skip("No API key")

        test_text = "Testing streaming audio output."
        print("📡 Testing streaming TTS")

        try:
            async with ElevenLabsService(api_key=api_key) as service:
                total_bytes = 0
                data_received = False

                async for chunk in service.text_to_speech(test_text):
                    data_received = True
                    total_bytes += len(chunk)

                if not data_received or total_bytes == 0:
                    raise AssertionError("No streaming data received")

                print(f"✅ SUCCESS: Streamed {total_bytes} bytes of audio")

        except Exception as e:
            error_msg = str(e)
            if "quota_exceeded" in error_msg.lower():
                print("⚠️ Quota exceeded - test skipped")
                pytest.skip("Quota exceeded")
            raise


class TestDifferentVoices:
    """Tests for different voice options."""

    @pytest.mark.asyncio
    async def test_should_test_different_voices(self) -> None:
        """Test TTS with different voices."""
        api_key = get_api_key()
        if not api_key:
            print("⚠️ Skipping voice test - no API key")
            pytest.skip("No API key")

        voices = [
            {"id": "EXAVITQu4vr4xnSDxMaL", "name": "Bella"},
            {"id": "21m00Tcm4TlvDq8ikWAM", "name": "Rachel"},
        ]

        for voice in voices:
            print(f"🎭 Testing voice: {voice['name']} ({voice['id']})")

            try:
                async with ElevenLabsService(api_key=api_key) as service:
                    audio_data = await service.text_to_speech_bytes(
                        f"Testing voice {voice['name']}",
                        voice_id=voice["id"],
                    )

                    if not audio_data or len(audio_data) == 0:
                        raise AssertionError(f"Voice {voice['name']} returned empty data")

                    print(f"✅ Voice {voice['name']} working")

            except Exception as e:
                error_msg = str(e)
                if "quota_exceeded" in error_msg.lower():
                    print(f"⚠️ Quota exceeded for voice {voice['name']}")
                    break
                raise


class TestLongTextInput:
    """Tests for longer text input."""

    @pytest.mark.asyncio
    async def test_should_handle_longer_text_input(self) -> None:
        """Test TTS with longer text."""
        api_key = get_api_key()
        if not api_key:
            print("⚠️ Skipping long text test - no API key")
            pytest.skip("No API key")

        long_text = """
            This is a longer text to test the ElevenLabs text-to-speech functionality.
            We want to ensure that the API can handle sentences of reasonable length
            and that the audio quality remains consistent throughout the entire speech.
            This test verifies that longer inputs are processed correctly.
        """.strip()

        print(f"📝 Testing long text ({len(long_text)} characters)")

        try:
            async with ElevenLabsService(api_key=api_key) as service:
                audio_data = await service.text_to_speech_bytes(long_text)

                if len(audio_data) < 1000:
                    raise AssertionError(
                        f"Long text produced too little audio: {len(audio_data)} bytes"
                    )

                print(f"✅ Long text generated {len(audio_data)} bytes of audio")

        except Exception as e:
            error_msg = str(e)
            if "quota_exceeded" in error_msg.lower():
                print("⚠️ Quota exceeded testing long text")
                pytest.skip("Quota exceeded")
            raise


class TestCustomVoiceSettings:
    """Tests for custom voice settings."""

    @pytest.mark.asyncio
    async def test_should_test_custom_voice_settings(self) -> None:
        """Test TTS with custom voice settings."""
        api_key = get_api_key()
        if not api_key:
            print("⚠️ Skipping voice settings test - no API key")
            pytest.skip("No API key")

        print("⚙️ Testing custom voice settings")

        custom_settings = VoiceSettings(
            stability=0.3,
            similarity_boost=0.8,
            style=0.2,
            use_speaker_boost=False,
        )

        options = ElevenLabsTTSOptions(
            api_key=api_key,
            voice_settings=custom_settings,
        )

        try:
            async with ElevenLabsService(api_key=api_key, tts_options=options) as service:
                audio_data = await service.text_to_speech_bytes(
                    "Testing custom voice settings",
                    voice_settings=custom_settings,
                )

                if not audio_data or len(audio_data) == 0:
                    raise AssertionError("No audio data with custom settings")

                print("✅ Custom voice settings working")

        except Exception as e:
            error_msg = str(e)
            if "quota_exceeded" in error_msg.lower():
                print("⚠️ Quota exceeded testing voice settings")
                pytest.skip("Quota exceeded")
            raise


class TestOutputFormats:
    """Tests for different output formats."""

    @pytest.mark.asyncio
    async def test_should_support_mp3_format(self) -> None:
        """Test MP3 output format."""
        api_key = get_api_key()
        if not api_key:
            print("⚠️ Skipping format test - no API key")
            pytest.skip("No API key")

        print("🎵 Testing MP3 format")

        try:
            async with ElevenLabsService(api_key=api_key) as service:
                audio_data = await service.text_to_speech_bytes(
                    "Testing MP3 format",
                    output_format="mp3_44100_128",
                )

                if not audio_data or len(audio_data) == 0:
                    raise AssertionError("No audio data for MP3 format")

                # Check for MP3 signature (ID3 header or frame sync)
                is_id3 = audio_data[:3] == b"ID3"
                is_frame_sync = audio_data[0] == 0xFF and (audio_data[1] & 0xE0) == 0xE0
                if is_id3 or is_frame_sync:
                    print("✅ MP3 format working (valid header detected)")
                else:
                    print("✅ MP3 format working (audio data received)")

        except Exception as e:
            error_msg = str(e)
            if "quota_exceeded" in error_msg.lower():
                print("⚠️ Quota exceeded testing MP3 format")
                pytest.skip("Quota exceeded")
            raise
