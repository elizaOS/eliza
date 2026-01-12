"""Integration tests for the S3 Storage plugin."""

import os
import pytest

# Check if AWS credentials are available
HAS_AWS_CREDS = bool(
    os.environ.get("AWS_ACCESS_KEY_ID")
    and os.environ.get("AWS_SECRET_ACCESS_KEY")
    and os.environ.get("AWS_S3_BUCKET")
)


class TestS3PluginStructure:
    """Tests for plugin structure (no credentials needed)."""

    def test_import_plugin(self) -> None:
        """Test that plugin can be imported."""
        from elizaos_plugin_s3_storage import S3StoragePlugin
        assert S3StoragePlugin is not None

    def test_import_client(self) -> None:
        """Test that client can be imported."""
        from elizaos_plugin_s3_storage import S3StorageClient
        assert S3StorageClient is not None

    def test_import_types(self) -> None:
        """Test that types can be imported."""
        from elizaos_plugin_s3_storage import (
            S3StorageConfig,
            UploadResult,
            JsonUploadResult,
        )
        assert S3StorageConfig is not None
        assert UploadResult is not None
        assert JsonUploadResult is not None


class TestS3Config:
    """Tests for S3 configuration."""

    def test_config_creation(self) -> None:
        """Test config creation."""
        from elizaos_plugin_s3_storage import S3StorageConfig
        
        config = S3StorageConfig(
            access_key_id="test-key",
            secret_access_key="test-secret",
            region="us-east-1",
            bucket="test-bucket",
        )
        assert config.access_key_id == "test-key"
        assert config.bucket == "test-bucket"


class TestS3Types:
    """Tests for S3 types."""

    def test_upload_result(self) -> None:
        """Test UploadResult type."""
        from elizaos_plugin_s3_storage import UploadResult
        
        result = UploadResult(
            success=True,
            url="https://s3.amazonaws.com/bucket/file.jpg",
            key="file.jpg",
        )
        assert result.success is True
        assert "s3" in result.url

    def test_json_upload_result(self) -> None:
        """Test JsonUploadResult type."""
        from elizaos_plugin_s3_storage import JsonUploadResult
        
        result = JsonUploadResult(
            success=True,
            url="https://s3.amazonaws.com/bucket/data.json",
            key="data.json",
            data={"test": "value"},
        )
        assert result.success is True
        assert result.data == {"test": "value"}


@pytest.mark.skipif(not HAS_AWS_CREDS, reason="AWS credentials not set")
class TestS3APIIntegration:
    """Tests that require AWS credentials."""

    @pytest.mark.asyncio
    async def test_plugin_initialization(self) -> None:
        """Test plugin initialization with real credentials."""
        from elizaos_plugin_s3_storage import get_s3_storage_plugin
        
        plugin = await get_s3_storage_plugin()
        assert plugin is not None
