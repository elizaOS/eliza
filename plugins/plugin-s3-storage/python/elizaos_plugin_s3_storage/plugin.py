from __future__ import annotations

import os
from pathlib import Path

from elizaos_plugin_s3_storage.client import JsonValue, S3StorageClient
from elizaos_plugin_s3_storage.types import (
    JsonUploadResult,
    S3StorageConfig,
    UploadResult,
)


class S3StoragePlugin:
    def __init__(
        self,
        access_key_id: str | None = None,
        secret_access_key: str | None = None,
        region: str | None = None,
        bucket: str | None = None,
        upload_path: str = "",
        endpoint: str | None = None,
    ) -> None:
        key = access_key_id or os.environ.get("AWS_ACCESS_KEY_ID")
        secret = secret_access_key or os.environ.get("AWS_SECRET_ACCESS_KEY")
        reg = region or os.environ.get("AWS_REGION")
        bkt = bucket or os.environ.get("AWS_S3_BUCKET")

        if not all([key, secret, reg, bkt]):
            raise ValueError("AWS credentials must be provided or set in environment variables")

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
        await self._client.close()

    async def __aenter__(self) -> S3StoragePlugin:
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.close()

    async def upload_file(
        self,
        file_path: str | Path,
        *,
        sub_directory: str = "",
        use_signed_url: bool = False,
        expires_in: int = 900,
    ) -> UploadResult:
        return await self._client.upload_file(file_path, sub_directory, use_signed_url, expires_in)

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
        return await self._client.upload_bytes(
            data, file_name, content_type, sub_directory, use_signed_url, expires_in
        )

    async def upload_json(
        self,
        json_data: dict[str, JsonValue],
        *,
        file_name: str | None = None,
        sub_directory: str | None = None,
        use_signed_url: bool = False,
        expires_in: int = 900,
    ) -> JsonUploadResult:
        return await self._client.upload_json(
            json_data, file_name, sub_directory, use_signed_url, expires_in
        )

    async def generate_signed_url(self, key: str, expires_in: int = 900) -> str:
        return await self._client.generate_signed_url(key, expires_in)

    async def download_file(self, key: str, destination: str | Path) -> bool:
        return await self._client.download_file(key, destination)

    async def delete_object(self, key: str) -> bool:
        return await self._client.delete_object(key)


def create_plugin(
    access_key_id: str | None = None,
    secret_access_key: str | None = None,
    region: str | None = None,
    bucket: str | None = None,
    upload_path: str = "",
    endpoint: str | None = None,
) -> S3StoragePlugin:
    return S3StoragePlugin(
        access_key_id=access_key_id,
        secret_access_key=secret_access_key,
        region=region,
        bucket=bucket,
        upload_path=upload_path,
        endpoint=endpoint,
    )


_s3_plugin_instance: S3StoragePlugin | None = None


def get_s3_storage_plugin() -> S3StoragePlugin:
    global _s3_plugin_instance
    if _s3_plugin_instance is None:
        _s3_plugin_instance = create_plugin()
    return _s3_plugin_instance
