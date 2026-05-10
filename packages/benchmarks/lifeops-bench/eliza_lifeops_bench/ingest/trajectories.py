"""Load real elizaOS trajectories from disk for LifeOpsBench evaluation.

elizaOS persists trajectories under
``~/.milady/trajectories/<agentId>/<trajectoryId>.json`` (overridable via
``MILADY_STATE_DIR`` / ``ELIZA_STATE_DIR``). LifeOpsBench can ingest
these as evaluation inputs — for example, to score a model on real user
interactions rather than synthetic scenarios.

Hard rule: every trajectory passes through :func:`apply_privacy_filter`
before this module returns it. There is no opt-out. Strict mode
escalates to :class:`UnredactedCredentialError` if any credential
pattern matches; the default mode silently scrubs and continues.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Iterable

from .privacy import FilterStats, apply_privacy_filter

logger = logging.getLogger(__name__)


class UnredactedCredentialError(RuntimeError):
    """Raised by :func:`load_trajectories_from_disk` in strict mode when an
    unredacted credential is found in an on-disk trajectory.

    Strict mode is meant for CI / preflight checks that should refuse to
    proceed if a credential leak is detected upstream. The message
    includes the trajectory path and which credential labels matched
    (but never the matched value).
    """


def _iter_trajectory_files(directory: Path) -> Iterable[Path]:
    """Yield every ``*.json`` file under ``directory`` recursively, sorted."""
    if not directory.exists():
        return
    for path in sorted(directory.rglob("*.json")):
        if path.is_file():
            yield path


def load_trajectories_from_disk(
    directory: Path,
    *,
    strict: bool = False,
) -> list[dict]:
    """Read every ``*.json`` trajectory under ``directory``, redact, and return.

    The directory layout matches the elizaOS persistence convention
    (``<root>/<agentId>/<trajectoryId>.json``); this function does not
    assume any particular nesting depth and recurses to find every JSON
    file.

    Every trajectory is run through :func:`apply_privacy_filter` before
    being returned. If ``strict=True``, any trajectory whose redaction
    pass produced one or more credential hits is treated as a hard
    error: the function raises :class:`UnredactedCredentialError`
    naming the offending file and the credential labels that matched.

    Files that fail to parse as JSON are logged and skipped — they are
    not propagated. Files that parse but whose top level isn't a dict
    are also skipped (with a log line) since the privacy filter only
    accepts dict-shaped trajectories.
    """
    out: list[dict] = []
    for path in _iter_trajectory_files(directory):
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as exc:
            logger.warning("skipping %s: %s", path, exc)
            continue
        if not isinstance(payload, dict):
            logger.warning("skipping %s: top-level is %s, expected dict", path, type(payload).__name__)
            continue

        cleaned, stats = apply_privacy_filter(payload)
        if strict and stats.credential_hits:
            raise UnredactedCredentialError(
                f"unredacted credential(s) found in {path}: "
                f"{sorted(stats.credential_hits.keys())}"
            )
        out.append(cleaned)
    return out


def load_trajectories_with_stats(
    directory: Path,
) -> tuple[list[dict], FilterStats]:
    """Variant of :func:`load_trajectories_from_disk` that aggregates stats.

    Useful for nightly audits that want a single number for "how many
    redactions did the filter perform across this batch?". Strict mode
    is intentionally not offered here — the strict guard is
    file-by-file in :func:`load_trajectories_from_disk` so the failing
    path is named in the exception.
    """
    aggregate = FilterStats()
    out: list[dict] = []
    for path in _iter_trajectory_files(directory):
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as exc:
            logger.warning("skipping %s: %s", path, exc)
            continue
        if not isinstance(payload, dict):
            continue
        cleaned, stats = apply_privacy_filter(payload)
        aggregate.redaction_count += stats.redaction_count
        aggregate.anonymization_count += stats.anonymization_count
        for label, count in stats.credential_hits.items():
            aggregate.credential_hits[label] = (
                aggregate.credential_hits.get(label, 0) + count
            )
        out.append(cleaned)
    return out, aggregate
