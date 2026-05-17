"""Shared YAML config loader for the Kokoro fine-tune pipeline.

Supports a single `extends:` key for inheritance (one level deep — keep configs
flat). Resolves the path of an extended file relative to the loading file. Each
CLI script calls `load_config(path, overrides=...)` to get a flat dict.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Mapping

import yaml

CONFIG_DIR = Path(__file__).resolve().parent / "configs"


def _resolve_extends(path: Path, raw: Mapping[str, Any]) -> dict[str, Any]:
    """Walk a single `extends:` chain and merge child-over-parent."""
    if "extends" not in raw:
        return dict(raw)
    parent_name = raw["extends"]
    parent_path = (path.parent / parent_name).resolve()
    if not parent_path.exists():
        # Allow bare names (e.g. extends: base.yaml) to resolve from CONFIG_DIR
        parent_path = (CONFIG_DIR / parent_name).resolve()
    if not parent_path.exists():
        raise FileNotFoundError(
            f"config {path} extends {parent_name!r}, which does not resolve to a file"
        )
    parent = load_config(parent_path)
    merged = dict(parent)
    for k, v in raw.items():
        if k == "extends":
            continue
        merged[k] = v
    return merged


def load_config(
    path: str | Path, overrides: Mapping[str, Any] | None = None
) -> dict[str, Any]:
    cfg_path = Path(path).resolve()
    if not cfg_path.exists():
        # Allow bare config names: resolve in CONFIG_DIR.
        alt = CONFIG_DIR / cfg_path.name
        if alt.exists():
            cfg_path = alt
    if not cfg_path.exists():
        raise FileNotFoundError(f"config not found: {path}")
    with cfg_path.open() as fh:
        raw = yaml.safe_load(fh) or {}
    if not isinstance(raw, dict):
        raise ValueError(f"config {cfg_path} must be a YAML mapping at the top level")
    merged = _resolve_extends(cfg_path, raw)
    if overrides:
        for k, v in overrides.items():
            if v is not None:
                merged[k] = v
    return merged
