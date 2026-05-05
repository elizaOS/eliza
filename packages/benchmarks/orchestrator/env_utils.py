from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path


def load_env_file(path: Path) -> dict[str, str]:
    """Load a simple .env file without overriding existing process env."""
    loaded: dict[str, str] = {}
    if not path.exists() or not path.is_file():
        return loaded

    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export ") :].strip()
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if not key:
            continue
        if key not in os.environ:
            os.environ[key] = value
        loaded[key] = os.environ[key]
    return loaded


def merged_environment(base_env: dict[str, str], overrides: dict[str, str]) -> dict[str, str]:
    merged = dict(base_env)
    merged.update(overrides)
    return merged


def read_json(path: Path) -> dict[str, object] | list[object] | str | int | float | bool | None:
    return json.loads(path.read_text(encoding="utf-8"))


def git_head(path: Path) -> str | None:
    proc = subprocess.run(
        ["git", "-C", str(path), "rev-parse", "HEAD"],
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode != 0:
        return None
    return proc.stdout.strip() or None


def safe_version_from_package_json(path: Path) -> str | None:
    if not path.exists() or not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict):
        return None
    version = data.get("version")
    if isinstance(version, str):
        return version
    return None

