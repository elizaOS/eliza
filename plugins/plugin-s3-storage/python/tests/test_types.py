"""Tests for S3 storage types."""

import pytest

from elizaos_plugin_s3_storage.types import (
    S3StorageConfig,
    UploadResult,
    JsonUploadResult,
    get_content_type,
)


class TestS3StorageConfig:
    """Tests for S3StorageConfig."""

    def test_valid_config(self, s3_config: dict[str, str]) -> None:
        """Test creating a valid config."""
        config = S3StorageConfig(**s3_config)
        assert config.access_key_id == "test-access-key"
        assert config.bucket == "test-bucket"
        assert config.upload_path == ""

    def test_config_with_options(self) -> None:
        """Test config with optional fields."""
        config = S3StorageConfig(
            access_key_id="key",
            secret_access_key="secret",
            region="eu-west-1",
            bucket="my-bucket",
            upload_path="uploads/",
            endpoint="https://custom.endpoint.com",
            force_path_style=True,
        )
        assert config.endpoint == "https://custom.endpoint.com"
        assert config.force_path_style is True


class TestUploadResult:
    """Tests for UploadResult."""

    def test_success_result(self) -> None:
        """Test successful upload result."""
        result = UploadResult(success=True, url="https://bucket.s3.amazonaws.com/file.txt")
        assert result.success is True
        assert result.url is not None
        assert result.error is None

    def test_error_result(self) -> None:
        """Test failed upload result."""
        result = UploadResult(success=False, error="Upload failed")
        assert result.success is False
        assert result.url is None
        assert result.error == "Upload failed"


class TestContentType:
    """Tests for content type detection."""

    def test_known_extensions(self) -> None:
        """Test known file extensions."""
        assert get_content_type("image.png") == "image/png"
        assert get_content_type("document.pdf") == "application/pdf"
        assert get_content_type("data.json") == "application/json"

    def test_unknown_extension(self) -> None:
        """Test unknown file extension."""
        assert get_content_type("file.xyz") == "application/octet-stream"

    def test_no_extension(self) -> None:
        """Test file with no extension."""
        assert get_content_type("README") == "application/octet-stream"

