from elizaos_plugin_elizacloud.types import (
    DetokenizeTextParams,
    ImageDescriptionParams,
    ImageGenerationParams,
    ObjectGenerationParams,
    TextEmbeddingParams,
    TextGenerationParams,
    TextToSpeechParams,
    TokenizeTextParams,
    TranscriptionParams,
)


class TestTextGenerationParams:
    def test_required_prompt(self) -> None:
        params = TextGenerationParams(prompt="Hello")
        assert params.prompt == "Hello"

    def test_temperature_range(self) -> None:
        params = TextGenerationParams(prompt="Test")
        assert params.temperature == 0.7

        params_custom = TextGenerationParams(prompt="Test", temperature=0.0)
        assert params_custom.temperature == 0.0

        params_high = TextGenerationParams(prompt="Test", temperature=2.0)
        assert params_high.temperature == 2.0

    def test_max_tokens(self) -> None:
        params = TextGenerationParams(prompt="Test", max_tokens=1000)
        assert params.max_tokens == 1000

    def test_stop_sequences(self) -> None:
        params = TextGenerationParams(prompt="Test", stop_sequences=["END", "STOP"])
        assert params.stop_sequences == ["END", "STOP"]

    def test_streaming(self) -> None:
        params = TextGenerationParams(prompt="Test", stream=True)
        assert params.stream is True

    def test_penalties(self) -> None:
        params = TextGenerationParams(
            prompt="Test",
            frequency_penalty=0.5,
            presence_penalty=0.5,
        )
        assert params.frequency_penalty == 0.5
        assert params.presence_penalty == 0.5


class TestObjectGenerationParams:
    def test_basic_params(self) -> None:
        params = ObjectGenerationParams(prompt="Generate JSON")
        assert params.prompt == "Generate JSON"
        assert params.temperature == 0.0

    def test_with_schema(self) -> None:
        schema = {
            "type": "object",
            "properties": {
                "name": {"type": "string"},
                "count": {"type": "integer"},
            },
        }
        params = ObjectGenerationParams(prompt="Generate", schema=schema)
        assert params.schema == schema


class TestTextEmbeddingParams:
    def test_single_text(self) -> None:
        params = TextEmbeddingParams(text="Hello world")
        assert params.text == "Hello world"
        assert params.texts is None

    def test_batch_texts(self) -> None:
        params = TextEmbeddingParams(texts=["Hello", "World", "Test"])
        assert params.texts == ["Hello", "World", "Test"]
        assert params.text is None

    def test_model_override(self) -> None:
        params = TextEmbeddingParams(text="Test", model="custom-embedding")
        assert params.model == "custom-embedding"


class TestImageGenerationParams:
    def test_required_prompt(self) -> None:
        params = ImageGenerationParams(prompt="A beautiful sunset")
        assert params.prompt == "A beautiful sunset"

    def test_default_values(self) -> None:
        params = ImageGenerationParams(prompt="Test")
        assert params.count == 1
        assert params.size == "1024x1024"
        assert params.quality == "standard"
        assert params.style == "vivid"

    def test_custom_values(self) -> None:
        params = ImageGenerationParams(
            prompt="Test",
            count=2,
            size="512x512",
            quality="hd",
            style="natural",
        )
        assert params.count == 2
        assert params.size == "512x512"
        assert params.quality == "hd"
        assert params.style == "natural"


class TestImageDescriptionParams:
    def test_with_url(self) -> None:
        params = ImageDescriptionParams(image_url="https://example.com/image.jpg")
        assert params.image_url == "https://example.com/image.jpg"

    def test_with_custom_prompt(self) -> None:
        params = ImageDescriptionParams(
            image_url="https://example.com/image.jpg",
            prompt="Describe in detail",
        )
        assert params.prompt == "Describe in detail"


class TestTextToSpeechParams:
    def test_required_text(self) -> None:
        params = TextToSpeechParams(text="Hello world")
        assert params.text == "Hello world"

    def test_default_format(self) -> None:
        params = TextToSpeechParams(text="Test")
        assert params.format == "mp3"

    def test_voice_and_instructions(self) -> None:
        params = TextToSpeechParams(
            text="Test",
            voice="alloy",
            instructions="Speak slowly and clearly",
        )
        assert params.voice == "alloy"
        assert params.instructions == "Speak slowly and clearly"


class TestTranscriptionParams:
    def test_required_audio(self) -> None:
        params = TranscriptionParams(audio=b"audio_bytes")
        assert params.audio == b"audio_bytes"

    def test_default_values(self) -> None:
        params = TranscriptionParams(audio=b"test")
        assert params.response_format == "text"
        assert params.mime_type == "audio/wav"

    def test_custom_values(self) -> None:
        params = TranscriptionParams(
            audio=b"test",
            language="en",
            response_format="json",
            mime_type="audio/mp3",
            timestamp_granularities=["word"],
        )
        assert params.language == "en"
        assert params.response_format == "json"
        assert params.mime_type == "audio/mp3"
        assert params.timestamp_granularities == ["word"]


class TestTokenizationParams:
    def test_tokenize_params(self) -> None:
        params = TokenizeTextParams(prompt="Hello tokenizer!")
        assert params.prompt == "Hello tokenizer!"
        assert params.model_type == "TEXT_LARGE"

    def test_tokenize_with_model_type(self) -> None:
        params = TokenizeTextParams(prompt="Test", model_type="TEXT_SMALL")
        assert params.model_type == "TEXT_SMALL"

    def test_detokenize_params(self) -> None:
        params = DetokenizeTextParams(tokens=[100, 200, 300])
        assert params.tokens == [100, 200, 300]
        assert params.model_type == "TEXT_LARGE"
