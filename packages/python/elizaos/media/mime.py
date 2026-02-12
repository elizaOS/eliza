"""
MIME type detection and media utilities for Eliza.

Provides robust MIME type detection from file buffers, headers, and extensions.
"""

from __future__ import annotations

import re
from enum import Enum
from urllib.parse import urlparse

# Try to import python-magic for MIME sniffing, fallback to filetype
try:
    import magic  # type: ignore[import-not-found]

    HAS_MAGIC = True
except ImportError:
    HAS_MAGIC = False

try:
    import filetype  # type: ignore[import-not-found]

    HAS_FILETYPE = True
except ImportError:
    HAS_FILETYPE = False


class MediaKind(str, Enum):
    """Media kind categories."""

    IMAGE = "image"
    AUDIO = "audio"
    VIDEO = "video"
    DOCUMENT = "document"
    UNKNOWN = "unknown"


# Map common MIME types to preferred file extensions
EXT_BY_MIME: dict[str, str] = {
    "image/heic": ".heic",
    "image/heif": ".heif",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "audio/ogg": ".ogg",
    "audio/mpeg": ".mp3",
    "audio/x-m4a": ".m4a",
    "audio/mp4": ".m4a",
    "video/mp4": ".mp4",
    "video/quicktime": ".mov",
    "application/pdf": ".pdf",
    "application/json": ".json",
    "application/zip": ".zip",
    "application/gzip": ".gz",
    "application/x-tar": ".tar",
    "application/x-7z-compressed": ".7z",
    "application/vnd.rar": ".rar",
    "application/msword": ".doc",
    "application/vnd.ms-excel": ".xls",
    "application/vnd.ms-powerpoint": ".ppt",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
    "text/csv": ".csv",
    "text/plain": ".txt",
    "text/markdown": ".md",
}

# Reverse map: extension to MIME
MIME_BY_EXT: dict[str, str] = {v: k for k, v in EXT_BY_MIME.items()}
MIME_BY_EXT[".jpeg"] = "image/jpeg"

# Audio file extensions
AUDIO_FILE_EXTENSIONS: set[str] = {".aac", ".flac", ".m4a", ".mp3", ".oga", ".ogg", ".opus", ".wav"}

# Voice-compatible audio extensions (Opus/Ogg)
VOICE_AUDIO_EXTENSIONS: set[str] = {".oga", ".ogg", ".opus"}


def _normalize_header_mime(mime: str | None) -> str | None:
    """Normalize a MIME type from HTTP headers."""
    if not mime:
        return None
    cleaned = mime.split(";")[0].strip().lower()
    return cleaned or None


def _sniff_mime(buffer: bytes | None) -> str | None:
    """Detect MIME type from a buffer using magic bytes."""
    if not buffer:
        return None

    # Try python-magic first
    if HAS_MAGIC:
        try:
            mime = magic.from_buffer(buffer, mime=True)
            return mime if mime else None
        except Exception:
            pass

    # Fallback to filetype
    if HAS_FILETYPE:
        try:
            kind = filetype.guess(buffer)
            return kind.mime if kind else None
        except Exception:
            pass

    return None


def get_file_extension(file_path: str | None) -> str | None:
    """
    Get the file extension from a path or URL.

    Args:
        file_path: File path or URL

    Returns:
        File extension including the dot (e.g., ".jpg"), or None
    """
    if not file_path:
        return None

    # Try parsing as URL
    if re.match(r"^https?://", file_path, re.IGNORECASE):
        try:
            parsed = urlparse(file_path)
            path_parts = parsed.path.split(".")
            if len(path_parts) >= 2:
                ext = path_parts[-1].lower()
                return f".{ext}"
        except Exception:
            pass

    # Plain path parsing
    parts = file_path.split(".")
    if len(parts) < 2:
        return None
    return f".{parts[-1].lower()}"


def _is_generic_mime(mime: str | None) -> bool:
    """Check if a MIME type is generic/container type."""
    if not mime:
        return True
    m = mime.lower()
    return m == "application/octet-stream" or m == "application/zip"


