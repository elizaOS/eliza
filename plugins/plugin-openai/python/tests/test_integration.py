"""
Integration tests for OpenAI plugin against live API.

These tests require a valid OPENAI_API_KEY environment variable.
"""

from typing import TYPE_CHECKING

import pytest

if TYPE_CHECKING:
    from elizaos_plugin_openai import OpenAIPlugin


class TestTextGeneration:
    """Tests for text generation functionality."""

    @pytest.mark.asyncio
    async def test_generate_text_small(self, plugin: "OpenAIPlugin") -> None:
        """Test small model text generation."""
        response = await plugin.generate_text_small(
            "Say hello in exactly 3 words.",
            temperature=0.0,
        )
        assert isinstance(response, str)
        assert len(response) > 0
        # Check it's approximately 3 words
        words = response.strip().split()
        assert len(words) <= 10, f"Response too long: {response}"

    @pytest.mark.asyncio
    async def test_generate_text_large(self, plugin: "OpenAIPlugin") -> None:
        """Test large model text generation."""
        response = await plugin.generate_text_large(
            "What is 2 + 2? Answer with just the number.",
            temperature=0.0,
        )
        assert isinstance(response, str)
        assert "4" in response

    @pytest.mark.asyncio
    async def test_streaming(self, plugin: "OpenAIPlugin") -> None:
        """Test streaming text generation."""
        chunks: list[str] = []

        async for chunk in plugin.stream_text(
            "Count from 1 to 3, one number per line.",
            temperature=0.0,
        ):
            chunks.append(chunk)

        assert len(chunks) > 0, "No chunks received"
        full_text = "".join(chunks)
        assert "1" in full_text
        assert "2" in full_text
        assert "3" in full_text


class TestEmbeddings:
    """Tests for embedding functionality."""

    @pytest.mark.asyncio
    async def test_create_embedding(self, plugin: "OpenAIPlugin") -> None:
        """Test embedding generation."""
        embedding = await plugin.create_embedding("Hello, world!")

        assert isinstance(embedding, list)
        assert len(embedding) == 1536  # Default dimensions
        assert all(isinstance(x, float) for x in embedding)

    @pytest.mark.asyncio
    async def test_embedding_consistency(self, plugin: "OpenAIPlugin") -> None:
        """Test that same text produces similar embeddings."""
        text = "Test embedding consistency"

        embedding1 = await plugin.create_embedding(text)
        embedding2 = await plugin.create_embedding(text)

        # Embeddings should be very similar (not necessarily identical due to floating point)
        import math

        dot_product = sum(a * b for a, b in zip(embedding1, embedding2, strict=True))
        norm1 = math.sqrt(sum(x * x for x in embedding1))
        norm2 = math.sqrt(sum(x * x for x in embedding2))
        cosine_similarity = dot_product / (norm1 * norm2)

        assert cosine_similarity > 0.99, "Embeddings should be nearly identical"


class TestTokenization:
    """Tests for tokenization functionality."""

    def test_tokenize_detokenize_roundtrip(self, plugin: "OpenAIPlugin") -> None:
        """Test tokenization roundtrip."""
        original = "Hello, this is a test!"

        tokens = plugin.tokenize(original)
        assert isinstance(tokens, list)
        assert len(tokens) > 0
        assert all(isinstance(t, int) for t in tokens)

        decoded = plugin.detokenize(tokens)
        assert decoded == original

    def test_count_tokens(self, plugin: "OpenAIPlugin") -> None:
        """Test token counting."""
        text = "Hello world"
        count = plugin.count_tokens(text)

        assert isinstance(count, int)
        assert count > 0
        assert count < 10  # "Hello world" should be ~2-3 tokens

    def test_truncate_to_tokens(self, plugin: "OpenAIPlugin") -> None:
        """Test token-based truncation."""
        long_text = "This is a longer piece of text that should be truncated."
        truncated = plugin.truncate_to_tokens(long_text, max_tokens=5)

        # Truncated should be shorter
        truncated_tokens = plugin.count_tokens(truncated)
        assert truncated_tokens <= 5


class TestImageDescription:
    """Tests for image description functionality."""

    @pytest.mark.asyncio
    async def test_describe_image(self, plugin: "OpenAIPlugin") -> None:
        """Test image description."""
        # Use a more reliable image URL
        image_url = "https://images.unsplash.com/photo-1518791841217-8f162f1e1131?w=400"

        result = await plugin.describe_image(image_url)

        assert result.title is not None
        assert len(result.title) > 0
        assert result.description is not None
        assert len(result.description) > 0


class TestStructuredOutput:
    """Tests for structured JSON output."""

    @pytest.mark.asyncio
    async def test_generate_object(self, plugin: "OpenAIPlugin") -> None:
        """Test structured object generation."""
        result = await plugin.generate_object(
            "Return a JSON object with fields: name (string), age (number), active (boolean). "
            "Use values: name='Test', age=25, active=true"
        )

        assert isinstance(result, dict)
        assert "name" in result or "Name" in result  # Allow case variations
        assert "age" in result or "Age" in result
        assert "active" in result or "Active" in result


class TestAudio:
    """Tests for audio functionality."""

    @pytest.mark.asyncio
    async def test_text_to_speech(self, plugin: "OpenAIPlugin") -> None:
        """Test text-to-speech generation."""
        audio_data = await plugin.text_to_speech(
            "Hello, this is a test.",
        )

        assert isinstance(audio_data, bytes)
        assert len(audio_data) > 1000  # Should be at least 1KB for a short phrase
        # MP3 files can start with ID3 tag or frame sync (0xFF with high bits set)
        is_valid_mp3 = (
            audio_data[:3] == b"ID3"
            or (len(audio_data) >= 2 and audio_data[0] == 0xFF and (audio_data[1] & 0xE0) == 0xE0)
        )
        assert is_valid_mp3, "Should be valid MP3 audio data"

    @pytest.mark.asyncio
    async def test_transcription(self, plugin: "OpenAIPlugin") -> None:
        """Test audio transcription by round-tripping through TTS."""
        # Generate audio using TTS, then transcribe it back
        # This ensures we have valid audio data that OpenAI can process
        test_text = "Hello, this is a test for transcription."
        audio_data = await plugin.text_to_speech(test_text)

        transcription = await plugin.transcribe(
            audio_data,
            filename="audio.mp3",  # TTS returns MP3
        )

        assert isinstance(transcription, str)
        assert len(transcription) > 0
        # Should contain expected words from the original text
        lower = transcription.lower()
        assert "hello" in lower or "test" in lower or "transcription" in lower

