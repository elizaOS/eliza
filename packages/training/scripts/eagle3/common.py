"""Shared helpers for the EAGLE3 training pipeline.

The pipeline keeps heavyweight ML imports inside the stage that needs them so
manifest/dry-run checks stay cheap. Missing optional dependencies are reported
as explicit environment errors rather than silently writing claimed artifacts.
"""

from __future__ import annotations

import hashlib
import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

ACTIVE_TIERS = ("0_8b", "2b", "4b", "9b", "27b")
MANIFEST_SCHEMA_VERSION = 1
FAIL_CLOSED_EXIT = 3
ENVIRONMENT_EXIT = 4


def configure_logging(name: str) -> logging.Logger:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    return logging.getLogger(name)


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def stable_json_sha256(value: Any) -> str:
    payload = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def write_jsonl(path: Path, records: Iterable[dict[str, Any]]) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    count = 0
    with path.open("w", encoding="utf-8") as fh:
        for record in records:
            fh.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")
            count += 1
    return count


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    with path.open(encoding="utf-8") as fh:
        for line_no, line in enumerate(fh, start=1):
            line = line.strip()
            if not line:
                continue
            try:
                parsed = json.loads(line)
            except json.JSONDecodeError as exc:
                raise ValueError(f"{path}:{line_no} is not valid JSON") from exc
            if not isinstance(parsed, dict):
                raise ValueError(f"{path}:{line_no} must be a JSON object")
            records.append(parsed)
    return records


def count_jsonl(path: Path) -> int:
    return len(read_jsonl(path))


def require_module(module: str, package_hint: str, log: logging.Logger) -> Any | None:
    try:
        return __import__(module)
    except ImportError:
        log.error(
            "%s is required for this EAGLE3 stage. Install %s and rerun.",
            module,
            package_hint,
        )
        return None


def validate_existing_file(path: str | None, label: str, log: logging.Logger) -> Path | None:
    if not path:
        log.error("%s is required", label)
        return None
    candidate = Path(path)
    if not candidate.is_file():
        log.error("%s %s does not exist or is not a file", label, candidate)
        return None
    return candidate


def validate_existing_dir(path: str | None, label: str, log: logging.Logger) -> Path | None:
    if not path:
        log.error("%s is required", label)
        return None
    candidate = Path(path)
    if not candidate.is_dir():
        log.error("%s %s does not exist or is not a directory", label, candidate)
        return None
    return candidate


def positive_int(value: int, label: str, log: logging.Logger) -> bool:
    if value <= 0:
        log.error("%s must be > 0 (got %s)", label, value)
        return False
    return True


def fail_closed(log: logging.Logger, message: str) -> int:
    log.error("FAIL-CLOSED: %s", message)
    return FAIL_CLOSED_EXIT
