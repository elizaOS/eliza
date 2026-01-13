from __future__ import annotations

# Import types directly - they don't have heavy dependencies
from elizaos_plugin_s3_storage.types import (
    JsonUploadResult,
    S3StorageConfig,
    UploadOptions,
    UploadResult,
)

__version__ = "1.0.0"

__all__ = [
    "S3StoragePlugin",
    "create_plugin",
    "get_s3_storage_plugin",
    "AwsS3Service",
    "S3StorageClient",
    "S3StorageError",
    "S3StorageConfig",
    "UploadResult",
    "JsonUploadResult",
    "UploadOptions",
]


def __getattr__(name: str) -> object:
    """Lazy import heavy dependencies (boto3) only when needed."""
    if name in ("S3StorageClient", "S3StorageError"):
        from elizaos_plugin_s3_storage.client import S3StorageClient, S3StorageError

        if name == "S3StorageClient":
            return S3StorageClient
        return S3StorageError
    if name in ("S3StoragePlugin", "create_plugin", "get_s3_storage_plugin"):
        from elizaos_plugin_s3_storage.plugin import (
            S3StoragePlugin,
            create_plugin,
            get_s3_storage_plugin,
        )

        if name == "S3StoragePlugin":
            return S3StoragePlugin
        if name == "create_plugin":
            return create_plugin
        return get_s3_storage_plugin
    if name == "AwsS3Service":
        from elizaos_plugin_s3_storage.service import AwsS3Service

        return AwsS3Service
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
