from __future__ import annotations

import os
from pathlib import Path

from elizaos_plugin_eliza_coder.types import CoderConfig


def _parse_bool(value: str | None) -> bool:
    v = (value or "").strip().lower()
    return v in {"1", "true", "yes", "on"}


def _parse_int(value: str | None, fallback: int) -> int:
    raw = (value or "").strip()
    try:
        parsed = int(raw)
    except ValueError:
        return fallback
    if parsed <= 0:
        return fallback
    return parsed


def load_coder_config() -> CoderConfig:
    enabled = _parse_bool(os.environ.get("CODER_ENABLED"))
    allowed_raw = (os.environ.get("CODER_ALLOWED_DIRECTORY") or "").strip()
    allowed = Path(allowed_raw).resolve() if allowed_raw else Path.cwd().resolve()
    timeout_ms = _parse_int(os.environ.get("CODER_TIMEOUT"), 30_000)
    forbidden = [
        s.strip()
        for s in (os.environ.get("CODER_FORBIDDEN_COMMANDS") or "").split(",")
        if s.strip()
    ]
    return CoderConfig(
        enabled=enabled,
        allowed_directory=os.fspath(allowed),
        timeout_ms=timeout_ms,
        forbidden_commands=forbidden,
    )
