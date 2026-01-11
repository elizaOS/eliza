"""
elizaOS S3 Storage Plugin - AWS S3 and S3-compatible storage integration.

This package provides a type-safe async client for S3 storage operations.
"""

from elizaos_plugin_s3_storage.client import S3StorageClient, S3StorageError
from elizaos_plugin_s3_storage.plugin import S3StoragePlugin, create_plugin, get_s3_storage_plugin
from elizaos_plugin_s3_storage.types import (
    JsonUploadResult,
    S3StorageConfig,
    UploadOptions,
    UploadResult,
)

__version__ = "1.0.0"

__all__ = [
    # Main plugin
    "S3StoragePlugin",
    "create_plugin",
    "get_s3_storage_plugin",
    # Client
    "S3StorageClient",
    "S3StorageError",
    # Configuration
    "S3StorageConfig",
    # Types
    "UploadResult",
    "JsonUploadResult",
    "UploadOptions",
]





