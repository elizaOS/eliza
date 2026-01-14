import os

from elizaos_plugin_elizacloud.types import ElizaCloudConfig


class TestElizaCloudConfig:
    """Tests for ElizaCloudConfig class."""

    def test_config_creation(self) -> None:
        config = ElizaCloudConfig(api_key="test-key")
        assert config.api_key == "test-key"

    def test_config_default_values(self) -> None:
        config = ElizaCloudConfig(api_key="test-key")
        assert config.base_url == "https://www.elizacloud.ai/api/v1"
        assert config.small_model == "gpt-5-mini"
        assert config.large_model == "gpt-5"
        assert config.embedding_model == "text-embedding-3-small"
        assert config.embedding_dimensions == 1536
        assert config.image_generation_model == "dall-e-3"
        assert config.transcription_model == "gpt-5-mini-transcribe"

    def test_config_custom_values(self) -> None:
        config = ElizaCloudConfig(
            api_key="test-key",
            base_url="https://custom.api.com",
            small_model="custom-small",
            large_model="custom-large",
            embedding_model="custom-embedding",
            embedding_dimensions=768,
        )
        assert config.base_url == "https://custom.api.com"
        assert config.small_model == "custom-small"
        assert config.large_model == "custom-large"
        assert config.embedding_model == "custom-embedding"
        assert config.embedding_dimensions == 768

    def test_config_embedding_overrides(self) -> None:
        config = ElizaCloudConfig(
            api_key="test-key",
            embedding_api_key="embedding-key",
            embedding_url="https://embedding.api.com",
        )
        assert config.embedding_api_key == "embedding-key"
        assert config.embedding_url == "https://embedding.api.com"

    def test_config_image_description_model(self) -> None:
        config = ElizaCloudConfig(
            api_key="test-key",
            image_description_model="gpt-4-vision",
        )
        assert config.image_description_model == "gpt-4-vision"


class TestElizaCloudConfigFromEnv:
    def setup_method(self) -> None:
        env_vars = [
            "ELIZACLOUD_API_KEY",
            "ELIZACLOUD_BASE_URL",
            "ELIZACLOUD_SMALL_MODEL",
            "ELIZACLOUD_LARGE_MODEL",
            "ELIZACLOUD_EMBEDDING_MODEL",
            "ELIZACLOUD_EMBEDDING_API_KEY",
            "ELIZACLOUD_EMBEDDING_URL",
        ]
        for var in env_vars:
            os.environ.pop(var, None)

    def test_config_from_env_vars(self) -> None:
        os.environ["ELIZACLOUD_API_KEY"] = "env-api-key"
        os.environ["ELIZACLOUD_BASE_URL"] = "https://env.api.com"
        os.environ["ELIZACLOUD_SMALL_MODEL"] = "env-small"

        api_key = os.environ.get("ELIZACLOUD_API_KEY", "")
        base_url = os.environ.get("ELIZACLOUD_BASE_URL", "https://www.elizacloud.ai/api/v1")
        small_model = os.environ.get("ELIZACLOUD_SMALL_MODEL", "gpt-5-mini")

        config = ElizaCloudConfig(
            api_key=api_key,
            base_url=base_url,
            small_model=small_model,
        )

        assert config.api_key == "env-api-key"
        assert config.base_url == "https://env.api.com"
        assert config.small_model == "env-small"