def detect_mime(
    buffer: bytes | None = None,
    header_mime: str | None = None,
    file_path: str | None = None,
) -> str | None:
    """
    Detect MIME type from buffer, headers, and/or file path.
    Prioritizes sniffed types over extension-based detection.

    Args:
        buffer: File contents for magic byte detection
        header_mime: MIME type from HTTP headers
        file_path: File path for extension-based detection

    Returns:
        Detected MIME type or None
    """
    ext = get_file_extension(file_path)
    ext_mime = MIME_BY_EXT.get(ext) if ext else None
    normalized_header = _normalize_header_mime(header_mime)
    sniffed = _sniff_mime(buffer)

    # Prefer sniffed types, but don't let generic container types override
    # a more specific extension mapping (e.g., XLSX vs ZIP)
    if sniffed and (not _is_generic_mime(sniffed) or not ext_mime):
        return sniffed
    if ext_mime:
        return ext_mime
    if normalized_header and not _is_generic_mime(normalized_header):
        return normalized_header
    if sniffed:
        return sniffed
    if normalized_header:
        return normalized_header

    return None


def extension_for_mime(mime: str | None) -> str | None:
    """
    Get the file extension for a MIME type.

    Args:
        mime: MIME type string

    Returns:
        File extension including the dot (e.g., ".jpg"), or None
    """
    if not mime:
        return None
    return EXT_BY_MIME.get(mime.lower())


def is_audio_filename(filename: str | None) -> bool:
    """
    Check if a file appears to be an audio file by extension.

    Args:
        filename: File name or path

    Returns:
        True if the file has an audio extension
    """
    ext = get_file_extension(filename)
    return ext in AUDIO_FILE_EXTENSIONS if ext else False


def is_gif_media(
    content_type: str | None = None,
    filename: str | None = None,
) -> bool:
    """
    Check if media is a GIF.

    Args:
        content_type: MIME type / content type header
        filename: File name or path

    Returns:
        True if the media is a GIF
    """
    if content_type and content_type.lower() == "image/gif":
        return True
    return get_file_extension(filename) == ".gif"


def is_voice_compatible_audio(
    content_type: str | None = None,
    filename: str | None = None,
) -> bool:
    """
    Check if audio is voice-compatible (Opus/Ogg format).

    Args:
        content_type: MIME type / content type header
        filename: File name or path

    Returns:
        True if the audio is in Opus/Ogg format
    """
    mime = content_type.lower() if content_type else None
    if mime and ("ogg" in mime or "opus" in mime):
        return True
    ext = get_file_extension(filename)
    return ext in VOICE_AUDIO_EXTENSIONS if ext else False


def media_kind_from_mime(mime: str | None) -> MediaKind:
    """
    Get media kind from MIME type.

    Args:
        mime: MIME type string

    Returns:
        MediaKind enum value
    """
    if not mime:
        return MediaKind.UNKNOWN

    m = mime.lower()
    if m.startswith("image/"):
        return MediaKind.IMAGE
    if m.startswith("audio/"):
        return MediaKind.AUDIO
    if m.startswith("video/"):
        return MediaKind.VIDEO
    if (
        m.startswith("application/pdf")
        or m.startswith("application/msword")
        or m.startswith("application/vnd.ms-")
        or m.startswith("application/vnd.openxmlformats")
        or m.startswith("text/")
    ):
        return MediaKind.DOCUMENT

    return MediaKind.UNKNOWN


def image_mime_from_format(format_name: str | None) -> str | None:
    """
    Get image MIME type from format name.

    Args:
        format_name: Image format name (e.g., "jpg", "png")

    Returns:
        MIME type string or None
    """
    if not format_name:
        return None

    fmt = format_name.lower()
    mapping = {
        "jpg": "image/jpeg",
        "jpeg": "image/jpeg",
        "heic": "image/heic",
        "heif": "image/heif",
        "png": "image/png",
        "webp": "image/webp",
        "gif": "image/gif",
    }
    return mapping.get(fmt)
