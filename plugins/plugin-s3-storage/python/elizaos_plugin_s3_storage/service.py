from __future__ import annotations

from pathlib import Path

from elizaos_plugin_s3_storage.client import JsonValue
from elizaos_plugin_s3_storage.plugin import S3StoragePlugin, get_s3_storage_plugin
from elizaos_plugin_s3_storage.types import JsonUploadResult, S3StorageConfig, UploadResult


class AwsS3Service:
    """
    Minimal service wrapper for S3 operations (TS parity: `AwsS3Service`).
    """

    service_type: str = "REMOTE_FILES"
    capability_description: str = "The agent is able to upload and download files from AWS S3"

    def __init__(self, plugin: S3StoragePlugin) -> None:
        self._plugin = plugin

    @classmethod
    def from_env(cls) -> AwsS3Service:
        return cls(get_s3_storage_plugin())

    @classmethod
    def from_config(cls, config: S3StorageConfig) -> AwsS3Service:
        plugin = S3StoragePlugin(
            access_key_id=config.access_key_id,
            secret_access_key=config.secret_access_key,
            region=config.region,
            bucket=config.bucket,
            upload_path=config.upload_path,
            endpoint=config.endpoint,
        )
        return cls(plugin)

    @property
    def plugin(self) -> S3StoragePlugin:
        return self._plugin

    async def upload_file(
        self,
        file_path: str | Path,
        *,
        sub_directory: str = "",
        use_signed_url: bool = False,
        expires_in: int = 900,
    ) -> UploadResult:
        return await self._plugin.upload_file(
            file_path,
            sub_directory=sub_directory,
            use_signed_url=use_signed_url,
            expires_in=expires_in,
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
        return await self._plugin.upload_json(
            json_data,
            file_name=file_name,
            sub_directory=sub_directory,
            use_signed_url=use_signed_url,
            expires_in=expires_in,
        )

    async def stop(self) -> None:
        await self._plugin.close()
