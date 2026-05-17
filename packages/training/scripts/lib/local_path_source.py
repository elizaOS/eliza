"""Resolver for `source: { type: local_path, ... }` entries in datasets.yaml.

This is the Python-side reader for the nightly JSONL export that the TS
trajectory-export cron writes under ``~/.eliza/training/datasets/<YYYY-MM-DD>/``.
The TS side already runs the privacy filter — Python does NOT re-filter rows
read from this path.

Schema:

    - slug: <required>
      source:
        type: local_path
        root: <path with optional ${VAR:-default} expansion>
        glob: <glob relative to root, e.g. "*/action_planner_trajectories.jsonl">
        task: <eliza_native task_type, e.g. action_planner>   # optional
      normalizer: eliza_native_passthrough
      weight: <float>

Resolution rules:

- ``root`` may contain a single ``${VAR}`` or ``${VAR:-default}`` token.
  The token is replaced with the environment value (or the default), then
  ``~`` and any embedded ``..`` are resolved against the file system.
- The glob is evaluated under the resolved root with ``Path.glob``. A
  missing root directory is NOT an error — the resolver returns an empty
  list. Callers (download_datasets.py, the normalize adapter) treat an
  empty match as "skip this entry, log a warning".
"""

from __future__ import annotations

import logging
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

log = logging.getLogger("local_path_source")

# ${VAR} or ${VAR:-default}.  We deliberately accept exactly one token; the
# nightly-export schema only ever needs ELIZA_STATE_DIR or MILADY_STATE_DIR.
_ENV_VAR_RE = re.compile(r"\$\{(?P<name>[A-Z_][A-Z0-9_]*)(?::-(?P<default>[^}]*))?\}")


def expand_env(value: str) -> str:
    """Expand a single ``${VAR}`` / ``${VAR:-default}`` token plus ``~``.

    Unset variables with no default expand to the empty string; the caller
    will then see a non-existent path and skip.
    """

    def _sub(match: re.Match[str]) -> str:
        name = match.group("name")
        default = match.group("default") or ""
        return os.environ.get(name, default)

    expanded = _ENV_VAR_RE.sub(_sub, value)
    return os.path.expanduser(expanded)


@dataclass(frozen=True)
class LocalPathSource:
    """Parsed view of an ``entry.source`` block whose ``type == local_path``."""

    root: Path
    glob: str
    task: str | None

    @classmethod
    def from_entry(cls, entry: dict[str, Any]) -> "LocalPathSource | None":
        """Return the parsed source for an entry, or None if it's not local_path.

        Raises ``ValueError`` if ``source.type == 'local_path'`` but required
        fields are missing — we fail loud rather than silently passing a
        malformed entry through.
        """
        source = entry.get("source")
        if not isinstance(source, dict):
            return None
        if source.get("type") != "local_path":
            return None
        root_raw = source.get("root")
        if not isinstance(root_raw, str) or not root_raw.strip():
            raise ValueError(
                f"entry {entry.get('slug') or entry.get('id')!r} has "
                f"source.type=local_path but no source.root string"
            )
        glob = source.get("glob")
        if not isinstance(glob, str) or not glob.strip():
            raise ValueError(
                f"entry {entry.get('slug') or entry.get('id')!r} has "
                f"source.type=local_path but no source.glob string"
            )
        task = source.get("task")
        if task is not None and not isinstance(task, str):
            raise ValueError(
                f"entry {entry.get('slug') or entry.get('id')!r} has a "
                f"non-string source.task: {task!r}"
            )
        return cls(root=Path(expand_env(root_raw)), glob=glob, task=task)

    def resolve_files(self) -> list[Path]:
        """Return the resolved list of files matched by the glob, sorted.

        Empty result when the root does not exist or no files match — this
        is the documented "skip with warning" path, not an error.
        """
        if not self.root.exists() or not self.root.is_dir():
            log.warning(
                "local_path root %s does not exist; skipping", self.root
            )
            return []
        matches = sorted(self.root.glob(self.glob))
        files = [p for p in matches if p.is_file()]
        if not files:
            log.warning(
                "local_path glob %s/%s matched no files; skipping",
                self.root,
                self.glob,
            )
        return files
