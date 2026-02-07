"""
Real tests for S3StorageClient and AwsS3Service with mocked boto3.

Tests upload_file, upload_bytes, upload_json, download_file, delete_object,
generate_signed_url, and error handling.
"""

from __future__ import annotations

import json
from functools import partial
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError

from elizaos_plugin_s3_storage.client import S3StorageClient, S3StorageError
from elizaos_plugin_s3_storage.service import AwsS3Service
from elizaos_plugin_s3_storage.types import (
    S3StorageConfig,
    UploadResult,
    JsonUploadResult,
    get_content_type,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def s3_config() -> S3StorageConfig:
    return S3StorageConfig(
        access_key_id="AKID-test",
        secret_access_key="secret-test",
        region="us-east-1",
        bucket="test-bucket",
        upload_path="uploads/",
    )


@pytest.fixture
def mock_boto_client() -> MagicMock:
    """A pre-configured mock boto3 S3 client."""
    client = MagicMock()
    client.put_object.return_value = {}
    client.get_object.return_value = {
        "Body": MagicMock(read=MagicMock(return_value=b"downloaded-bytes")),
    }
    client.delete_object.return_value = {}
    client.generate_presigned_url.return_value = (
        "https://signed.example.com/presigned-object"
    )
    client.close = MagicMock()
    return client


# ---------------------------------------------------------------------------
# S3StorageClient – upload_bytes
# ---------------------------------------------------------------------------


class TestUploadBytes:
    @pytest.mark.asyncio
    async def test_success(
        self, s3_config: S3StorageConfig, mock_boto_client: MagicMock
    ) -> None:
        with patch("elizaos_plugin_s3_storage.client.boto3") as m_boto:
            m_boto.client.return_value = mock_boto_client
            client = S3StorageClient(s3_config)

            result = await client.upload_bytes(
                data=b"hello world",
                file_name="greeting.txt",
                content_type="text/plain",
            )

        assert result.success is True
        assert result.url is not None
        assert "test-bucket" in result.url
        mock_boto_client.put_object.assert_called_once()
        call_kw = mock_boto_client.put_object.call_args
        assert call_kw.kwargs["Bucket"] == "test-bucket"
        assert call_kw.kwargs["Body"] == b"hello world"
        assert call_kw.kwargs["ContentType"] == "text/plain"

    @pytest.mark.asyncio
    async def test_with_subdirectory(
        self, s3_config: S3StorageConfig, mock_boto_client: MagicMock
    ) -> None:
        with patch("elizaos_plugin_s3_storage.client.boto3") as m_boto:
            m_boto.client.return_value = mock_boto_client
            client = S3StorageClient(s3_config)

            result = await client.upload_bytes(
                data=b"\x89PNG",
                file_name="image.png",
                content_type="image/png",
                sub_directory="avatars",
            )

        assert result.success is True
        assert result.url is not None

    @pytest.mark.asyncio
    async def test_boto_error(
        self, s3_config: S3StorageConfig, mock_boto_client: MagicMock
    ) -> None:
        mock_boto_client.put_object.side_effect = ClientError(
            {"Error": {"Code": "500", "Message": "Internal error"}},
            "PutObject",
        )
        with patch("elizaos_plugin_s3_storage.client.boto3") as m_boto:
            m_boto.client.return_value = mock_boto_client
            client = S3StorageClient(s3_config)

            result = await client.upload_bytes(b"data", "f.bin", "application/octet-stream")

        assert result.success is False
        assert result.error is not None
        assert "Internal error" in result.error or "PutObject" in result.error


# ---------------------------------------------------------------------------
# S3StorageClient – upload_json
# ---------------------------------------------------------------------------


class TestUploadJson:
    @pytest.mark.asyncio
    async def test_success(
        self, s3_config: S3StorageConfig, mock_boto_client: MagicMock
    ) -> None:
        with patch("elizaos_plugin_s3_storage.client.boto3") as m_boto:
            m_boto.client.return_value = mock_boto_client
            client = S3StorageClient(s3_config)

            result = await client.upload_json(
                {"name": "test", "value": 42}, file_name="data.json"
            )

        assert result.success is True
        assert result.url is not None
        assert result.key is not None
        assert result.key.endswith("data.json")
        call_kw = mock_boto_client.put_object.call_args
        assert call_kw.kwargs["ContentType"] == "application/json"
        body = call_kw.kwargs["Body"]
        parsed = json.loads(body if isinstance(body, str) else body.decode("utf-8"))
        assert parsed["name"] == "test"
        assert parsed["value"] == 42

    @pytest.mark.asyncio
    async def test_empty_data_returns_error(
        self, s3_config: S3StorageConfig, mock_boto_client: MagicMock
    ) -> None:
        with patch("elizaos_plugin_s3_storage.client.boto3") as m_boto:
            m_boto.client.return_value = mock_boto_client
            client = S3StorageClient(s3_config)

            result = await client.upload_json({})

        assert result.success is False
        assert result.error == "JSON data is required"

    @pytest.mark.asyncio
    async def test_auto_generates_filename(
        self, s3_config: S3StorageConfig, mock_boto_client: MagicMock
    ) -> None:
        with patch("elizaos_plugin_s3_storage.client.boto3") as m_boto:
            m_boto.client.return_value = mock_boto_client
            client = S3StorageClient(s3_config)

            result = await client.upload_json({"key": "val"})

        assert result.success is True
        assert result.key is not None
        assert result.key.endswith(".json")

    @pytest.mark.asyncio
    async def test_with_subdirectory(
        self, s3_config: S3StorageConfig, mock_boto_client: MagicMock
    ) -> None:
        with patch("elizaos_plugin_s3_storage.client.boto3") as m_boto:
            m_boto.client.return_value = mock_boto_client
            client = S3StorageClient(s3_config)

            result = await client.upload_json(
                {"a": 1}, file_name="out.json", sub_directory="reports"
            )

        assert result.success is True
        assert "reports" in (result.key or "")


# ---------------------------------------------------------------------------
# S3StorageClient – upload_file
# ---------------------------------------------------------------------------


class TestUploadFile:
    @pytest.mark.asyncio
    async def test_nonexistent_file(
        self, s3_config: S3StorageConfig, mock_boto_client: MagicMock
    ) -> None:
        with patch("elizaos_plugin_s3_storage.client.boto3") as m_boto:
            m_boto.client.return_value = mock_boto_client
            client = S3StorageClient(s3_config)

            result = await client.upload_file("/nonexistent/path/file.txt")

        assert result.success is False
        assert result.error == "File does not exist"

    @pytest.mark.asyncio
    async def test_success_with_real_temp_file(
        self, s3_config: S3StorageConfig, mock_boto_client: MagicMock, tmp_path: Path
    ) -> None:
        test_file = tmp_path / "upload_me.txt"
        test_file.write_text("hello from test")

        with patch("elizaos_plugin_s3_storage.client.boto3") as m_boto:
            m_boto.client.return_value = mock_boto_client
            client = S3StorageClient(s3_config)

            result = await client.upload_file(str(test_file))

        assert result.success is True
        assert result.url is not None
        mock_boto_client.put_object.assert_called_once()


# ---------------------------------------------------------------------------
# S3StorageClient – download_file
# ---------------------------------------------------------------------------


class TestDownloadFile:
    @pytest.mark.asyncio
    async def test_success(
        self, s3_config: S3StorageConfig, mock_boto_client: MagicMock, tmp_path: Path
    ) -> None:
        with patch("elizaos_plugin_s3_storage.client.boto3") as m_boto:
            m_boto.client.return_value = mock_boto_client
            client = S3StorageClient(s3_config)

            dest = tmp_path / "downloaded.bin"
            ok = await client.download_file("uploads/file.bin", str(dest))

        assert ok is True

    @pytest.mark.asyncio
    async def test_boto_error_raises(
        self, s3_config: S3StorageConfig, mock_boto_client: MagicMock, tmp_path: Path
    ) -> None:
        mock_boto_client.get_object.side_effect = ClientError(
            {"Error": {"Code": "404", "Message": "Not Found"}},
            "GetObject",
        )

        with patch("elizaos_plugin_s3_storage.client.boto3") as m_boto:
            m_boto.client.return_value = mock_boto_client
            client = S3StorageClient(s3_config)

            with pytest.raises(S3StorageError, match="Failed to download"):
                await client.download_file("missing.bin", str(tmp_path / "out"))


# ---------------------------------------------------------------------------
# S3StorageClient – delete_object
# ---------------------------------------------------------------------------


class TestDeleteObject:
    @pytest.mark.asyncio
    async def test_success(
        self, s3_config: S3StorageConfig, mock_boto_client: MagicMock
    ) -> None:
        with patch("elizaos_plugin_s3_storage.client.boto3") as m_boto:
            m_boto.client.return_value = mock_boto_client
            client = S3StorageClient(s3_config)

            result = await client.delete_object("uploads/old.txt")

        assert result is True
        mock_boto_client.delete_object.assert_called_once()

    @pytest.mark.asyncio
    async def test_error_raises(
        self, s3_config: S3StorageConfig, mock_boto_client: MagicMock
    ) -> None:
        mock_boto_client.delete_object.side_effect = ClientError(
            {"Error": {"Code": "403", "Message": "Access Denied"}},
            "DeleteObject",
        )

        with patch("elizaos_plugin_s3_storage.client.boto3") as m_boto:
            m_boto.client.return_value = mock_boto_client
            client = S3StorageClient(s3_config)

            with pytest.raises(S3StorageError, match="Failed to delete"):
                await client.delete_object("protected/file.txt")


# ---------------------------------------------------------------------------
# S3StorageClient – generate_signed_url
# ---------------------------------------------------------------------------


class TestGenerateSignedUrl:
    @pytest.mark.asyncio
    async def test_success(
        self, s3_config: S3StorageConfig, mock_boto_client: MagicMock
    ) -> None:
        with patch("elizaos_plugin_s3_storage.client.boto3") as m_boto:
            m_boto.client.return_value = mock_boto_client
            client = S3StorageClient(s3_config)

            url = await client.generate_signed_url("uploads/secret.pdf", 7200)

        assert url == "https://signed.example.com/presigned-object"
        mock_boto_client.generate_presigned_url.assert_called_once()

    @pytest.mark.asyncio
    async def test_error_raises(
        self, s3_config: S3StorageConfig, mock_boto_client: MagicMock
    ) -> None:
        mock_boto_client.generate_presigned_url.side_effect = ClientError(
            {"Error": {"Code": "403", "Message": "Forbidden"}},
            "GetObject",
        )

        with patch("elizaos_plugin_s3_storage.client.boto3") as m_boto:
            m_boto.client.return_value = mock_boto_client
            client = S3StorageClient(s3_config)

            with pytest.raises(S3StorageError, match="Failed to generate"):
                await client.generate_signed_url("file.txt")


# ---------------------------------------------------------------------------
# S3StorageClient – URL construction
# ---------------------------------------------------------------------------


class TestUrlConstruction:
    @pytest.mark.asyncio
    async def test_public_url_without_endpoint(
        self, s3_config: S3StorageConfig, mock_boto_client: MagicMock
    ) -> None:
        with patch("elizaos_plugin_s3_storage.client.boto3") as m_boto:
            m_boto.client.return_value = mock_boto_client
            client = S3StorageClient(s3_config)

            result = await client.upload_bytes(b"x", "f.bin", "application/octet-stream")

        assert result.success is True
        assert "test-bucket.s3.us-east-1.amazonaws.com" in result.url

    @pytest.mark.asyncio
    async def test_public_url_with_custom_endpoint(
        self, mock_boto_client: MagicMock
    ) -> None:
        config = S3StorageConfig(
            access_key_id="key",
            secret_access_key="secret",
            region="us-east-1",
            bucket="custom-bucket",
            upload_path="",
            endpoint="https://minio.local:9000",
        )

        with patch("elizaos_plugin_s3_storage.client.boto3") as m_boto:
            m_boto.client.return_value = mock_boto_client
            client = S3StorageClient(config)

            result = await client.upload_bytes(b"x", "f.bin", "application/octet-stream")

        assert result.success is True
        assert "minio.local:9000" in result.url
        assert "custom-bucket" in result.url


# ---------------------------------------------------------------------------
# get_content_type
# ---------------------------------------------------------------------------


class TestGetContentType:
    def test_png(self) -> None:
        assert get_content_type("image.png") == "image/png"

    def test_jpeg_both_extensions(self) -> None:
        assert get_content_type("photo.jpg") == "image/jpeg"
        assert get_content_type("photo.jpeg") == "image/jpeg"

    def test_gif(self) -> None:
        assert get_content_type("anim.gif") == "image/gif"

    def test_webp(self) -> None:
        assert get_content_type("pic.webp") == "image/webp"

    def test_pdf(self) -> None:
        assert get_content_type("doc.pdf") == "application/pdf"

    def test_json(self) -> None:
        assert get_content_type("data.json") == "application/json"

    def test_text(self) -> None:
        assert get_content_type("readme.txt") == "text/plain"

    def test_html(self) -> None:
        assert get_content_type("page.html") == "text/html"

    def test_css(self) -> None:
        assert get_content_type("style.css") == "text/css"

    def test_js(self) -> None:
        assert get_content_type("app.js") == "application/javascript"

    def test_mp3(self) -> None:
        assert get_content_type("song.mp3") == "audio/mpeg"

    def test_mp4(self) -> None:
        assert get_content_type("video.mp4") == "video/mp4"

    def test_wav(self) -> None:
        assert get_content_type("audio.wav") == "audio/wav"

    def test_webm(self) -> None:
        assert get_content_type("clip.webm") == "video/webm"

    def test_unknown(self) -> None:
        assert get_content_type("file.xyz") == "application/octet-stream"

    def test_no_extension(self) -> None:
        assert get_content_type("Makefile") == "application/octet-stream"


# ---------------------------------------------------------------------------
# S3StorageConfig validation (via pydantic)
# ---------------------------------------------------------------------------


class TestS3StorageConfig:
    def test_valid_config(self) -> None:
        config = S3StorageConfig(
            access_key_id="AKID",
            secret_access_key="secret",
            region="us-west-2",
            bucket="bkt",
        )
        assert config.access_key_id == "AKID"
        assert config.upload_path == ""
        assert config.endpoint is None
        assert config.ssl_enabled is True
        assert config.force_path_style is False

    def test_config_with_all_options(self) -> None:
        config = S3StorageConfig(
            access_key_id="AKID",
            secret_access_key="secret",
            region="eu-central-1",
            bucket="my-bucket",
            upload_path="data/",
            endpoint="https://minio:9000",
            ssl_enabled=False,
            force_path_style=True,
        )
        assert config.endpoint == "https://minio:9000"
        assert config.ssl_enabled is False
        assert config.force_path_style is True

    def test_config_rejects_empty_required_fields(self) -> None:
        with pytest.raises(Exception):
            S3StorageConfig(
                access_key_id="",
                secret_access_key="s",
                region="r",
                bucket="b",
            )


# ---------------------------------------------------------------------------
# UploadResult / JsonUploadResult models
# ---------------------------------------------------------------------------


class TestResultModels:
    def test_upload_result_success(self) -> None:
        r = UploadResult(success=True, url="https://s3.example.com/f.txt")
        assert r.success is True
        assert r.url is not None
        assert r.error is None

    def test_upload_result_failure(self) -> None:
        r = UploadResult(success=False, error="boom")
        assert r.success is False
        assert r.url is None
        assert r.error == "boom"

    def test_json_upload_result_success(self) -> None:
        r = JsonUploadResult(
            success=True,
            url="https://s3.example.com/data.json",
            key="uploads/data.json",
        )
        assert r.key == "uploads/data.json"
        assert r.success is True

    def test_json_upload_result_failure(self) -> None:
        r = JsonUploadResult(success=False, error="missing data")
        assert r.key is None
        assert r.error == "missing data"


# ---------------------------------------------------------------------------
# AwsS3Service (thin wrapper)
# ---------------------------------------------------------------------------


class TestAwsS3Service:
    def test_service_type(self) -> None:
        assert AwsS3Service.service_type == "REMOTE_FILES"

    def test_capability_description(self) -> None:
        assert "S3" in AwsS3Service.capability_description

    @pytest.mark.asyncio
    async def test_from_config_and_upload_json(
        self, s3_config: S3StorageConfig, mock_boto_client: MagicMock
    ) -> None:
        with patch("elizaos_plugin_s3_storage.client.boto3") as m_boto:
            m_boto.client.return_value = mock_boto_client
            service = AwsS3Service.from_config(s3_config)

            result = await service.upload_json(
                {"metric": "latency", "value_ms": 42},
                file_name="metrics.json",
            )

        assert result.success is True
        assert result.key is not None

    @pytest.mark.asyncio
    async def test_from_config_and_upload_file_nonexistent(
        self, s3_config: S3StorageConfig, mock_boto_client: MagicMock
    ) -> None:
        with patch("elizaos_plugin_s3_storage.client.boto3") as m_boto:
            m_boto.client.return_value = mock_boto_client
            service = AwsS3Service.from_config(s3_config)

            result = await service.upload_file("/does/not/exist.bin")

        assert result.success is False
        assert result.error == "File does not exist"

    @pytest.mark.asyncio
    async def test_stop(
        self, s3_config: S3StorageConfig, mock_boto_client: MagicMock
    ) -> None:
        with patch("elizaos_plugin_s3_storage.client.boto3") as m_boto:
            m_boto.client.return_value = mock_boto_client
            service = AwsS3Service.from_config(s3_config)

            # Force client creation
            await service.upload_json({"k": "v"}, file_name="t.json")

            await service.stop()

        mock_boto_client.close.assert_called_once()


# ---------------------------------------------------------------------------
# S3StorageError
# ---------------------------------------------------------------------------


class TestS3StorageError:
    def test_message(self) -> None:
        err = S3StorageError("something went wrong")
        assert str(err) == "something went wrong"
        assert err.cause is None

    def test_with_cause(self) -> None:
        cause = ValueError("root cause")
        err = S3StorageError("wrapper", cause=cause)
        assert err.cause is cause
        assert "wrapper" in str(err)
