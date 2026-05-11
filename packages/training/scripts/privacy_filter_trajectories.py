#!/usr/bin/env python3
"""Redact PII and secrets from trajectory JSON/JSONL before training.

This is a local, bridgeable privacy pipeline for dataset preparation. It
recursively scans every string value and object key in arbitrary JSON records,
applies the same credential and geo regex categories used by the app-training
privacy filter, adds contact-like rules from LifeOps prompt lint, and can call
an optional external privacy backend after local redaction.

The backend hook is intentionally command-based. A wrapper around an OpenAI
Privacy Filter model can be plugged in without making the OpenAI SDK a test or
runtime dependency for this script.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import re
import shlex
import subprocess
import sys
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, TextIO

INPUT_SUFFIXES = {".json", ".jsonl", ".ndjson"}
CONTAINER_KEYS = ("rows", "records", "examples", "data")
GEO_REPLACEMENT = "[REDACTED_GEO]"
STATS_SCHEMA = "eliza.privacy_filter_stats.v1"
STATS_VERSION = 1
ATTESTATION_SCHEMA = "eliza.privacy_filter_attestation.v1"
ATTESTATION_VERSION = 1
KNOWN_CATEGORIES = ("secret", "geo", "contact", "backend")
SAFE_LEDGER_TOKEN_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,96}$")
SAFE_BACKEND_LABEL_RE = re.compile(r"^[a-z][a-z0-9_.:-]{0,63}$")
SAFE_REPLACEMENT_RE = re.compile(
    r"^(?:<REDACTED:[A-Za-z0-9_.:-]+>|\[REDACTED_[A-Z0-9_]+\]|<BACKEND_TEXT_REWRITE>)$"
)
SAFE_BACKEND_LABEL_TERMS = (
    "account",
    "address",
    "card",
    "contact",
    "cookie",
    "credential",
    "date",
    "dob",
    "email",
    "geo",
    "handle",
    "health",
    "ip",
    "key",
    "location",
    "medical",
    "name",
    "person",
    "phone",
    "secret",
    "session",
    "ssn",
    "token",
    "user",
)


class PrivacyFilterError(RuntimeError):
    """Raised when the privacy filter cannot safely continue."""


@dataclass(frozen=True)
class PatternSpec:
    category: str
    label: str
    pattern: re.Pattern[str]
    replacement: str
    high_risk: bool = True


@dataclass(frozen=True)
class SourceLocation:
    file: str
    line: int | None
    record_index: int
    record_id: str | None = None


@dataclass
class FilterStats:
    records_read: int = 0
    records_written: int = 0
    invalid_json: int = 0
    redactions_total: int = 0
    redactions_by_category: Counter[str] = field(default_factory=Counter)
    redactions_by_label: Counter[str] = field(default_factory=Counter)
    redactions_by_source: Counter[str] = field(default_factory=Counter)
    residual_total: int = 0
    residual_by_label: Counter[str] = field(default_factory=Counter)
    residual_samples: list[dict[str, Any]] = field(default_factory=list)
    backend_enabled: bool = False
    backend_name: str | None = None
    backend_model: str | None = None
    backend_calls: int = 0
    backend_failures: int = 0
    backend_skipped_too_long: int = 0

    def note_redaction(self, spec: PatternSpec, source: str) -> None:
        self.redactions_total += 1
        self.redactions_by_category[spec.category] += 1
        self.redactions_by_label[spec.label] += 1
        self.redactions_by_source[source] += 1

    def note_residual(self, spec: PatternSpec, sample: dict[str, Any]) -> None:
        self.residual_total += 1
        self.residual_by_label[spec.label] += 1
        if len(self.residual_samples) < 25:
            self.residual_samples.append(sample)

    def to_jsonable(self, *, input_paths: list[str], strict: bool) -> dict[str, Any]:
        categories = _counter_json(self.redactions_by_category, include=KNOWN_CATEGORIES)
        residual_findings = {
            "count": self.residual_total,
            "by_label": dict(sorted(self.residual_by_label.items())),
            "samples": self.residual_samples,
        }
        return {
            "schema": STATS_SCHEMA,
            "version": STATS_VERSION,
            "input_paths": input_paths,
            "strict": strict,
            "input_count": self.records_read,
            "output_count": self.records_written,
            "redaction_count": self.redactions_total,
            "categories": categories,
            "backend_name": self.backend_name,
            "backend_model": self.backend_model,
            "residual_findings": residual_findings,
            "residual_findings_count": self.residual_total,
            "records_read": self.records_read,
            "records_written": self.records_written,
            "invalid_json": self.invalid_json,
            "redactions": {
                "total": self.redactions_total,
                "by_category": categories,
                "by_label": dict(sorted(self.redactions_by_label.items())),
                "by_source": dict(sorted(self.redactions_by_source.items())),
            },
            "residual_high_risk": {
                "total": residual_findings["count"],
                "by_label": residual_findings["by_label"],
                "samples": residual_findings["samples"],
            },
            "backend": {
                "enabled": self.backend_enabled,
                "name": self.backend_name,
                "model": self.backend_model,
                "calls": self.backend_calls,
                "failures": self.backend_failures,
                "skipped_too_long": self.backend_skipped_too_long,
            },
        }


@dataclass
class RuntimeConfig:
    patterns: list[PatternSpec]
    backend_command: str = ""
    backend_name: str = "external-privacy-filter"
    backend_model: str | None = None
    backend_timeout_sec: float = 20.0
    backend_max_chars: int = 12000


def default_patterns(*, redact_env_secrets: bool = False) -> list[PatternSpec]:
    """Return ordered regex patterns used by the local privacy pass.

    Credential and geo rules are a Python port of
    plugins/app-training/src/core/privacy-filter.ts. Contact-like rules come
    from plugins/app-lifeops/src/default-packs/lint.ts plus the app-training
    handle pattern.
    """

    patterns = [
        # Credential patterns. Order matches the TS source.
        PatternSpec(
            "secret",
            "openai-key",
            re.compile(r"\bsk-[A-Za-z0-9_-]{16,}\b"),
            "<REDACTED:openai-key>",
        ),
        PatternSpec(
            "secret",
            "anthropic-key",
            re.compile(r"\bsk-ant-[A-Za-z0-9_-]{16,}\b"),
            "<REDACTED:anthropic-key>",
        ),
        PatternSpec(
            "secret",
            "bearer",
            re.compile(r"\bBearer\s+[A-Za-z0-9._-]{16,}\b"),
            "<REDACTED:bearer>",
        ),
        PatternSpec(
            "secret",
            "github-token",
            re.compile(r"\bghp_[A-Za-z0-9]{20,}\b"),
            "<REDACTED:github-token>",
        ),
        PatternSpec(
            "secret",
            "aws-access-key",
            re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
            "<REDACTED:aws-access-key>",
        ),
        # Geo patterns. Order matters: JSON coords before looser pairs.
        PatternSpec(
            "geo",
            "coords-json-block",
            re.compile(
                r'"coords"\s*:\s*\{\s*"latitude"\s*:\s*-?\d+(?:\.\d+)?\s*,'
                r'\s*"longitude"\s*:\s*-?\d+(?:\.\d+)?'
                r'(?:\s*,\s*"[A-Za-z_][A-Za-z0-9_]*"\s*:\s*[^,}]+)*\s*\}'
            ),
            GEO_REPLACEMENT,
        ),
        PatternSpec(
            "geo",
            "latitude-longitude-json-pair",
            re.compile(
                r'"latitude"\s*:\s*-?\d+(?:\.\d+)?\s*,\s*"longitude"\s*:\s*-?\d+(?:\.\d+)?'
            ),
            GEO_REPLACEMENT,
        ),
        PatternSpec(
            "geo",
            "location-decimal-pair",
            re.compile(
                r"\b(?:current\s+location|location|coords|coordinates)\s*[:=]\s*"
                r"-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?",
                re.IGNORECASE,
            ),
            GEO_REPLACEMENT,
        ),
        PatternSpec(
            "geo",
            "labeled-lat-lng",
            re.compile(
                r"\b(?:lat|latitude)\s*[:=]\s*-?\d+(?:\.\d+)?\s*[,;]\s*"
                r"(?:lng|lon|long|longitude)\s*[:=]\s*-?\d+(?:\.\d+)?",
                re.IGNORECASE,
            ),
            GEO_REPLACEMENT,
        ),
        PatternSpec(
            "geo",
            "bare-decimal-pair",
            re.compile(r"\b-?\d{1,3}\.\d{2,}\s*,\s*-?\d{1,3}\.\d{2,}\b"),
            GEO_REPLACEMENT,
        ),
        # Contact-like patterns from LifeOps prompt-content lint and
        # app-training handle anonymization. Emails run before handles.
        PatternSpec(
            "contact",
            "email",
            re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b"),
            "<REDACTED:contact-email>",
        ),
        PatternSpec(
            "contact",
            "phone",
            re.compile(
                r"(?:\+\d{1,3}[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]\d{3}[\s.-]\d{4}\b"
            ),
            "<REDACTED:contact-phone>",
        ),
        PatternSpec(
            "contact",
            "handle",
            re.compile(r"(@[a-zA-Z0-9_.-]{2,})"),
            "<REDACTED:contact-handle>",
        ),
        PatternSpec(
            "contact",
            "known-pii-name",
            re.compile(r"\b(?:Jill|Marco|Sarah|Suran|Samantha)\b"),
            "<REDACTED:known-name>",
        ),
    ]

    if redact_env_secrets:
        for value in _snapshot_env_secret_values():
            patterns.append(
                PatternSpec(
                    "secret",
                    "env-secret",
                    re.compile(re.escape(value)),
                    "<REDACTED:env-secret>",
                )
            )
    return patterns


def _snapshot_env_secret_values() -> list[str]:
    interesting = re.compile(r"KEY|TOKEN|SECRET|PASSWORD|API|CREDENTIAL", re.IGNORECASE)
    values: list[str] = []
    seen: set[str] = set()
    for key, value in os.environ.items():
        if not interesting.search(key):
            continue
        if not isinstance(value, str) or len(value) < 8:
            continue
        if value in seen:
            continue
        seen.add(value)
        values.append(value)
    return values


def _hash_value(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _sha256_file(path: Path, chunk_size: int = 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(chunk_size), b""):
            digest.update(block)
    return digest.hexdigest()


def _safe_ref(value: str | None) -> str | None:
    if value is None:
        return None
    return f"sha256:{_hash_value(value)[:16]}"


def _counter_json(counter: Counter[str], *, include: Iterable[str] = ()) -> dict[str, int]:
    result = {key: int(counter.get(key, 0)) for key in include}
    for key, value in sorted(counter.items()):
        if key not in result:
            result[key] = int(value)
    return result


def _utc_now() -> str:
    return (
        datetime.now(timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )


def _safe_ledger_token(value: str, *, default: str) -> str:
    if SAFE_LEDGER_TOKEN_RE.fullmatch(value):
        return value
    return f"{default}:sha256:{_hash_value(value)[:12]}"


def _safe_backend_label(value: Any, *, default: str = "backend") -> str:
    if not isinstance(value, str) or not value.strip():
        return default
    cleaned = value.strip().lower()
    if SAFE_BACKEND_LABEL_RE.fullmatch(cleaned) and any(
        term in cleaned for term in SAFE_BACKEND_LABEL_TERMS
    ):
        return cleaned
    return f"{default}:sha256:{_hash_value(value)[:12]}"


def _safe_replacement_marker(replacement: str, *, label: str) -> str:
    if SAFE_REPLACEMENT_RE.fullmatch(replacement):
        return replacement
    return f"<REDACTED:{label}>"


def _json_dumps_line(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=False)


def _path_for_key(path: str, key: str) -> str:
    # Object keys can be PII too, so ledger/backend paths use stable hashes
    # instead of raw key names. Array indexes remain explicit.
    return f"{path}[key:{_hash_value(key)[:12]}]"


def _write_ledger(
    ledger: TextIO,
    *,
    source: str,
    spec: PatternSpec,
    match_text: str,
    replacement: str,
    start: int,
    end: int,
    path: str,
    location: SourceLocation,
) -> None:
    safe_replacement = _safe_replacement_marker(replacement, label=spec.label)
    entry = {
        "source": _safe_ledger_token(source, default="source"),
        "category": _safe_ledger_token(spec.category, default="category"),
        "label": _safe_ledger_token(spec.label, default="label"),
        "replacement": safe_replacement,
        "replacement_sha256": _hash_value(replacement),
        "replacement_length": len(replacement),
        "path": path,
        "start": start,
        "end": end,
        "value_sha256": _hash_value(match_text),
        "value_length": len(match_text),
        "file": _safe_ref(location.file),
        "line": location.line,
        "record_index": location.record_index,
        "record_id": _safe_ref(location.record_id),
    }
    ledger.write(_json_dumps_line(entry))
    ledger.write("\n")


def _apply_regex_redactions(
    text: str,
    *,
    path: str,
    location: SourceLocation,
    stats: FilterStats,
    ledger: TextIO,
    patterns: list[PatternSpec],
) -> str:
    out = text
    for spec in patterns:
        def _sub(match: re.Match[str], _spec: PatternSpec = spec) -> str:
            replacement = _spec.replacement
            stats.note_redaction(_spec, "regex")
            _write_ledger(
                ledger,
                source="regex",
                spec=_spec,
                match_text=match.group(0),
                replacement=replacement,
                start=match.start(),
                end=match.end(),
                path=path,
                location=location,
            )
            return replacement

        out = spec.pattern.sub(_sub, out)
    return out


def _apply_backend_spans(text: str, response: dict[str, Any]) -> tuple[str, list[dict[str, Any]]]:
    redactions = response.get("redactions")
    if not isinstance(redactions, list):
        return text, []

    spans: list[dict[str, Any]] = []
    for raw in redactions:
        if not isinstance(raw, dict):
            continue
        start = raw.get("start")
        end = raw.get("end")
        if not isinstance(start, int) or not isinstance(end, int):
            continue
        if start < 0 or end < start or end > len(text):
            continue
        label = _safe_backend_label(raw.get("label"))
        replacement = raw.get("replacement")
        if not isinstance(replacement, str):
            replacement = f"<REDACTED:{label}>"
        replacement = _safe_replacement_marker(replacement, label=label)
        spans.append(
            {
                "start": start,
                "end": end,
                "label": label,
                "replacement": replacement,
                "match_text": text[start:end],
            }
        )

    out = text
    for span in sorted(spans, key=lambda item: item["start"], reverse=True):
        out = out[: span["start"]] + span["replacement"] + out[span["end"] :]
    return out, sorted(spans, key=lambda item: item["start"])


def _apply_backend_redaction(
    text: str,
    *,
    path: str,
    location: SourceLocation,
    stats: FilterStats,
    ledger: TextIO,
    config: RuntimeConfig,
) -> str:
    if not config.backend_command:
        return text
    if not text:
        return text
    if config.backend_max_chars > 0 and len(text) > config.backend_max_chars:
        stats.backend_skipped_too_long += 1
        return text

    request = {
        "text": text,
        "path": path,
        "record_index": location.record_index,
        "record_id": _safe_ref(location.record_id),
        "backend_name": config.backend_name,
        "model": config.backend_model,
    }
    stats.backend_calls += 1
    try:
        proc = subprocess.run(
            shlex.split(config.backend_command),
            input=json.dumps(request, ensure_ascii=False),
            text=True,
            capture_output=True,
            timeout=config.backend_timeout_sec,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        stats.backend_failures += 1
        raise PrivacyFilterError(
            f"privacy backend failed for {location.file}:{location.line or '-'} {path}: {exc}"
        ) from exc

    if proc.returncode != 0:
        stats.backend_failures += 1
        message = proc.stderr.strip() or proc.stdout.strip() or f"exit {proc.returncode}"
        raise PrivacyFilterError(
            f"privacy backend failed for {location.file}:{location.line or '-'} {path}: {message}"
        )

    try:
        response = json.loads(proc.stdout or "{}")
    except json.JSONDecodeError as exc:
        stats.backend_failures += 1
        raise PrivacyFilterError(
            "privacy backend returned invalid JSON for "
            f"{location.file}:{location.line or '-'} {path}: {exc}"
        ) from exc
    if not isinstance(response, dict):
        stats.backend_failures += 1
        raise PrivacyFilterError("privacy backend response must be a JSON object")

    if isinstance(response.get("text"), str):
        new_text = response["text"]
        if new_text == text:
            return text
        label = _safe_backend_label(response.get("label"), default="text-rewrite")
        spec = PatternSpec(
            "backend",
            label,
            re.compile("$^"),
            "<REDACTED:backend>",
        )
        stats.note_redaction(spec, "backend")
        _write_ledger(
            ledger,
            source=config.backend_name,
            spec=spec,
            match_text=text,
            replacement="<BACKEND_TEXT_REWRITE>",
            start=0,
            end=len(text),
            path=path,
            location=location,
        )
        return new_text

    new_text, spans = _apply_backend_spans(text, response)
    for span in spans:
        label = span["label"]
        if not label.startswith("backend:"):
            label = f"backend:{label}"
        spec = PatternSpec("backend", label, re.compile("$^"), span["replacement"])
        stats.note_redaction(spec, "backend")
        _write_ledger(
            ledger,
            source=config.backend_name,
            spec=spec,
            match_text=span["match_text"],
            replacement=span["replacement"],
            start=span["start"],
            end=span["end"],
            path=path,
            location=location,
        )
    return new_text


def filter_text(
    text: str,
    *,
    path: str,
    location: SourceLocation,
    stats: FilterStats,
    ledger: TextIO,
    config: RuntimeConfig,
) -> str:
    # Local regexes run before any model/backend hook so known high-risk
    # material is not sent to an external privacy backend.
    out = _apply_regex_redactions(
        text,
        path=path,
        location=location,
        stats=stats,
        ledger=ledger,
        patterns=config.patterns,
    )
    return _apply_backend_redaction(
        out,
        path=path,
        location=location,
        stats=stats,
        ledger=ledger,
        config=config,
    )


def filter_json_value(
    value: Any,
    *,
    path: str,
    location: SourceLocation,
    stats: FilterStats,
    ledger: TextIO,
    config: RuntimeConfig,
) -> Any:
    if isinstance(value, str):
        return filter_text(
            value,
            path=path,
            location=location,
            stats=stats,
            ledger=ledger,
            config=config,
        )
    if isinstance(value, list):
        return [
            filter_json_value(
                item,
                path=f"{path}[{index}]",
                location=location,
                stats=stats,
                ledger=ledger,
                config=config,
            )
            for index, item in enumerate(value)
        ]
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        key_counts: Counter[str] = Counter()
        for raw_key, raw_child in value.items():
            key = str(raw_key)
            key_path = f"{path}<key:{_hash_value(key)[:12]}>"
            filtered_key = filter_text(
                key,
                path=key_path,
                location=location,
                stats=stats,
                ledger=ledger,
                config=config,
            )
            deduped_key = filtered_key
            if deduped_key in out:
                key_counts[filtered_key] += 1
                deduped_key = f"{filtered_key}__{key_counts[filtered_key]}"
            child_path = _path_for_key(path, deduped_key)
            out[deduped_key] = filter_json_value(
                raw_child,
                path=child_path,
                location=location,
                stats=stats,
                ledger=ledger,
                config=config,
            )
        return out
    return value


def scan_residual_high_risk(
    value: Any,
    *,
    path: str,
    location: SourceLocation,
    stats: FilterStats,
    patterns: list[PatternSpec],
) -> None:
    high_risk_patterns = [spec for spec in patterns if spec.high_risk]
    if isinstance(value, str):
        for spec in high_risk_patterns:
            for match in spec.pattern.finditer(value):
                stats.note_residual(
                    spec,
                    {
                        "category": spec.category,
                        "label": spec.label,
                        "path": path,
                        "start": match.start(),
                        "end": match.end(),
                        "value_sha256": _hash_value(match.group(0)),
                        "value_length": len(match.group(0)),
                        "file": _safe_ref(location.file),
                        "line": location.line,
                        "record_index": location.record_index,
                        "record_id": _safe_ref(location.record_id),
                    },
                )
        return
    if isinstance(value, list):
        for index, item in enumerate(value):
            scan_residual_high_risk(
                item,
                path=f"{path}[{index}]",
                location=location,
                stats=stats,
                patterns=patterns,
            )
        return
    if isinstance(value, dict):
        for key, child in value.items():
            scan_residual_high_risk(
                key,
                path=f"{path}<key:{_hash_value(str(key))[:12]}>",
                location=location,
                stats=stats,
                patterns=patterns,
            )
            scan_residual_high_risk(
                child,
                path=_path_for_key(path, str(key)),
                location=location,
                stats=stats,
                patterns=patterns,
            )


def _record_id(value: Any) -> str | None:
    if not isinstance(value, dict):
        return None
    candidates = [
        value.get("trajectoryId"),
        value.get("trajectory_id"),
        value.get("id"),
        value.get("callId"),
    ]
    metadata = value.get("metadata")
    if isinstance(metadata, dict):
        candidates.extend(
            [
                metadata.get("trajectory_id"),
                metadata.get("trajectoryId"),
                metadata.get("call_id"),
                metadata.get("callId"),
            ]
        )
    for candidate in candidates:
        if isinstance(candidate, str) and candidate.strip():
            return candidate
    return None


def _iter_input_files(paths: Iterable[str], suffixes: set[str]) -> Iterable[Path]:
    for raw in paths:
        path = Path(raw).expanduser()
        if path.is_dir():
            for child in sorted(path.rglob("*")):
                if child.is_file() and child.suffix.lower() in suffixes:
                    yield child
        else:
            yield path


def _expand_top_level(value: Any) -> Iterable[Any]:
    if isinstance(value, list):
        yield from value
        return
    if isinstance(value, dict):
        for key in CONTAINER_KEYS:
            nested = value.get(key)
            if isinstance(nested, list):
                yield from nested
                return
    yield value


def _handle_invalid_json(
    *,
    path: Path,
    line: int | None,
    exc: json.JSONDecodeError,
    on_invalid_json: str,
    stats: FilterStats,
) -> None:
    stats.invalid_json += 1
    if on_invalid_json == "skip":
        print(f"skip invalid JSON {path}:{line or '-'}: {exc}", file=sys.stderr)
        return
    raise PrivacyFilterError(f"invalid JSON {path}:{line or '-'}: {exc}") from exc


def read_json_records(
    path: Path,
    *,
    on_invalid_json: str = "error",
    stats: FilterStats | None = None,
) -> Iterable[tuple[Any, int | None]]:
    if stats is None:
        stats = FilterStats()
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise PrivacyFilterError(f"cannot read {path}: {exc}") from exc
    stripped = text.strip()
    if not stripped:
        return

    suffix = path.suffix.lower()
    if suffix == ".json":
        try:
            parsed = json.loads(stripped)
        except json.JSONDecodeError as exc:
            _handle_invalid_json(
                path=path,
                line=None,
                exc=exc,
                on_invalid_json=on_invalid_json,
                stats=stats,
            )
            return
        for record in _expand_top_level(parsed):
            yield record, None
        return

    try:
        parsed = json.loads(stripped)
    except json.JSONDecodeError:
        parsed = None
    else:
        for record in _expand_top_level(parsed):
            yield record, None
        return

    for line_no, line in enumerate(text.splitlines(), start=1):
        line = line.strip()
        if not line:
            continue
        try:
            parsed_line = json.loads(line)
        except json.JSONDecodeError as exc:
            _handle_invalid_json(
                path=path,
                line=line_no,
                exc=exc,
                on_invalid_json=on_invalid_json,
                stats=stats,
            )
            continue
        for record in _expand_top_level(parsed_line):
            yield record, line_no


def build_privacy_attestation(
    *,
    input_paths: list[str],
    output_jsonl: Path,
    ledger_jsonl: Path,
    stats_json: Path,
    stats: FilterStats,
    strict: bool,
) -> dict[str, Any]:
    categories = _counter_json(stats.redactions_by_category, include=KNOWN_CATEGORIES)
    residual_findings = {
        "count": stats.residual_total,
        "by_label": dict(sorted(stats.residual_by_label.items())),
    }
    passed = (
        strict
        and stats.invalid_json == 0
        and stats.backend_failures == 0
        and stats.residual_total == 0
        and stats.records_read == stats.records_written
    )
    artifacts = {
        "redacted_jsonl": {
            "path": str(output_jsonl),
            "sha256": _sha256_file(output_jsonl),
            "rows": stats.records_written,
        },
        "ledger_jsonl": {
            "path": str(ledger_jsonl),
            "sha256": _sha256_file(ledger_jsonl),
            "entries": stats.redactions_total,
            "raw_sensitive_values": False,
            "value_fields": ["value_sha256", "value_length"],
            "replacement_fields": ["replacement", "replacement_sha256", "replacement_length"],
        },
        "stats_json": {
            "path": str(stats_json),
            "sha256": _sha256_file(stats_json),
        },
    }
    gate = {
        "passed": passed,
        "strict": strict,
        "input_count": stats.records_read,
        "output_count": stats.records_written,
        "redaction_count": stats.redactions_total,
        "categories": categories,
        "backend_name": stats.backend_name,
        "backend_model": stats.backend_model,
        "invalid_json": stats.invalid_json,
        "backend_failures": stats.backend_failures,
        "residual_findings": residual_findings,
        "residual_findings_count": stats.residual_total,
    }
    return {
        "schema": ATTESTATION_SCHEMA,
        "version": ATTESTATION_VERSION,
        "generated_at": _utc_now(),
        "passed": passed,
        "strict": strict,
        "input_count": stats.records_read,
        "output_count": stats.records_written,
        "redaction_count": stats.redactions_total,
        "categories": categories,
        "backend_name": stats.backend_name,
        "backend_model": stats.backend_model,
        "residual_findings": residual_findings,
        "residual_findings_count": stats.residual_total,
        "input_path_refs": [_safe_ref(path) for path in input_paths],
        "artifacts": artifacts,
        "gate": gate,
        "ledger_policy": {
            "raw_sensitive_values": False,
            "matched_values": "sha256_and_length_only",
            "object_key_paths": "hashed",
        },
    }


def filter_paths(
    input_paths: list[str],
    *,
    output_jsonl: Path,
    ledger_jsonl: Path,
    stats_json: Path,
    attestation_json: Path | None = None,
    strict: bool = False,
    on_invalid_json: str = "error",
    max_records: int = 0,
    suffixes: set[str] | None = None,
    config: RuntimeConfig | None = None,
) -> FilterStats:
    if suffixes is None:
        suffixes = INPUT_SUFFIXES
    if config is None:
        config = RuntimeConfig(patterns=default_patterns())

    stats = FilterStats(
        backend_enabled=bool(config.backend_command),
        backend_name=config.backend_name if config.backend_command else None,
        backend_model=config.backend_model if config.backend_command else None,
    )
    output_jsonl.parent.mkdir(parents=True, exist_ok=True)
    ledger_jsonl.parent.mkdir(parents=True, exist_ok=True)
    stats_json.parent.mkdir(parents=True, exist_ok=True)
    if attestation_json is not None:
        attestation_json.parent.mkdir(parents=True, exist_ok=True)

    with output_jsonl.open("w", encoding="utf-8") as out_f, ledger_jsonl.open(
        "w", encoding="utf-8"
    ) as ledger_f:
        for path in _iter_input_files(input_paths, suffixes):
            if not path.exists():
                raise PrivacyFilterError(f"input path does not exist: {path}")
            for raw_record, line in read_json_records(
                path,
                on_invalid_json=on_invalid_json,
                stats=stats,
            ):
                if max_records and stats.records_read >= max_records:
                    break
                stats.records_read += 1

                original = copy.deepcopy(raw_record)
                location = SourceLocation(
                    file=str(path),
                    line=line,
                    record_index=stats.records_read,
                    record_id=_record_id(original),
                )
                cleaned = filter_json_value(
                    original,
                    path="$",
                    location=location,
                    stats=stats,
                    ledger=ledger_f,
                    config=config,
                )
                scan_residual_high_risk(
                    cleaned,
                    path="$",
                    location=location,
                    stats=stats,
                    patterns=config.patterns,
                )
                out_f.write(_json_dumps_line(cleaned))
                out_f.write("\n")
                stats.records_written += 1
            if max_records and stats.records_read >= max_records:
                break

    stats_payload = stats.to_jsonable(input_paths=input_paths, strict=strict)
    stats_json.write_text(
        json.dumps(stats_payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    if attestation_json is not None:
        attestation_payload = build_privacy_attestation(
            input_paths=input_paths,
            output_jsonl=output_jsonl,
            ledger_jsonl=ledger_jsonl,
            stats_json=stats_json,
            stats=stats,
            strict=strict,
        )
        attestation_json.write_text(
            json.dumps(attestation_payload, ensure_ascii=False, indent=2, sort_keys=True)
            + "\n",
            encoding="utf-8",
        )
    if strict and stats.residual_total:
        raise PrivacyFilterError(
            f"strict privacy check failed: {stats.residual_total} residual high-risk pattern(s)"
        )
    return stats


def _default_sidecar(path: str, suffix: str) -> Path:
    output = Path(path)
    return output.with_name(f"{output.name}{suffix}")


def build_arg_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        description="Redact trajectory JSON/JSONL into privacy-filtered JSONL."
    )
    ap.add_argument(
        "--input",
        action="append",
        required=True,
        help="Input JSON/JSONL file or directory. Repeatable; directories recurse.",
    )
    ap.add_argument("--output-jsonl", required=True, help="Redacted JSONL output path.")
    ap.add_argument(
        "--ledger-jsonl",
        default="",
        help="Redaction ledger JSONL path. Defaults to <output-jsonl>.ledger.jsonl.",
    )
    ap.add_argument(
        "--stats-json",
        default="",
        help="Aggregate stats JSON path. Defaults to <output-jsonl>.stats.json.",
    )
    ap.add_argument(
        "--attestation-json",
        "--privacy-attestation-json",
        dest="attestation_json",
        default="",
        help=(
            "Optional machine-readable privacy attestation JSON path for downstream "
            "dataset publishing gates."
        ),
    )
    ap.add_argument(
        "--strict",
        action="store_true",
        help="Exit non-zero if residual high-risk patterns remain after filtering.",
    )
    ap.add_argument(
        "--on-invalid-json",
        choices=("error", "skip"),
        default="error",
        help="How to handle invalid JSON input.",
    )
    ap.add_argument("--max-records", type=int, default=0, help="Optional record cap.")
    ap.add_argument(
        "--suffixes",
        default=",".join(sorted(INPUT_SUFFIXES)),
        help="Comma-separated file suffix allowlist for recursive directory input.",
    )
    ap.add_argument(
        "--redact-env-secrets",
        action="store_true",
        help="Also redact process.env values whose variable names look secret-like.",
    )
    ap.add_argument(
        "--backend-command",
        default="",
        help=(
            "Optional external privacy backend command. Receives JSON on stdin and "
            "returns either {'text': str} or {'redactions': [...]}. Local regex "
            "redaction runs first."
        ),
    )
    ap.add_argument(
        "--openai-privacy-filter-command",
        dest="backend_command",
        default="",
        help=(
            "Alias for --backend-command, intended for a local wrapper around an "
            "OpenAI Privacy Filter backend."
        ),
    )
    ap.add_argument(
        "--backend-name",
        default="external-privacy-filter",
        help="Ledger/source label for --backend-command.",
    )
    ap.add_argument(
        "--backend-model",
        default=None,
        help="Optional model name passed through to the backend command JSON.",
    )
    ap.add_argument(
        "--backend-timeout-sec",
        type=float,
        default=20.0,
        help="Per-string backend timeout.",
    )
    ap.add_argument(
        "--backend-max-chars",
        type=int,
        default=12000,
        help="Skip backend calls for strings longer than this; 0 disables the cap.",
    )
    return ap


def main(argv: list[str] | None = None) -> int:
    ap = build_arg_parser()
    args = ap.parse_args(argv)

    output_jsonl = Path(args.output_jsonl)
    ledger_jsonl = (
        Path(args.ledger_jsonl)
        if args.ledger_jsonl
        else _default_sidecar(args.output_jsonl, ".ledger.jsonl")
    )
    stats_json = (
        Path(args.stats_json)
        if args.stats_json
        else _default_sidecar(args.output_jsonl, ".stats.json")
    )
    attestation_json = Path(args.attestation_json) if args.attestation_json else None
    suffixes = {
        suffix.strip().lower()
        for suffix in args.suffixes.split(",")
        if suffix.strip()
    }
    if not suffixes:
        raise SystemExit("--suffixes must include at least one suffix")

    config = RuntimeConfig(
        patterns=default_patterns(redact_env_secrets=args.redact_env_secrets),
        backend_command=args.backend_command,
        backend_name=args.backend_name,
        backend_model=args.backend_model,
        backend_timeout_sec=args.backend_timeout_sec,
        backend_max_chars=args.backend_max_chars,
    )

    try:
        stats = filter_paths(
            args.input,
            output_jsonl=output_jsonl,
            ledger_jsonl=ledger_jsonl,
            stats_json=stats_json,
            attestation_json=attestation_json,
            strict=args.strict,
            on_invalid_json=args.on_invalid_json,
            max_records=args.max_records,
            suffixes=suffixes,
            config=config,
        )
    except PrivacyFilterError as exc:
        print(f"privacy filter failed: {exc}", file=sys.stderr)
        return 2 if args.strict and "residual high-risk" in str(exc) else 1

    print(
        f"privacy filter wrote {stats.records_written} record(s), "
        f"{stats.redactions_total} redaction(s), "
        f"{stats.residual_total} residual high-risk match(es)",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
