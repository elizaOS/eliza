from __future__ import annotations

import hashlib
import re
import urllib.parse
import uuid as uuid_module

from elizaos.types.generated.eliza.v1 import primitives_pb2

# UUID validation pattern
UUID_PATTERN = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    re.IGNORECASE,
)

# UUID type - stored as string values in proto messages
UUID = str

# The default UUID used when no room or world is specified.
DEFAULT_UUID: str = "00000000-0000-0000-0000-000000000000"

# Proto-backed message types
Content = primitives_pb2.Content
Media = primitives_pb2.Media
MentionContext = primitives_pb2.MentionContext
Metadata = primitives_pb2.Metadata
UUIDMessage = primitives_pb2.UUID
DefaultUUID = primitives_pb2.DefaultUUID


def as_uuid(id_str: str | uuid_module.UUID) -> str:
    if isinstance(id_str, uuid_module.UUID):
        return str(id_str)
    if isinstance(id_str, str):
        if not UUID_PATTERN.match(id_str):
            raise ValueError(f"Invalid UUID format: {id_str}")
        return id_str
    raise TypeError(f"Expected str or UUID, got {type(id_str).__name__}")


def string_to_uuid(target: str | int | uuid_module.UUID) -> str:
    if isinstance(target, uuid_module.UUID):
        return str(target)

    if isinstance(target, int):
        target_str = str(target)
    elif isinstance(target, str):
        target_str = target
    else:
        raise TypeError("Value must be string")

    if UUID_PATTERN.match(target_str):
        return target_str

    escaped = urllib.parse.quote(target_str, safe="-_.!~*'()")
    digest = hashlib.sha1(escaped.encode("utf-8")).digest()  # noqa: S324 (required for parity)

    b = bytearray(digest[:16])
    b[8] = (b[8] & 0x3F) | 0x80
    b[6] &= 0x0F

    return str(uuid_module.UUID(bytes=bytes(b)))


__all__ = [
    "UUID",
    "DEFAULT_UUID",
    "UUIDMessage",
    "DefaultUUID",
    "Content",
    "Media",
    "MentionContext",
    "Metadata",
    "as_uuid",
    "string_to_uuid",
]
