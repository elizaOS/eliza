"""Small TOON parser used by the training and benchmark harnesses.

This intentionally supports the subset emitted by the eliza training corpus:
top-level ``key: value`` pairs, indexed array headers such as ``actions[1]:``,
YAML-style bullet lists, and nested dictionaries for action params.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass
class ParseResult:
    document: dict[str, Any]
    errors: list[str]

    @property
    def ok(self) -> bool:
        return not self.errors


def _strip_fence(src: str) -> str:
    text = src.strip()
    if not text.startswith("```"):
        return text
    lines = text.splitlines()
    if len(lines) >= 2 and lines[-1].strip() == "```":
        return "\n".join(lines[1:-1]).strip()
    return text


def _indent(line: str) -> int:
    return len(line) - len(line.lstrip(" "))


def _base_key(key: str) -> str:
    return key.split("[", 1)[0].strip()


def _scalar(raw: str) -> Any:
    value = raw.strip()
    if value == "":
        return None
    lower = value.lower()
    if lower == "true":
        return True
    if lower == "false":
        return False
    if lower in {"null", "none"}:
        return None
    if (
        (value.startswith('"') and value.endswith('"'))
        or (value.startswith("'") and value.endswith("'"))
    ):
        return value[1:-1]
    if "," in value and not any(ch in value for ch in "{}[]"):
        return [part.strip() for part in value.split(",") if part.strip()]
    return value


def _parse_key_value(text: str) -> tuple[str, str] | None:
    if ":" not in text:
        return None
    key, value = text.split(":", 1)
    key = key.strip()
    if not key:
        return None
    return key, value.strip()


def _parse_dict(lines: list[str], start: int, min_indent: int) -> tuple[dict[str, Any], int]:
    obj: dict[str, Any] = {}
    i = start
    while i < len(lines):
        line = lines[i]
        if not line.strip():
            i += 1
            continue
        indent = _indent(line)
        if indent < min_indent:
            break
        stripped = line.strip()
        if stripped.startswith("- "):
            break
        parsed = _parse_key_value(stripped)
        if parsed is None:
            i += 1
            continue
        raw_key, raw_value = parsed
        key = _base_key(raw_key)
        if raw_value:
            obj[key] = _scalar(raw_value)
            i += 1
            continue
        child_start = i + 1
        child_indent = _next_indent(lines, child_start)
        if child_indent is None or child_indent <= indent:
            obj[key] = [] if "[" in raw_key else None
            i += 1
            continue
        if _next_nonempty(lines, child_start).strip().startswith("- "):
            obj[key], i = _parse_list(lines, child_start, child_indent)
        else:
            obj[key], i = _parse_dict(lines, child_start, child_indent)
    return obj, i


def _parse_list(lines: list[str], start: int, min_indent: int) -> tuple[list[Any], int]:
    items: list[Any] = []
    i = start
    while i < len(lines):
        line = lines[i]
        if not line.strip():
            i += 1
            continue
        indent = _indent(line)
        if indent < min_indent:
            break
        stripped = line.strip()
        if not stripped.startswith("- "):
            break
        rest = stripped[2:].strip()
        parsed = _parse_key_value(rest)
        if parsed is None:
            items.append(_scalar(rest))
            i += 1
            continue
        raw_key, raw_value = parsed
        item: dict[str, Any] = {_base_key(raw_key): _scalar(raw_value)}
        i += 1
        child_indent = _next_indent(lines, i)
        if child_indent is not None and child_indent > indent:
            child, i = _parse_dict(lines, i, child_indent)
            item.update(child)
        items.append(item)
    return items, i


def _next_indent(lines: list[str], start: int) -> int | None:
    for line in lines[start:]:
        if line.strip():
            return _indent(line)
    return None


def _next_nonempty(lines: list[str], start: int) -> str:
    for line in lines[start:]:
        if line.strip():
            return line
    return ""


def parse(src: str) -> ParseResult:
    text = _strip_fence(src)
    if not text:
        return ParseResult(document={}, errors=["empty document"])

    lines = text.splitlines()
    try:
        document, _ = _parse_dict(lines, 0, 0)
    except Exception as exc:  # pragma: no cover - defensive parser boundary
        return ParseResult(document={}, errors=[str(exc)])

    if not document:
        return ParseResult(document={}, errors=["empty document"])
    return ParseResult(document=document, errors=[])
