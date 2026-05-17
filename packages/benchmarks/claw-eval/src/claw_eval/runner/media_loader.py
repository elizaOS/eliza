"""Detect and load multimodal media referenced by prompt text."""

from __future__ import annotations

import base64
import hashlib
import mimetypes
import re
from dataclasses import dataclass
from pathlib import Path

from ..models.content import AudioBlock, ImageBlock, TextBlock, VideoBlock

MEDIA_ATTACHED_PATTERN = re.compile(r"\[media attached(?:\s+\d+/\d+)?:\s*([^\]]+)\]", re.IGNORECASE)
IMAGE_SOURCE_PATTERN = re.compile(r"\[(?:image|audio|video):\s*source:\s*([^\]]+)\]", re.IGNORECASE)
PATH_PATTERN = re.compile(r"(?P<path>(?:file://)?(?:~|/|\./|\.\./)[^\s\])]+)")
MIME_SUFFIX_PATTERN = re.compile(r"\(([^()]+/[^()]+)\)\s*$")


@dataclass
class MediaRef:
    raw_path: str
    source: str
    mime_type: str | None = None


@dataclass
class LoadedMedia:
    modality: str
    source_path: str
    mime_type: str
    data_base64: str
    size_bytes: int
    sha256: str
    text: str = ""


def _extract_path_and_mime(source: str) -> tuple[str | None, str | None]:
    text = source.strip()
    if re.match(r"^\d+\s+files?$", text, flags=re.IGNORECASE):
        return None, None

    mime_match = MIME_SUFFIX_PATTERN.search(text)
    mime_type = mime_match.group(1).strip() if mime_match else None
    if mime_match:
        text = text[: mime_match.start()].strip()

    path_match = PATH_PATTERN.search(text)
    if not path_match:
        return None, mime_type

    path = path_match.group("path").strip()
    if path.startswith("file://"):
        path = path[len("file://") :]
    return path, mime_type


def detect_media_references(prompt: str) -> list[MediaRef]:
    """Extract media path references from prompt text."""
    refs: list[MediaRef] = []

    for match in MEDIA_ATTACHED_PATTERN.finditer(prompt):
        path, mime_type = _extract_path_and_mime(match.group(1))
        if path:
            refs.append(MediaRef(raw_path=path, source="media_attached_token", mime_type=mime_type))

    for match in IMAGE_SOURCE_PATTERN.finditer(prompt):
        path, mime_type = _extract_path_and_mime(match.group(1))
        if path:
            refs.append(MediaRef(raw_path=path, source="typed_source_token", mime_type=mime_type))

    return refs


def collect_media_references(prompt: str, attachments: list[str] | None) -> list[MediaRef]:
    """Combine in-text references and prompt.attachments, deduped by raw path."""
    refs = detect_media_references(prompt)
    for attachment in attachments or []:
        refs.append(MediaRef(raw_path=attachment, source="prompt_attachment", mime_type=None))

    deduped: list[MediaRef] = []
    seen: set[str] = set()
    for ref in refs:
        if ref.raw_path in seen:
            continue
        seen.add(ref.raw_path)
        deduped.append(ref)
    return deduped


def _resolve_path(raw_path: str, workspace_root: Path, task_dir: Path | None = None) -> Path:
    p = Path(raw_path).expanduser()
    if p.is_absolute():
        return p
    candidate = (workspace_root / p).resolve()
    if candidate.exists():
        return candidate
    if task_dir is not None:
        return (task_dir / p).resolve()
    return candidate


def _modality_for_mime(mime_type: str) -> str:
    if mime_type.startswith("image/"):
        return "image"
    if mime_type.startswith("audio/"):
        return "audio"
    if mime_type.startswith("video/"):
        return "video"
    if mime_type.startswith("text/") or mime_type in {
        "application/json",
        "application/xml",
    }:
        return "document"
    raise ValueError(f"Unsupported media mime type: {mime_type}")


def _infer_mime(path: Path, declared_mime: str | None) -> str:
    if declared_mime:
        return declared_mime
    guessed, _ = mimetypes.guess_type(path.name)
    if guessed:
        return guessed
    if path.suffix.lower() in {".jpg", ".jpeg"}:
        return "image/jpeg"
    if path.suffix.lower() == ".md":
        return "text/markdown"
    if path.suffix.lower() == ".txt":
        return "text/plain"
    if path.suffix.lower() == ".csv":
        return "text/csv"
    raise ValueError(f"Cannot infer mime type for {path}")


def _maybe_resize_image(payload: bytes, *, max_bytes: int, max_dimension: int, mime_type: str) -> tuple[bytes, str]:
    """Best-effort image normalization with optional Pillow support."""
    if len(payload) <= max_bytes:
        return payload, mime_type
    try:
        from PIL import Image, ImageOps  # type: ignore
    except Exception:
        return payload, mime_type

    from io import BytesIO

    img = Image.open(BytesIO(payload))
    img = ImageOps.exif_transpose(img)
    if max(img.size) > max_dimension:
        img.thumbnail((max_dimension, max_dimension))

    out = BytesIO()
    img.save(out, format="PNG")
    encoded = out.getvalue()
    return encoded, "image/png"


def _decode_document(payload: bytes, resolved: Path) -> str:
    try:
        text = payload.decode("utf-8")
    except UnicodeDecodeError:
        text = payload.decode("utf-8", errors="replace")
    text = text.strip()
    if not text:
        raise ValueError(f"Document attachment is empty: {resolved}")
    return text


def load_media_from_ref(
    ref: MediaRef,
    *,
    workspace_root: Path,
    task_dir: Path | None,
    max_bytes: int,
    image_max_dimension: int,
) -> LoadedMedia:
    """Read local attachment and return encoded payload with metadata."""
    resolved = _resolve_path(ref.raw_path, workspace_root, task_dir=task_dir)
    if not resolved.exists():
        raise FileNotFoundError(f"Media file not found: {resolved}")
    payload = resolved.read_bytes()
    mime_type = _infer_mime(resolved, ref.mime_type)
    modality = _modality_for_mime(mime_type)
    text = ""

    if modality == "image":
        payload, mime_type = _maybe_resize_image(
            payload,
            max_bytes=max_bytes,
            max_dimension=image_max_dimension,
            mime_type=mime_type,
        )
    elif modality == "document":
        text = _decode_document(payload, resolved)
    if len(payload) > max_bytes:
        raise ValueError(f"Media file exceeds max_bytes ({max_bytes}): {resolved}")

    digest = hashlib.sha256(payload).hexdigest()
    return LoadedMedia(
        modality=modality,
        source_path=str(resolved),
        mime_type=mime_type,
        data_base64=base64.b64encode(payload).decode("ascii") if modality != "document" else "",
        size_bytes=len(payload),
        sha256=digest,
        text=text,
    )


def to_content_block(media: LoadedMedia) -> ImageBlock | AudioBlock | VideoBlock | TextBlock:
    if media.modality == "document":
        source_name = Path(media.source_path).name
        return TextBlock(text=f"[attached document: {source_name}]\n{media.text}")
    if media.modality == "image":
        return ImageBlock(data=media.data_base64, mime_type=media.mime_type, source_path=media.source_path)
    if media.modality == "audio":
        return AudioBlock(data=media.data_base64, mime_type=media.mime_type, source_path=media.source_path)
    return VideoBlock(data=media.data_base64, mime_type=media.mime_type, source_path=media.source_path)


def model_supports_modality(input_modalities: list[str], modality: str) -> bool:
    if modality == "document":
        return "text" in set(input_modalities)
    return modality in set(input_modalities)
