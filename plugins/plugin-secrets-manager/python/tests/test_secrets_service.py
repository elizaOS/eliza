"""
Integration tests for SecretsService.
"""

import pytest
from unittest.mock import Mock, AsyncMock

from elizaos_plugin_secrets_manager import (
    SecretsService,
    SecretLevel,
    SecretContext,
    PluginSecretRequirement,
    MemorySecretStorage,
    KeyManager,
    encrypt,
    decrypt,
    derive_key_from_agent_id,
    validate_secret,
)


@pytest.fixture
def mock_runtime():
    """Create a mock runtime."""
    runtime = Mock()
    runtime.agent_id = "test-agent"
    runtime.get_setting = Mock(return_value=None)
    return runtime


@pytest.fixture
async def service(mock_runtime):
    """Create and start a service."""
    svc = SecretsService(mock_runtime)
    await svc.start()
    yield svc
    await svc.stop()


class TestBasicOperations:
    """Test basic secret operations."""

    @pytest.mark.asyncio
    async def test_set_and_get_global_secret(self, service):
        """Should set and get a global secret."""
        success = await service.set_global("TEST_KEY", "test-value")
        assert success is True

        value = await service.get_global("TEST_KEY")
        assert value == "test-value"

    @pytest.mark.asyncio
    async def test_check_if_secret_exists(self, service, mock_runtime):
        """Should check if secret exists."""
        context = SecretContext(
            level=SecretLevel.GLOBAL,
            agent_id=mock_runtime.agent_id,
        )

        assert await service.exists("TEST_KEY", context) is False
        await service.set_global("TEST_KEY", "value")
        assert await service.exists("TEST_KEY", context) is True

    @pytest.mark.asyncio
    async def test_delete_secret(self, service):
        """Should delete a secret."""
        await service.set_global("TEST_KEY", "value")
        assert await service.get_global("TEST_KEY") == "value"

        context = SecretContext(
            level=SecretLevel.GLOBAL,
            agent_id="test-agent",
        )
        deleted = await service.delete("TEST_KEY", context)
        assert deleted is True
        assert await service.get_global("TEST_KEY") is None

    @pytest.mark.asyncio
    async def test_return_none_for_non_existent(self, service):
        """Should return None for non-existent secret."""
        value = await service.get_global("NON_EXISTENT")
        assert value is None


class TestMultiLevelStorage:
    """Test multi-level storage functionality."""

    @pytest.mark.asyncio
    async def test_store_at_different_levels(self, service):
        """Should store secrets at different levels independently."""
        await service.set_global("KEY", "global-value")
        await service.set_world("KEY", "world-value", "world-123")
        await service.set_user("KEY", "user-value", "user-456")

        assert await service.get_global("KEY") == "global-value"
        assert await service.get_world("KEY", "world-123") == "world-value"
        assert await service.get_user("KEY", "user-456") == "user-value"

    @pytest.mark.asyncio
    async def test_isolate_world_secrets(self, service):
        """Should isolate world secrets by world ID."""
        await service.set_world("KEY", "value-1", "world-1")
        await service.set_world("KEY", "value-2", "world-2")

        assert await service.get_world("KEY", "world-1") == "value-1"
        assert await service.get_world("KEY", "world-2") == "value-2"
        assert await service.get_world("KEY", "world-3") is None

    @pytest.mark.asyncio
    async def test_isolate_user_secrets(self, service):
        """Should isolate user secrets by user ID."""
        await service.set_user("KEY", "value-1", "user-1")
        await service.set_user("KEY", "value-2", "user-2")

        assert await service.get_user("KEY", "user-1") == "value-1"
        assert await service.get_user("KEY", "user-2") == "value-2"
        assert await service.get_user("KEY", "user-3") is None


class TestEncryption:
    """Test encryption functionality."""

    @pytest.mark.asyncio
    async def test_encrypt_decrypt_roundtrip(self, service):
        """Should encrypt and decrypt secrets correctly."""
        secret_value = "super-secret-api-key-12345"
        await service.set_global("ENCRYPTED_KEY", secret_value)

        retrieved = await service.get_global("ENCRYPTED_KEY")
        assert retrieved == secret_value

    @pytest.mark.asyncio
    async def test_special_characters(self, service):
        """Should handle special characters in secrets."""
        special_chars = "key!@#$%^&*()_+-=[]{}|;:,.<>?/~`"
        await service.set_global("SPECIAL_KEY", special_chars)
        assert await service.get_global("SPECIAL_KEY") == special_chars

    @pytest.mark.asyncio
    async def test_unicode(self, service):
        """Should handle unicode in secrets."""
        unicode = "key-日本語-émojis-🔐🔑"
        await service.set_global("UNICODE_KEY", unicode)
        assert await service.get_global("UNICODE_KEY") == unicode


