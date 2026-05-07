"""Minimal Python TOON parser for benchmark scoring.

Parses the subset of TOON our trained model emits:

  key: scalar
  key:                       (empty / null)
  key[N]:                    (list of N items, indented entries follow)
    - name: VALUE
      params:
        k: v
  list[N]{f1,f2}: a,b|c,d    (tabular inline)

This is *not* a strict spec implementation — it's tolerant enough to score
real model output. Errors return a partial document plus an error list so the
benchmark can record format-quality scores.

Reference: eliza/packages/core/src/utils/toon.ts.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any

_FENCE_RE = re.compile(r"^```(?:toon|json)?\s*([\s\S]*?)\s*```$", re.IGNORECASE)
_LABEL_RE = re.compile(r"^TOON(?:\s+DOCUMENT)?[:\s-]*$", re.IGNORECASE)
_KEY_RE = re.compile(r"^([A-Za-z_][A-Za-z0-9_.\-]*)(?:\[(\d+)\])?(?:\{([^}]*)\})?\s*:\s*(.*)$")
_LIST_ENTRY_RE = re.compile(r"^-\s*(.*)$")


@dataclass
class ParseResult:
    document: dict[str, Any]
    errors: list[str] = field(default_factory=list)
    raw: str = ""

    @property
    def ok(self) -> bool:
        return not self.errors


def _strip_wrappers(text: str) -> str:
    t = (text or "").strip()
    m = _FENCE_RE.match(t)
    if m:
        t = m.group(1).strip()
    lines = t.splitlines()
    if lines and _LABEL_RE.match(lines[0].strip()):
        lines = lines[1:]
        t = "\n".join(lines)
    return t.strip()


def _coerce_scalar(s: str) -> Any:
    s = s.strip()
    if s == "" or s.lower() in ("null", "~"):
        return None
    if s.lower() == "true":
        return True
    if s.lower() == "false":
        return False
    if (s.startswith('"') and s.endswith('"')) or (s.startswith("'") and s.endswith("'")):
        inner = s[1:-1]
        return inner.replace('\\"', '"').replace("\\n", "\n").replace("\\t", "\t")
    try:
        if "." in s or "e" in s.lower():
            return float(s)
        return int(s)
    except ValueError:
        return s


def _indent(line: str) -> int:
    n = 0
    for ch in line:
        if ch == " ":
            n += 1
        elif ch == "\t":
            n += 4
        else:
            break
    return n


def _parse_block(lines: list[tuple[int, str]], start: int, base_indent: int,
                 errors: list[str]) -> tuple[dict[str, Any], int]:
    """Parse mapping entries at base_indent. Returns (mapping, next_index)."""
    out: dict[str, Any] = {}
    i = start
    while i < len(lines):
        indent, raw = lines[i]
        if indent < base_indent:
            return out, i
        if indent > base_indent:
            errors.append(f"unexpected indent at line: {raw!r}")
            i += 1
            continue
        m = _KEY_RE.match(raw)
        if not m:
            if raw.strip() == "":
                i += 1
                continue
            errors.append(f"unparsed line: {raw!r}")
            i += 1
            continue
        key, count, fields, rest = m.group(1), m.group(2), m.group(3), m.group(4)
        rest = rest.strip()
        if count is not None:
            n = int(count)
            items, i = _parse_list(lines, i + 1, base_indent + 2, n, fields, rest, errors)
            out[key] = items
        else:
            if rest == "":
                if i + 1 < len(lines) and lines[i + 1][0] > base_indent:
                    sub, i = _parse_block(lines, i + 1, lines[i + 1][0], errors)
                    out[key] = sub
                else:
                    out[key] = None
                    i += 1
            else:
                out[key] = _coerce_scalar(rest)
                i += 1
    return out, i


def _parse_list(lines: list[tuple[int, str]], start: int, item_indent: int,
                expected_n: int, fields: str | None, inline: str,
                errors: list[str]) -> tuple[list[Any], int]:
    items: list[Any] = []
    if inline and fields:
        # Tabular inline: each row separated by | (or comma); fields in {} order.
        cols = [c.strip() for c in fields.split(",")]
        rows = re.split(r"[|;]", inline)
        for row in rows:
            cells = [c.strip() for c in row.split(",")]
            if len(cells) != len(cols):
                errors.append(f"tabular row mismatch: {row!r} cols={cols}")
                continue
            items.append({c: _coerce_scalar(v) for c, v in zip(cols, cells)})
        return items, start
    i = start
    while i < len(lines) and len(items) < expected_n:
        indent, raw = lines[i]
        if indent < item_indent:
            break
        if indent > item_indent:
            errors.append(f"unexpected indent inside list: {raw!r}")
            i += 1
            continue
        m = _LIST_ENTRY_RE.match(raw)
        if not m:
            break
        head = m.group(1).strip()
        # The list entry's body starts at item_indent+2 (after '- ').
        body_indent = item_indent + 2
        # If head is "key: value" treat it as the first key of a mapping entry.
        first_kv = _KEY_RE.match(head)
        if first_kv:
            key, count, fields_in, rest = (first_kv.group(1), first_kv.group(2),
                                           first_kv.group(3), first_kv.group(4))
            entry: dict[str, Any] = {}
            rest = rest.strip()
            if count is not None:
                n = int(count)
                sub_items, j = _parse_list(lines, i + 1, body_indent + 2, n,
                                           fields_in, rest, errors)
                entry[key] = sub_items
                i = j
            elif rest == "":
                if i + 1 < len(lines) and lines[i + 1][0] > body_indent:
                    sub, j = _parse_block(lines, i + 1, lines[i + 1][0], errors)
                    entry[key] = sub
                    i = j
                else:
                    entry[key] = None
                    i += 1
            else:
                entry[key] = _coerce_scalar(rest)
                i += 1
            # Continue reading further fields at body_indent.
            while i < len(lines):
                ind2, raw2 = lines[i]
                if ind2 < body_indent:
                    break
                if ind2 > body_indent:
                    errors.append(f"deep indent inside entry: {raw2!r}")
                    i += 1
                    continue
                m2 = _KEY_RE.match(raw2)
                if not m2:
                    break
                k2, cnt2, fld2, rest2 = m2.group(1), m2.group(2), m2.group(3), m2.group(4)
                rest2 = rest2.strip()
                if cnt2 is not None:
                    n2 = int(cnt2)
                    sub_items, j = _parse_list(lines, i + 1, body_indent + 2,
                                               n2, fld2, rest2, errors)
                    entry[k2] = sub_items
                    i = j
                elif rest2 == "":
                    if i + 1 < len(lines) and lines[i + 1][0] > body_indent:
                        sub, j = _parse_block(lines, i + 1, lines[i + 1][0], errors)
                        entry[k2] = sub
                        i = j
                    else:
                        entry[k2] = None
                        i += 1
                else:
                    entry[k2] = _coerce_scalar(rest2)
                    i += 1
            items.append(entry)
        else:
            # Bare scalar entry.
            items.append(_coerce_scalar(head))
            i += 1
    return items, i


def parse(text: str) -> ParseResult:
    raw = _strip_wrappers(text or "")
    if not raw:
        return ParseResult(document={}, errors=["empty document"], raw=raw)
    if raw.startswith("{"):
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, dict):
                return ParseResult(document=parsed, errors=[], raw=raw)
        except json.JSONDecodeError:
            pass
    lines: list[tuple[int, str]] = []
    for ln in raw.splitlines():
        if ln.strip() == "":
            continue
        lines.append((_indent(ln), ln.lstrip()))
    errors: list[str] = []
    doc, _ = _parse_block(lines, 0, 0, errors)
    return ParseResult(document=doc, errors=errors, raw=raw)


__all__ = ["parse", "ParseResult"]
