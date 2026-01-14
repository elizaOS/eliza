from __future__ import annotations

import asyncio
import json
import os
from datetime import datetime
from functools import partial
from pathlib import Path
from typing import TYPE_CHECKING

import aiofiles
import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError

from elizaos_plugin_s3_storage.types import (
    JsonUploadResult,
    S3StorageConfig,
    UploadResult,
    get_content_type,
)

if TYPE_CHECKING:
    from mypy_boto3_s3 import S3Client

JsonValue = str | int | float | bool | None | dict[str, "JsonValue"] | list["JsonValue"]


class S3StorageError(Exception):
    def __init__(self, message: str, cause: Exception | None = None) -> None:
        super().__init__(message)
        self.cause = cause


class S3StorageClient:
    def __init__(self, config: S3StorageConfig) -> None:
        self._config = config
        self._client: S3Client | None = None
        self._loop = asyncio.get_event_loop()

    def _get_client(self) -> S3Client:
        if self._client is None:
            boto_config = Config(
                signature_version="s3v4",
                s3={"addressing_style": "path" if self._config.force_path_style else "virtual"},
            )

            client_kwargs: dict[str, str | Config | bool] = {
                "aws_access_key_id": self._config.access_key_id,
                "aws_secret_access_key": self._config.secret_access_key,
                "region_name": self._config.region,
                "config": boto_config,
            }

            if self._config.endpoint:
                client_kwargs["endpoint_url"] = self._config.endpoint
                if not self._config.ssl_enabled:
                    client_kwargs["use_ssl"] = False

            self._client = boto3.client("s3", **client_kwargs)  # type: ignore[arg-type]

        return self._client

    async def close(self) -> None:
        if self._client:
            self._client.close()
            self._client = None

    async def __aenter__(self) -> S3StorageClient:
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.close()

    async def upload_file(
        self,
        file_path: str | Path,
        sub_directory: str = "",
        use_signed_url: bool = False,
        expires_in: int = 900,
    ) -> UploadResult:
        try:
            path = Path(file_path)
            if not path.exists():
                return UploadResult(success=False, error="File does not exist")

            async with aiofiles.open(path, "rb") as f:
                content = await f.read()

            timestamp = int(datetime.now().timestamp() * 1000)
            base_name = f"{timestamp}-{path.name}"
            key = f"{self._config.upload_path}{sub_directory}/{base_name}".replace("//", "/")
            if key.startswith("/"):
                key = key[1:]

            content_type = get_content_type(str(path))

            client = self._get_client()
            await self._loop.run_in_executor(
                None,
                partial(
                    client.put_object,
                    Bucket=self._config.bucket,
                    Key=key,
                    Body=content,
                    ContentType=content_type,
                ),
            )

            if use_signed_url:
                url = await self.generate_signed_url(key, expires_in)
            else:
                url = self._get_public_url(key)

            return UploadResult(success=True, url=url)

        except (BotoCoreError, ClientError) as e:
            return UploadResult(success=False, error=str(e))
        except OSError as e:
            return UploadResult(success=False, error=f"File error: {e}")

    async def upload_bytes(
        self,
        data: bytes,
        file_name: str,
        content_type: str,
        sub_directory: str = "",
        use_signed_url: bool = False,
        expires_in: int = 900,
    ) -> UploadResult:
        try:
            key = f"{self._config.upload_path}{sub_directory}/{file_name}".replace("//", "/")
            if key.startswith("/"):
                key = key[1:]

            client = self._get_client()
            await self._loop.run_in_executor(
                None,
                partial(
                    client.put_object,
                    Bucket=self._config.bucket,
                    Key=key,
                    Body=data,
                    ContentType=content_type,
                ),
            )

            if use_signed_url:
                url = await self.generate_signed_url(key, expires_in)
            else:
                url = self._get_public_url(key)

            return UploadResult(success=True, url=url)

        except (BotoCoreError, ClientError) as e:
            return UploadResult(success=False, error=str(e))

    async def upload_json(
        self,
        json_data: dict[str, JsonValue],
        file_name: str | None = None,
        sub_directory: str | None = None,
        use_signed_url: bool = False,
        expires_in: int = 900,
    ) -> JsonUploadResult:
        try:
            if not json_data:
                return JsonUploadResult(success=False, error="JSON data is required")

            timestamp = int(datetime.now().timestamp() * 1000)
            actual_filename = file_name or f"{timestamp}.json"

            full_path = self._config.upload_path
            if sub_directory:
                full_path = f"{full_path}/{sub_directory}".replace("//", "/")

            key = f"{full_path}/{actual_filename}".replace("//", "/")
            if key.startswith("/"):
                key = key[1:]

            json_string = json.dumps(json_data, indent=2)

            client = self._get_client()
            await self._loop.run_in_executor(
                None,
                partial(
                    client.put_object,
                    Bucket=self._config.bucket,
                    Key=key,
                    Body=json_string.encode("utf-8"),
                    ContentType="application/json",
                ),
            )

            if use_signed_url:
                url = await self.generate_signed_url(key, expires_in)
            else:
                url = self._get_public_url(key)

            return JsonUploadResult(success=True, url=url, key=key)

        except (BotoCoreError, ClientError) as e:
            return JsonUploadResult(success=False, error=str(e))

    async def generate_signed_url(self, key: str, expires_in: int = 900) -> str:
        try:
            client = self._get_client()
            url: str = await self._loop.run_in_executor(
                None,
                partial(
                    client.generate_presigned_url,
                    "get_object",
                    Params={"Bucket": self._config.bucket, "Key": key},
                    ExpiresIn=expires_in,
                ),
            )
            return url
        except (BotoCoreError, ClientError) as e:
            raise S3StorageError(f"Failed to generate signed URL: {e}", cause=e) from e

    async def download_file(self, key: str, destination: str | Path) -> bool:
        try:
            client = self._get_client()
            response = await self._loop.run_in_executor(
                None,
                partial(client.get_object, Bucket=self._config.bucket, Key=key),
            )

            body = response["Body"].read()
            async with aiofiles.open(destination, "wb") as f:
                await f.write(body)

            return True
        except (BotoCoreError, ClientError) as e:
            raise S3StorageError(f"Failed to download file: {e}", cause=e) from e

    async def delete_object(self, key: str) -> bool:
        try:
            client = self._get_client()
            await self._loop.run_in_executor(
                None,
                partial(client.delete_object, Bucket=self._config.bucket, Key=key),
            )
            return True
        except (BotoCoreError, ClientError) as e:
            raise S3StorageError(f"Failed to delete object: {e}", cause=e) from e

    def _get_public_url(self, key: str) -> str:
        if self._config.endpoint:
            return f"{self._config.endpoint}/{self._config.bucket}/{key}"
        return f"https://{self._config.bucket}.s3.{self._config.region}.amazonaws.com/{key}"


def create_client_from_env() -> S3StorageClient:
    access_key = os.environ.get("AWS_ACCESS_KEY_ID")
    secret_key = os.environ.get("AWS_SECRET_ACCESS_KEY")
    region = os.environ.get("AWS_REGION")
    bucket = os.environ.get("AWS_S3_BUCKET")

    if not all([access_key, secret_key, region, bucket]):
        raise ValueError(
            "Missing required environment variables: "
            "AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION, AWS_S3_BUCKET"
        )

    config = S3StorageConfig(
        access_key_id=access_key,  # type: ignore[arg-type]
        secret_access_key=secret_key,  # type: ignore[arg-type]
        region=region,  # type: ignore[arg-type]
        bucket=bucket,  # type: ignore[arg-type]
        upload_path=os.environ.get("AWS_S3_UPLOAD_PATH", ""),
        endpoint=os.environ.get("AWS_S3_ENDPOINT"),
        ssl_enabled=os.environ.get("AWS_S3_SSL_ENABLED", "true").lower() == "true",
        force_path_style=os.environ.get("AWS_S3_FORCE_PATH_STYLE", "false").lower() == "true",
    )

    return S3StorageClient(config)