class TestKeyManager:
    """Test KeyManager functionality."""

    def test_initialize_from_agent_id(self):
        """Should initialize key from agent ID."""
        manager = KeyManager()
        manager.initialize_from_agent_id("agent-123", "salt")

        assert manager.key_count == 1
        assert manager.get_key("default") is not None

    def test_encrypt_decrypt(self):
        """Should encrypt and decrypt with key manager."""
        manager = KeyManager()
        manager.initialize_from_agent_id("agent-123", "salt")

        encrypted = manager.encrypt("secret-value")
        decrypted = manager.decrypt(encrypted)
        assert decrypted == "secret-value"

    def test_multiple_keys(self):
        """Should handle multiple keys."""
        manager = KeyManager()
        manager.initialize_from_agent_id("agent-123", "salt1")
        manager.add_key("key2", derive_key_from_agent_id("agent-456", "salt2"))

        assert manager.key_count == 2
        assert manager.get_key("default") is not None
        assert manager.get_key("key2") is not None


class TestValidation:
    """Test validation functionality."""

    @pytest.mark.asyncio
    async def test_openai_validation(self):
        """Should validate OpenAI keys."""
        result = await validate_secret("OPENAI_API_KEY", "sk-abc123def456ghi789jkl", "openai")
        assert result.is_valid is True

        result = await validate_secret("OPENAI_API_KEY", "invalid", "openai")
        assert result.is_valid is False

    @pytest.mark.asyncio
    async def test_anthropic_validation(self):
        """Should validate Anthropic keys."""
        result = await validate_secret("ANTHROPIC_API_KEY", "sk-ant-abc123def456ghi789", "anthropic")
        assert result.is_valid is True

        result = await validate_secret("ANTHROPIC_API_KEY", "invalid", "anthropic")
        assert result.is_valid is False

    @pytest.mark.asyncio
    async def test_url_validation(self):
        """Should validate URLs."""
        result = await validate_secret("API_URL", "https://api.example.com", "url")
        assert result.is_valid is True

        result = await validate_secret("API_URL", "not-a-url", "url")
        assert result.is_valid is False


class TestPluginRequirements:
    """Test plugin requirements checking."""

    @pytest.mark.asyncio
    async def test_check_requirements(self, service):
        """Should check plugin requirements correctly."""
        await service.set_global("REQUIRED_KEY", "value")

        requirements = {
            "REQUIRED_KEY": PluginSecretRequirement(
                key="REQUIRED_KEY",
                description="Required key",
                required=True,
            ),
            "OPTIONAL_KEY": PluginSecretRequirement(
                key="OPTIONAL_KEY",
                description="Optional key",
                required=False,
            ),
            "MISSING_REQUIRED": PluginSecretRequirement(
                key="MISSING_REQUIRED",
                description="Missing required",
                required=True,
            ),
        }

        status = await service.check_plugin_requirements("test-plugin", requirements)
        assert status.ready is False
        assert "MISSING_REQUIRED" in status.missing_required
        assert "OPTIONAL_KEY" in status.missing_optional
        assert "REQUIRED_KEY" not in status.missing_required

    @pytest.mark.asyncio
    async def test_ready_when_all_present(self, service):
        """Should report ready when all required secrets present."""
        await service.set_global("KEY1", "value1")
        await service.set_global("KEY2", "value2")

        requirements = {
            "KEY1": PluginSecretRequirement(
                key="KEY1",
                description="Key 1",
                required=True,
            ),
            "KEY2": PluginSecretRequirement(
                key="KEY2",
                description="Key 2",
                required=True,
            ),
        }

        status = await service.check_plugin_requirements("test-plugin", requirements)
        assert status.ready is True
        assert len(status.missing_required) == 0


class TestAccessLogging:
    """Test access logging functionality."""

    @pytest.mark.asyncio
    async def test_log_access(self, service):
        """Should log access attempts."""
        await service.set_global("TEST_KEY", "value")
        await service.get_global("TEST_KEY")

        logs = service.get_access_logs()
        assert len(logs) > 0

    @pytest.mark.asyncio
    async def test_filter_logs(self, service):
        """Should filter access logs."""
        await service.set_global("KEY1", "value1")
        await service.set_global("KEY2", "value2")
        await service.get_global("KEY1")

        key1_logs = service.get_access_logs(key="KEY1")
        assert len(key1_logs) > 0
        assert all(log.secret_key == "KEY1" for log in key1_logs)
