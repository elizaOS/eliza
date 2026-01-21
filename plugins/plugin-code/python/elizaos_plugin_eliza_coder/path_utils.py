from __future__ import annotations

import os
from pathlib import Path

DEFAULT_FORBIDDEN_COMMANDS: list[str] = [
    "rm -rf /",
    "rm -rf ~",
    "sudo rm",
    "mkfs",
    "dd if=/dev",
]


def extract_base_command(command: str) -> str:
    trimmed = command.strip()
    if not trimmed:
        return ""
    return trimmed.split()[0]


def is_safe_command(command: str) -> bool:
    c = command.strip()
    if not c:
        return False
    if "&&" in c or "||" in c or ";" in c:
        return False
    if "$(" in c or "`" in c:
        return False
    return True


def is_forbidden_command(command: str, additional_forbidden: list[str]) -> bool:
    lower = command.lower()
    for f in DEFAULT_FORBIDDEN_COMMANDS:
        if f.lower() in lower:
            return True
    for f in additional_forbidden:
        if f.strip() and f.lower() in lower:
            return True
    return False


def validate_path(target_path: str, allowed_directory: str, current_directory: str) -> str | None:
    allowed = Path(allowed_directory).resolve()
    base = Path(current_directory).resolve() if current_directory else allowed
    resolved = (base / target_path).resolve()

    try:
        resolved.relative_to(allowed)
    except ValueError:
        return None

    return os.fspath(resolved)
