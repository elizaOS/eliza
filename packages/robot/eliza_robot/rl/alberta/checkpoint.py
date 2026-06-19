"""Checkpoint serialization helpers for Alberta controller state dictionaries."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import numpy as np

_META_KEY = "__alberta_state_npz_meta__"


def save_state_npz(path: str | Path, state: dict[str, Any]) -> None:
    """Save a controller ``state_dict`` as an object-free NPZ archive.

    ``numpy.savez`` cannot represent nested variable-shape layer lists as a
    portable, pickle-free archive. This flattens list/tuple leaves into numbered
    array entries and stores the reconstruction plan as JSON metadata.
    """
    arrays: dict[str, np.ndarray] = {}
    meta: dict[str, Any] = {"version": 1, "fields": {}}

    if _META_KEY in state:
        raise ValueError(f"state key {_META_KEY!r} is reserved")

    for name, value in state.items():
        if isinstance(value, (list, tuple)):
            keys = []
            for index, item in enumerate(value):
                key = f"{name}.{index}"
                arrays[key] = np.asarray(item)
                keys.append(key)
            meta["fields"][name] = {"kind": "sequence", "keys": keys}
        else:
            arrays[name] = np.asarray(value)
            meta["fields"][name] = {"kind": "array", "key": name}

    arrays[_META_KEY] = np.asarray(json.dumps(meta, sort_keys=True))
    np.savez(path, **arrays)


def load_state_npz(path: str | Path) -> dict[str, Any]:
    """Load a state dictionary written by :func:`save_state_npz`."""
    with np.load(path, allow_pickle=False) as archive:
        meta = json.loads(str(archive[_META_KEY]))
        if meta.get("version") != 1:
            raise ValueError(
                f"unsupported Alberta state NPZ version: {meta.get('version')!r}"
            )

        state: dict[str, Any] = {}
        for name, spec in meta["fields"].items():
            if spec["kind"] == "sequence":
                state[name] = [archive[key].copy() for key in spec["keys"]]
            elif spec["kind"] == "array":
                state[name] = archive[spec["key"]].copy()
            else:
                raise ValueError(f"unsupported Alberta state field kind: {spec['kind']!r}")
    return state
