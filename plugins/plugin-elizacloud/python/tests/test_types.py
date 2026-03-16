from elizaos_plugin_elizacloud.types import (
    DetokenizeTextParams,
    ElizaCloudConfig,
    ImageDescriptionParams,
    ImageDescriptionResult,
    ImageGenerationParams,
    ObjectGenerationParams,
    TextEmbeddingParams,
    TextGenerationParams,
    TextToSpeechParams,
    TokenizeTextParams,
    TranscriptionParams,
)


def test_eliza_cloud_config_defaults() -> None:
    config = ElizaCloudConfig(api_key="test_key")

    assert config.api_key == "test_key"
    assert config.base_url == "https://www.elizacloud.ai/api/v1"
    assert config.small_model == "gpt-5-mini"
    assert config.large_model == "gpt-5"
    assert config.embedding_model == "text-embedding-3-small"
    assert config.embedding_dimensions == 1536
    assert config.embedding_api_key is None
    assert config.embedding_url is None
    assert config.image_generation_model == "dall-e-3"
    assert config.transcription_model == "gpt-5-mini-transcribe"


def test_text_generation_params_defaults() -> None:
    params = TextGenerationParams(prompt="Test prompt")

    assert params.prompt == "Test prompt"
    assert params.temperature == 0.7
    assert params.max_tokens == 8192
    assert params.frequency_penalty == 0.7
    assert params.presence_penalty == 0.7
    assert params.stop_sequences == []
    assert params.stream is False


def test_object_generation_params_defaults() -> None:
    params = ObjectGenerationParams(prompt="Generate a JSON object")

    assert params.prompt == "Generate a JSON object"
    assert params.temperature == 0.0
    assert params.schema is None


def test_text_embedding_params() -> None:
    single = TextEmbeddingParams(text="Hello")
    assert single.text == "Hello"
    assert single.texts is None

    batch = TextEmbeddingParams(texts=["Hello", "World"])
    assert batch.text is None
    assert batch.texts == ["Hello", "World"]


def test_image_generation_params() -> None:
    params = ImageGenerationParams(prompt="A sunset")

    assert params.prompt == "A sunset"
    assert params.count == 1
    assert params.size == "1024x1024"
    assert params.quality == "standard"
    assert params.style == "vivid"


def test_image_description_params() -> None:
    params = ImageDescriptionParams(image_url="https://example.com/image.jpg")

    assert params.image_url == "https://example.com/image.jpg"
    assert params.prompt is None

    params_with_prompt = ImageDescriptionParams(
        image_url="https://example.com/image.jpg",
        prompt="Describe this in detail",
    )
    assert params_with_prompt.prompt == "Describe this in detail"


def test_image_description_result() -> None:
    result = ImageDescriptionResult(title="Sunset", description="A beautiful sunset")

    assert result.title == "Sunset"
    assert result.description == "A beautiful sunset"


def test_text_to_speech_params() -> None:
    params = TextToSpeechParams(text="Hello world")

    assert params.text == "Hello world"
    assert params.model is None
    assert params.voice is None
    assert params.format == "mp3"
    assert params.instructions is None


def test_transcription_params() -> None:
    params = TranscriptionParams(audio=b"audio_data")

    assert params.audio == b"audio_data"
    assert params.model is None
    assert params.language is None
    assert params.response_format == "text"
    assert params.mime_type == "audio/wav"
    assert params.timestamp_granularities is None


def test_tokenize_text_params() -> None:
    """Test TokenizeTextParams."""
    params = TokenizeTextParams(prompt="Hello tokenizer!")

    assert params.prompt == "Hello tokenizer!"
    assert params.model_type == "TEXT_LARGE"

    # With small model
    small_params = TokenizeTextParams(prompt="Test", model_type="TEXT_SMALL")
    assert small_params.model_type == "TEXT_SMALL"


def test_detokenize_text_params() -> None:
    params = DetokenizeTextParams(tokens=[1, 2, 3, 4])

    assert params.tokens == [1, 2, 3, 4]
    assert params.model_type == "TEXT_LARGE"
