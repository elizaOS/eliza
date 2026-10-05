"""LifeWorld common action semantics."""

from __future__ import annotations
import hashlib
import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Any, cast
from .world import LifeWorld
from .entities import Contact, MessageSource

logger = logging.getLogger(__name__)


class UnsupportedAction(RuntimeError):
    """Raised when the executor doesn't know how to apply an action against the world."""


def _required(kwargs: dict[str, Any], key: str, *, action: str, sub: str) -> Any:
    if key not in kwargs:
        raise KeyError(
            f"{action}/{sub} missing required field '{key}' in kwargs={sorted(kwargs)}"
        )
    return kwargs[key]


def _details(kwargs: dict[str, Any]) -> dict[str, Any]:
    """Return the kwargs.details dict if present, else {}."""
    raw = kwargs.get("details")
    return raw if isinstance(raw, dict) else {}


def _string_list(value: Any) -> list[str]:
    """Normalize a string-or-list field into a list of non-empty strings."""
    if isinstance(value, str):
        stripped = value.strip()
        return [stripped] if stripped else []
    if isinstance(value, list):
        return [
            item.strip() for item in value if isinstance(item, str) and item.strip()
        ]
    return []


def _synthetic_id(prefix: str, payload: dict[str, Any]) -> str:
    """Produce a stable deterministic id from a dict payload.

    Used when the scenario omits an explicit id (umbrella LIFE_CREATE,
    SCHEDULED_TASK_CREATE, etc.) but the executor still has to pick a
    primary key. Hashing the canonical-json kwargs guarantees that two
    replays of the same Action produce the same id, which is the only way
    state-hash matching can succeed for these scenarios.
    """
    blob = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    digest = hashlib.sha256(blob.encode("utf-8")).hexdigest()[:12]
    return f"{prefix}_{digest}"


def _validated_json_value(value: Any, *, field: str) -> Any:
    if value is None or isinstance(value, (str, bool)):
        return value
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if isinstance(value, float) and (value != value or abs(value) == float("inf")):
            raise ValueError(f"{field} must not contain NaN or infinity")
        return value
    if isinstance(value, list):
        return [
            _validated_json_value(item, field=f"{field}[{index}]")
            for index, item in enumerate(value)
        ]
    if isinstance(value, dict):
        normalized: dict[str, Any] = {}
        for key, item in value.items():
            if not isinstance(key, str) or not key:
                raise ValueError(f"{field} object keys must be non-empty strings")
            normalized[key] = _validated_json_value(item, field=f"{field}.{key}")
        return normalized
    raise ValueError(f"{field} contains unsupported value {value!r}")


def _strict_positive_integer(
    value: Any,
    *,
    field: str,
    default: int,
    maximum: int,
) -> int:
    if value is None:
        return default
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"{field} must be an integer")
    if value <= 0 or value > maximum:
        raise ValueError(f"{field} must be between 1 and {maximum}")
    return value


_CHAT_SOURCES = frozenset(
    {"imessage", "whatsapp", "signal", "telegram", "slack", "discord", "sms"}
)


_MESSAGE_SOURCES = frozenset({"gmail", *_CHAT_SOURCES})


def _validated_message_source(
    value: Any,
    *,
    field: str = "source",
    required: bool = False,
) -> MessageSource | None:
    if value is None or value == "":
        if required:
            raise KeyError(f"MESSAGE requires non-empty {field}")
        return None
    if not isinstance(value, str) or value not in _MESSAGE_SOURCES:
        raise ValueError(
            f"MESSAGE {field} must be one of {sorted(_MESSAGE_SOURCES)}, got {value!r}"
        )
    return cast(MessageSource, value)


def _positive_limit(value: Any, *, default: int = 50) -> int:
    if value is None:
        return default
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError(f"MESSAGE limit must be a positive integer, got {value!r}")
    return min(value, 500)


def _contact_matches(world: LifeWorld, reference: str) -> list[Contact]:
    direct = world.contacts.get(reference)
    if direct is not None:
        return [direct]
    folded = reference.casefold()
    return sorted(
        (
            contact
            for contact in world.contacts.values()
            if contact.display_name.casefold() == folded
            or contact.primary_email.casefold() == folded
            or any(phone.casefold() == folded for phone in contact.phones)
        ),
        key=lambda contact: contact.id,
    )


_HEALTH_METRIC_TYPES = frozenset(
    {
        "blood_pressure",
        "body_fat_percent",
        "calories",
        "heart_rate",
        "sleep_hours",
        "sleep_quality",
        "steps",
        "weight_kg",
    }
)


def _validated_health_metric(value: Any, *, required: bool) -> str | None:
    if value is None or value == "":
        if required:
            raise KeyError("HEALTH requires metric")
        return None
    if not isinstance(value, str):
        raise ValueError("HEALTH metric must be a string")
    metric = value.strip().lower()
    if metric not in _HEALTH_METRIC_TYPES:
        raise ValueError(
            f"HEALTH metric must be one of {sorted(_HEALTH_METRIC_TYPES)}, got {value!r}"
        )
    return metric


def _shift_iso(iso: str, *, minutes: int) -> str:
    """Add `minutes` to an ISO8601 string and return ISO8601 with Z."""
    s = iso.strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    dt = datetime.fromisoformat(s)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    shifted = dt + timedelta(minutes=minutes)
    out = shifted.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")
    return f"{out}Z"


def _try_parse_iso(value: str) -> datetime | None:
    s = value.strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt
