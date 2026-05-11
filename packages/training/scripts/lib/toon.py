"""Small TOON encoder/decoder used by legacy training scripts.

The training corpus mostly uses a YAML-like TOON subset. Keep this module
dependency-light and intentionally conservative: JSON is accepted, generated
output is valid YAML, and indexed headers such as ``actions[1]:`` are normalized
back to their base key.
"""

from __future__ import annotations

import json
import re
from typing import Any

try:
    import yaml
except Exception:  # pragma: no cover - slim local environments
    yaml = None


_FENCE_RE = re.compile(r"^```(?:toon|yaml|json)?\s*\n?(.*?)\n?```$", re.DOTALL | re.IGNORECASE)
_INDEXED_KEY_RE = re.compile(r"^([A-Za-z_][A-Za-z0-9_-]*)\[\d+\]$")


def _strip_fence(text: str) -> str:
    stripped = text.strip()
    match = _FENCE_RE.match(stripped)
    return match.group(1).strip() if match else stripped


def _base_key(key: Any) -> Any:
    if not isinstance(key, str):
        return key
    match = _INDEXED_KEY_RE.match(key.strip())
    return match.group(1) if match else key


def _merge_values(existing: Any, incoming: Any) -> Any:
    if existing is None:
        return incoming
    if isinstance(existing, list):
        if isinstance(incoming, list):
            return existing + incoming
        return existing + [incoming]
    if isinstance(incoming, list):
        return [existing, *incoming]
    return [existing, incoming]


def _normalize_indexed_keys(value: Any) -> Any:
    if isinstance(value, list):
        return [_normalize_indexed_keys(item) for item in value]
    if not isinstance(value, dict):
        return value
    out: dict[Any, Any] = {}
    for key, item in value.items():
        normalized_key = _base_key(key)
        normalized_item = _normalize_indexed_keys(item)
        if normalized_key in out:
            out[normalized_key] = _merge_values(out[normalized_key], normalized_item)
        else:
            out[normalized_key] = normalized_item
    return out


def _fallback_parse(text: str) -> Any:
    try:
        from scripts.benchmark.toon_parser import parse
    except Exception as exc:  # pragma: no cover - import boundary
        raise ValueError(f"TOON parser unavailable: {exc}") from exc
    result = parse(text)
    if not result.ok:
        raise ValueError("; ".join(result.errors))
    return result.document


def _format_scalar(value: Any) -> str:
    if value is True:
        return "true"
    if value is False:
        return "false"
    if value is None:
        return "null"
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return str(value)
    return json.dumps(str(value), ensure_ascii=False)


def _encode_lines(value: Any, indent: int) -> list[str]:
    pad = " " * indent
    if isinstance(value, dict):
        lines: list[str] = []
        for key, item in value.items():
            if isinstance(item, (dict, list)):
                lines.append(f"{pad}{key}:")
                lines.extend(_encode_lines(item, indent + 2))
            else:
                lines.append(f"{pad}{key}: {_format_scalar(item)}")
        return lines
    if isinstance(value, list):
        lines = []
        for item in value:
            if isinstance(item, dict):
                if not item:
                    lines.append(f"{pad}- {{}}")
                    continue
                first = True
                for key, child in item.items():
                    marker = "- " if first else "  "
                    if isinstance(child, (dict, list)):
                        lines.append(f"{pad}{marker}{key}:")
                        lines.extend(_encode_lines(child, indent + 4))
                    else:
                        lines.append(f"{pad}{marker}{key}: {_format_scalar(child)}")
                    first = False
            elif isinstance(item, list):
                lines.append(f"{pad}-")
                lines.extend(_encode_lines(item, indent + 2))
            else:
                lines.append(f"{pad}- {_format_scalar(item)}")
        return lines
    return [f"{pad}{_format_scalar(value)}"]


class ToonDecoder:
    def decode(self, text: str) -> Any:
        if not isinstance(text, str) or not text.strip():
            raise ValueError("empty TOON document")
        stripped = _strip_fence(text)
        if stripped.startswith("{") or stripped.startswith("["):
            return json.loads(stripped)
        if yaml is not None:
            try:
                parsed = yaml.safe_load(stripped)
            except yaml.YAMLError:
                parsed = None
            if parsed is not None:
                return _normalize_indexed_keys(parsed)
        return _fallback_parse(stripped)

    def close(self) -> None:
        return None


class ToonEncoder:
    def encode(self, value: Any) -> str:
        return "\n".join(_encode_lines(value, 0)).rstrip() + "\n"
