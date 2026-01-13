from pydantic import BaseModel, Field


class S3StorageConfig(BaseModel):
    access_key_id: str = Field(..., min_length=1)
    secret_access_key: str = Field(..., min_length=1)
    region: str = Field(..., min_length=1)
    bucket: str = Field(..., min_length=1)
    upload_path: str = Field(default="")
    endpoint: str | None = Field(default=None)
    ssl_enabled: bool = Field(default=True)
    force_path_style: bool = Field(default=False)


class UploadResult(BaseModel):
    success: bool = Field(...)
    url: str | None = Field(default=None)
    error: str | None = Field(default=None)


class JsonUploadResult(UploadResult):
    key: str | None = Field(default=None)


class UploadOptions(BaseModel):
    sub_directory: str = Field(default="")
    use_signed_url: bool = Field(default=False)
    expires_in: int = Field(default=900, ge=1)


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
    ext = file_path[file_path.rfind(".") :].lower() if "." in file_path else ""
    return CONTENT_TYPES.get(ext, "application/octet-stream")
