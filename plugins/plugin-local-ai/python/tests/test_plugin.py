from elizaos_plugin_local_ai import (
    EmbeddingParams,
    LocalAIConfig,
    LocalAIPlugin,
    TextGenerationParams,
)


def test_plugin_initialization(config: LocalAIConfig) -> None:
    plugin = LocalAIPlugin(config)
    assert plugin is not None
    assert plugin.config == config


def test_config_defaults() -> None:
    config = LocalAIConfig()
    assert config.small_model == "DeepHermes-3-Llama-3-3B-Preview-q4.gguf"
    assert config.large_model == "DeepHermes-3-Llama-3-8B-q4.gguf"
    assert config.embedding_model == "bge-small-en-v1.5.Q4_K_M.gguf"
    assert config.embedding_dimensions == 384
    assert config.context_size == 8192


def test_text_generation_params() -> None:
    params = TextGenerationParams(
        prompt="Hello, world!",
        max_tokens=100,
        temperature=0.5,
    )
    assert params.prompt == "Hello, world!"
    assert params.max_tokens == 100
    assert params.temperature == 0.5
    assert params.use_large_model is False


def test_embedding_params() -> None:
    params = EmbeddingParams(text="Test text for embedding")
    assert params.text == "Test text for embedding"
