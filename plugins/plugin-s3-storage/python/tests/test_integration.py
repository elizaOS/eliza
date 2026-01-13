import os

import pytest

# Check if boto3 is available (required for full plugin functionality)
try:
    import boto3  # noqa: F401

    HAS_BOTO3 = True
except ImportError:
    HAS_BOTO3 = False

HAS_AWS_CREDS = bool(
    os.environ.get("AWS_ACCESS_KEY_ID")
    and os.environ.get("AWS_SECRET_ACCESS_KEY")
    and os.environ.get("AWS_S3_BUCKET")
)


class TestS3PluginStructure:
    @pytest.mark.skipif(not HAS_BOTO3, reason="boto3 not installed")
    def test_import_plugin(self) -> None:
        from elizaos_plugin_s3_storage import S3StoragePlugin

        assert S3StoragePlugin is not None

    @pytest.mark.skipif(not HAS_BOTO3, reason="boto3 not installed")
    def test_import_client(self) -> None:
        from elizaos_plugin_s3_storage import S3StorageClient

        assert S3StorageClient is not None

    def test_import_types(self) -> None:
        from elizaos_plugin_s3_storage import (
            JsonUploadResult,
            S3StorageConfig,
            UploadResult,
        )

        assert S3StorageConfig is not None
        assert UploadResult is not None
        assert JsonUploadResult is not None


class TestS3Config:
    def test_config_creation(self) -> None:
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
    def test_upload_result(self) -> None:
        from elizaos_plugin_s3_storage import UploadResult

        result = UploadResult(
            success=True,
            url="https://s3.amazonaws.com/bucket/file.jpg",
            key="file.jpg",
        )
        assert result.success is True
        assert "s3" in result.url

    def test_json_upload_result(self) -> None:
        from elizaos_plugin_s3_storage import JsonUploadResult

        result = JsonUploadResult(
            success=True,
            url="https://s3.amazonaws.com/bucket/data.json",
            key="data.json",
        )
        assert result.success is True
        assert result.key == "data.json"


@pytest.mark.skipif(
    not HAS_BOTO3 or not HAS_AWS_CREDS,
    reason="boto3 not installed or AWS credentials not set",
)
class TestS3APIIntegration:
    @pytest.mark.asyncio
    async def test_plugin_initialization(self) -> None:
        from elizaos_plugin_s3_storage import get_s3_storage_plugin

        plugin = get_s3_storage_plugin()
        assert plugin is not None
