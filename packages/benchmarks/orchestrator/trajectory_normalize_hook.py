"""Wire ``lib.trajectory_normalizer`` into the orchestrator runner.

After each (benchmark, harness) outcome completes, the runner calls
``normalize_outcome_trajectories`` to scan the benchmark output
directory for raw native trajectory artifacts and produce a single
canonical ``trajectory.canonical.jsonl`` next to them. The function is
intentionally additive: failures are logged but never block the
outcome — the count and any error string are returned for the caller
to fold into ``metrics``.

Supported artifacts (auto-detected per harness):

* ``eliza``    — any ``*.jsonl`` in the output directory or its
                 ``trajectories/`` subdir whose first line parses as
                 the ``eliza_native_v1`` schema (``format`` key).
* ``openclaw`` — any ``openclaw_*.json`` or ``*_openclaw.json`` file
                 holding the ``{"messages": [...]}`` envelope.
* ``hermes``   — any ``samples.jsonl`` (Atropos rollouts) or other
                 JSONL whose first row has a ``messages`` array using
                 the ShareGPT ``from``/``value`` convention.

If multiple artifacts are found, their normalized entries are
concatenated into a single canonical JSONL file. This matches the
common shape where a benchmark emits one trajectory file per task —
the viewer pages by ``task_id`` anyway.
"""

from __future__ import annotations

import json
import logging
import sys
from pathlib import Path
from typing import Any

# Add benchmarks/lib to sys.path so the normalizer module imports cleanly
# regardless of pytest cwd. The orchestrator already keeps the workspace
# on PYTHONPATH at runtime, but tests can short-circuit that.
_BENCHMARKS_ROOT = Path(__file__).resolve().parents[1]
if str(_BENCHMARKS_ROOT) not in sys.path:
    sys.path.insert(0, str(_BENCHMARKS_ROOT))

from lib.trajectory_normalizer import (  # noqa: E402
    CanonicalEntry,
    normalize_eliza_jsonl,
    normalize_hermes_samples_jsonl,
    normalize_openclaw_response,
    write_canonical_jsonl,
)

logger = logging.getLogger(__name__)


_CANONICAL_FILENAME = "trajectory.canonical.jsonl"


def _is_eliza_jsonl(path: Path) -> bool:
    """Return True if ``path``'s first non-empty line parses as ``eliza_native_v1``."""
    try:
        with path.open("r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                row = json.loads(line)
                if isinstance(row, dict) and row.get("format") == "eliza_native_v1":
                    return True
                return False
    except (OSError, json.JSONDecodeError):
        return False
    return False


def _is_hermes_jsonl(path: Path) -> bool:
    """Return True if ``path``'s first non-empty line uses ShareGPT ``from``/``value``."""
    try:
        with path.open("r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                row = json.loads(line)
                if not isinstance(row, dict):
                    return False
                msgs = row.get("messages")
                if isinstance(msgs, list) and msgs:
                    first = msgs[0]
                    return isinstance(first, dict) and "from" in first and "value" in first
                return False
    except (OSError, json.JSONDecodeError):
        return False
    return False


def _iter_candidates(output_dir: Path) -> list[Path]:
    """Return JSON/JSONL files in ``output_dir`` and immediate subdirs."""
    if not output_dir.exists():
        return []
    seen: set[Path] = set()
    out: list[Path] = []
    for pattern in ("*.json", "*.jsonl", "*/*.json", "*/*.jsonl"):
        for candidate in sorted(output_dir.glob(pattern)):
            if candidate.name == _CANONICAL_FILENAME:
                continue
            if not candidate.is_file():
                continue
            if candidate in seen:
                continue
            seen.add(candidate)
            out.append(candidate)
    return out


def _normalize_one(
    path: Path,
    *,
    harness: str,
    benchmark_id: str,
    task_id: str,
    model: str | None,
) -> list[CanonicalEntry]:
    """Pick the right normalizer for ``path`` given the harness label."""
    name = path.name
    suffix = path.suffix.lower()

    if harness == "eliza":
        if suffix == ".jsonl" and _is_eliza_jsonl(path):
            return normalize_eliza_jsonl(
                path,
                agent_id="eliza",
                benchmark_id=benchmark_id,
                task_id=task_id,
            )
        return []

    if harness == "openclaw":
        if suffix != ".json":
            return []
        if not (name.startswith("openclaw_") or name.endswith("_openclaw.json")):
            return []
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return []
        if not isinstance(data, dict) or "messages" not in data:
            return []
        return normalize_openclaw_response(
            data,
            benchmark_id=benchmark_id,
            task_id=task_id,
            model=model,
        )

    if harness == "hermes":
        if suffix != ".jsonl":
            return []
        if name == "samples.jsonl" or _is_hermes_jsonl(path):
            return normalize_hermes_samples_jsonl(
                path,
                benchmark_id=benchmark_id,
                task_id=task_id,
                model=model,
            )
        return []

    return []


def normalize_outcome_trajectories(
    output_dir: Path,
    *,
    harness: str,
    benchmark_id: str,
    task_id: str,
    model: str | None = None,
) -> tuple[int, str | None, Path | None]:
    """Scan ``output_dir`` for native trajectories and write a canonical file.

    Returns:
        ``(count, error, canonical_path)``. ``count`` is the number of
        canonical entries written (0 on any failure or when no
        matching artifacts are found). ``error`` is a short reason
        string when the count is 0 due to a real failure (parse error,
        IO error); when the count is 0 simply because nothing matched,
        ``error`` is ``None``. ``canonical_path`` is the location of
        the written file, or ``None`` if nothing was written.
    """
    if harness not in {"eliza", "openclaw", "hermes"}:
        return 0, None, None
    if not output_dir.exists():
        return 0, None, None

    all_entries: list[CanonicalEntry] = []
    seen_error: str | None = None

    for candidate in _iter_candidates(output_dir):
        try:
            entries = _normalize_one(
                candidate,
                harness=harness,
                benchmark_id=benchmark_id,
                task_id=task_id,
                model=model,
            )
        except (OSError, json.JSONDecodeError, ValueError) as exc:
            logger.warning(
                "trajectory normalization failed for %s (%s): %s",
                candidate,
                harness,
                exc,
            )
            seen_error = f"{type(exc).__name__}: {exc}"
            continue
        all_entries.extend(entries)

    if not all_entries:
        return 0, seen_error, None

    # Re-index step_index across the merged file so downstream alignment
    # by step uses one contiguous sequence per harness.
    renumbered: list[CanonicalEntry] = []
    for idx, entry in enumerate(all_entries):
        renumbered.append(
            CanonicalEntry(
                format=entry.format,
                boundary=entry.boundary,
                request=entry.request,
                response=entry.response,
                agent_id=entry.agent_id,
                benchmark_id=entry.benchmark_id,
                task_id=entry.task_id,
                step_index=idx,
                timestamp_ms=entry.timestamp_ms,
                model=entry.model,
                scenarioId=entry.scenarioId,
                batchId=entry.batchId,
                metadata=entry.metadata,
                trajectoryTotals=entry.trajectoryTotals,
                cacheStats=entry.cacheStats,
            )
        )

    canonical_path = output_dir / _CANONICAL_FILENAME
    try:
        written = write_canonical_jsonl(renumbered, canonical_path)
    except OSError as exc:
        logger.warning(
            "failed to write canonical trajectory to %s: %s",
            canonical_path,
            exc,
        )
        return 0, f"OSError: {exc}", None

    return written, None, canonical_path


__all__ = ["normalize_outcome_trajectories"]
