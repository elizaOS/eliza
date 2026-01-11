"""
S3 Storage Plugin Types

Strong types with Pydantic validation for S3 operations.
"""

from pydantic import BaseModel, Field


class S3StorageConfig(BaseModel):
    """Configuration for S3 storage client."""

    access_key_id: str = Field(..., min_length=1, description="AWS access key ID")
    secret_access_key: str = Field(..., min_length=1, description="AWS secret access key")
    region: str = Field(..., min_length=1, description="AWS region")
    bucket: str = Field(..., min_length=1, description="S3 bucket name")
    upload_path: str = Field(default="", description="Optional upload path prefix")
    endpoint: str | None = Field(default=None, description="Optional custom S3 endpoint")
    ssl_enabled: bool = Field(default=True, description="Enable SSL for custom endpoint")
    force_path_style: bool = Field(default=False, description="Force path-style addressing")


class UploadResult(BaseModel):
    """Result of an upload operation."""

    success: bool = Field(..., description="Whether the upload was successful")
    url: str | None = Field(default=None, description="URL of the uploaded file")
    error: str | None = Field(default=None, description="Error message if unsuccessful")


class JsonUploadResult(UploadResult):
    """Result of a JSON upload operation."""

    key: str | None = Field(default=None, description="Storage key of the uploaded file")


class UploadOptions(BaseModel):
    """Options for file upload."""

    sub_directory: str = Field(default="", description="Subdirectory within the bucket")
    use_signed_url: bool = Field(default=False, description="Use a signed URL")
    expires_in: int = Field(default=900, ge=1, description="Expiration time for signed URL")


# Content type mapping
CONTENT_TYPES: dict[str, str] = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".pdf": "application/pdf",
    ".json": "application/json",
    ".txt": "text/plain",
    ".html": "text/html",
    ".css": "text/css",
    ".js": "application/javascript",
    ".mp3": "audio/mpeg",
    ".mp4": "video/mp4",
    ".wav": "audio/wav",
    ".webm": "video/webm",
}


def get_content_type(file_path: str) -> str:
    """Get content type for a file path."""
    ext = file_path[file_path.rfind(".") :].lower() if "." in file_path else ""
    return CONTENT_TYPES.get(ext, "application/octet-stream")


