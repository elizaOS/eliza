from __future__ import annotations

from datetime import UTC, datetime
from hashlib import sha256
from typing import Protocol
from uuid import UUID

DEFAULT_TIME_BUCKET_MS = 5 * 60 * 1000

SeedPart = str | int | float | bool | None


class RuntimeLike(Protocol):
    @property
    def agent_id(self) -> object: ...

    @property
    def character(self) -> object: ...

    def get_setting(self, key: str) -> object | None: ...


def _normalize_seed_part(part: SeedPart) -> str:
    if part is None:
        return "none"
    return str(part)


def _coerce_non_empty_string(value: object | None) -> str | None:
    if value is None:
        return None
    as_text = str(value).strip()
    if not as_text:
        return None
    return as_text


def _get_field(obj: object | None, *names: str) -> object | None:
    if obj is None:
        return None

    if isinstance(obj, dict):
        for name in names:
            if name in obj:
                value = obj[name]
                if value is not None and value != "":
                    return value
        return None

    for name in names:
        value = getattr(obj, name, None)
        if value is not None and value != "":
            return value
    return None


def build_deterministic_seed(parts: list[SeedPart]) -> str:
    return "|".join(_normalize_seed_part(part) for part in parts)


def deterministic_hex(seed: str, surface: str, length: int = 16) -> str:
    if length <= 0:
        return ""

    output = ""
    counter = 0
    while len(output) < length:
        payload = f"{seed}|{surface}|{counter}".encode()
        output += sha256(payload).hexdigest()
        counter += 1
    return output[:length]


def deterministic_int(seed: str, surface: str, max_exclusive: int) -> int:
    if max_exclusive <= 1:
        return 0
    value = int(deterministic_hex(seed, surface, 12), 16)
    return value % max_exclusive


def deterministic_uuid(seed: str, surface: str) -> str:
    return str(UUID(hex=deterministic_hex(seed, surface, 32)))


def parse_boolean_setting(value: object | None) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        normalized = value.strip().lower()
        return normalized in ("1", "true", "yes", "on", "enabled")
    return False


def parse_positive_int_setting(value: object | None, fallback: int) -> int:
    if isinstance(value, bool):
        return fallback
    if isinstance(value, (int, float)):
        numeric = int(value)
        return numeric if numeric > 0 else fallback
    if isinstance(value, str):
        try:
            numeric = int(float(value))
            return numeric if numeric > 0 else fallback
        except ValueError:
            return fallback
    return fallback


def build_conversation_seed(
    runtime: RuntimeLike,
    message: object | None,
    state: object | None,
    surface: str,
    *,
    bucket_ms: int | None = None,
    now_ms: int | None = None,
) -> str:
    now_ms_value = now_ms if now_ms is not None else int(datetime.now(UTC).timestamp() * 1000)

    state_data = _get_field(state, "data")
    room_obj = _get_field(state_data, "room")
    world_obj = _get_field(state_data, "world")

    room_id = (
        _coerce_non_empty_string(_get_field(room_obj, "id"))
        or _coerce_non_empty_string(_get_field(state_data, "room_id", "roomId"))
        or _coerce_non_empty_string(_get_field(message, "room_id", "roomId"))
        or "room:none"
    )
    world_id = (
        _coerce_non_empty_string(_get_field(world_obj, "id"))
        or _coerce_non_empty_string(_get_field(room_obj, "world_id", "worldId"))
        or _coerce_non_empty_string(_get_field(state_data, "world_id", "worldId"))
        or _coerce_non_empty_string(_get_field(message, "world_id", "worldId"))
        or "world:none"
    )

    character_obj = _get_field(runtime, "character")
    character_id = (
        _coerce_non_empty_string(_get_field(character_obj, "id"))
        or _coerce_non_empty_string(_get_field(runtime, "agent_id"))
        or "agent:none"
    )

    epoch_bucket = 0
    if bucket_ms and bucket_ms > 0:
        epoch_bucket = now_ms_value // bucket_ms

    return build_deterministic_seed(
        [
            "eliza-prompt-cache-v1",
            world_id,
            room_id,
            character_id,
            epoch_bucket,
            surface,
        ]
    )


def get_prompt_reference_datetime(
    runtime: RuntimeLike,
    message: object | None,
    state: object | None,
    surface: str,
    *,
    now: datetime | None = None,
) -> datetime:
    now_utc = now.astimezone(UTC) if now is not None else datetime.now(UTC)
    deterministic_enabled = parse_boolean_setting(
        runtime.get_setting("PROMPT_CACHE_DETERMINISTIC_TIME")
    )
    if not deterministic_enabled:
        return now_utc

    bucket_ms = parse_positive_int_setting(
        runtime.get_setting("PROMPT_CACHE_TIME_BUCKET_MS"),
        DEFAULT_TIME_BUCKET_MS,
    )
    now_ms = int(now_utc.timestamp() * 1000)
    seed = build_conversation_seed(
        runtime,
        message,
        state,
        surface,
        bucket_ms=bucket_ms,
        now_ms=now_ms,
    )
    bucket_start = (now_ms // bucket_ms) * bucket_ms
    offset = deterministic_int(seed, "time-offset-ms", bucket_ms)
    return datetime.fromtimestamp((bucket_start + offset) / 1000, tz=UTC)
