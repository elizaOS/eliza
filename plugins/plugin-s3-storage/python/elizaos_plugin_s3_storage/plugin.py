"""
S3 Storage Plugin for elizaOS.

Provides a high-level interface to S3 storage operations.
"""

from __future__ import annotations

import os
from pathlib import Path

from elizaos_plugin_s3_storage.client import S3StorageClient, create_client_from_env
from elizaos_plugin_s3_storage.types import (
    JsonUploadResult,
    S3StorageConfig,
    UploadResult,
)


class S3StoragePlugin:
    """
    High-level S3 storage plugin for elizaOS.

    Provides convenient methods for S3 storage operations.
    """

    def __init__(
        self,
        access_key_id: str | None = None,
        secret_access_key: str | None = None,
        region: str | None = None,
        bucket: str | None = None,
        upload_path: str = "",
        endpoint: str | None = None,
    ) -> None:
        """
        Initialize the S3 storage plugin.

        Args:
            access_key_id: AWS access key ID (defaults to AWS_ACCESS_KEY_ID env var).
            secret_access_key: AWS secret access key (defaults to AWS_SECRET_ACCESS_KEY env var).
            region: AWS region (defaults to AWS_REGION env var).
            bucket: S3 bucket name (defaults to AWS_S3_BUCKET env var).
            upload_path: Optional upload path prefix.
            endpoint: Optional custom S3 endpoint.

        Raises:
            ValueError: If required credentials are not provided.
        """
        key = access_key_id or os.environ.get("AWS_ACCESS_KEY_ID")
        secret = secret_access_key or os.environ.get("AWS_SECRET_ACCESS_KEY")
        reg = region or os.environ.get("AWS_REGION")
        bkt = bucket or os.environ.get("AWS_S3_BUCKET")

        if not all([key, secret, reg, bkt]):
            raise ValueError(
                "AWS credentials must be provided or set in environment variables"
            )

        self._config = S3StorageConfig(
            access_key_id=key,  # type: ignore[arg-type]
            secret_access_key=secret,  # type: ignore[arg-type]
            region=reg,  # type: ignore[arg-type]
            bucket=bkt,  # type: ignore[arg-type]
            upload_path=upload_path,
            endpoint=endpoint,
        )
        self._client = S3StorageClient(self._config)

    async def close(self) -> None:
        """Close the plugin and release resources."""
        await self._client.close()

    async def __aenter__(self) -> "S3StoragePlugin":
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.close()

    # =========================================================================
    # File Operations
    # =========================================================================

    async def upload_file(
        self,
        file_path: str | Path,
        *,
        sub_directory: str = "",
        use_signed_url: bool = False,
        expires_in: int = 900,
    ) -> UploadResult:
        """
        Upload a file to S3.

        Args:
            file_path: Path to the file to upload.
            sub_directory: Optional subdirectory within the bucket.
            use_signed_url: Whether to return a signed URL.
            expires_in: Expiration time for signed URL in seconds.

        Returns:
            UploadResult with success status and URL.
        """
        return await self._client.upload_file(
            file_path, sub_directory, use_signed_url, expires_in
        )

    async def upload_bytes(
        self,
        data: bytes,
        file_name: str,
        content_type: str,
        *,
        sub_directory: str = "",
        use_signed_url: bool = False,
        expires_in: int = 900,
    ) -> UploadResult:
        """
        Upload bytes to S3.

        Args:
            data: The bytes to upload.
            file_name: Name for the file.
            content_type: MIME type of the content.
            sub_directory: Optional subdirectory.
            use_signed_url: Whether to return a signed URL.
            expires_in: Expiration time for signed URL.

        Returns:
            UploadResult with success status and URL.
        """
        return await self._client.upload_bytes(
            data, file_name, content_type, sub_directory, use_signed_url, expires_in
        )

    async def upload_json(
        self,
        json_data: dict[str, object],
        *,
        file_name: str | None = None,
        sub_directory: str | None = None,
        use_signed_url: bool = False,
        expires_in: int = 900,
    ) -> JsonUploadResult:
        """
        Upload JSON data to S3.

        Args:
            json_data: Dictionary to upload as JSON.
            file_name: Optional filename (defaults to timestamp.json).
            sub_directory: Optional subdirectory.
            use_signed_url: Whether to return a signed URL.
            expires_in: Expiration time for signed URL.

        Returns:
            JsonUploadResult with success status, URL, and key.
        """
        return await self._client.upload_json(
            json_data, file_name, sub_directory, use_signed_url, expires_in
        )

    async def generate_signed_url(self, key: str, expires_in: int = 900) -> str:
        """
        Generate a signed URL for an existing object.

        Args:
            key: The object key.
            expires_in: URL expiration time in seconds.

        Returns:
            Signed URL for the object.
        """
        return await self._client.generate_signed_url(key, expires_in)

    async def download_file(self, key: str, destination: str | Path) -> bool:
        """
        Download a file from S3.

        Args:
            key: The object key.
            destination: Path to save the file.

        Returns:
            True if download was successful.
        """
        return await self._client.download_file(key, destination)

    async def delete_object(self, key: str) -> bool:
        """
        Delete an object from S3.

        Args:
            key: The object key to delete.

        Returns:
            True if deletion was successful.
        """
        return await self._client.delete_object(key)


# Convenience function to create plugin
def create_plugin(
    access_key_id: str | None = None,
    **kwargs: object,
) -> S3StoragePlugin:
    """
    Create an S3 storage plugin instance.

    Args:
        access_key_id: AWS access key ID (defaults to AWS_ACCESS_KEY_ID env var).
        **kwargs: Additional configuration options.

    Returns:
        Configured S3StoragePlugin instance.
    """
    return S3StoragePlugin(access_key_id=access_key_id, **kwargs)  # type: ignore[arg-type]


# Lazy plugin singleton
_s3_plugin_instance: S3StoragePlugin | None = None


def get_s3_storage_plugin() -> S3StoragePlugin:
    """Get the singleton S3 storage plugin instance."""
    global _s3_plugin_instance
    if _s3_plugin_instance is None:
        _s3_plugin_instance = create_plugin()
    return _s3_plugin_instance


