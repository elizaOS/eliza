"""Dataset loader for VoiceAgentBench.

The canonical dataset is hosted on Hugging Face under
``ServiceNow-AI/VoiceAgentBench`` per the paper
(https://arxiv.org/html/2510.07978v1). The loader supports three
sources, in priority order:

  1. ``--data-path /path/to/local.jsonl`` - explicit local override.
  2. Hugging Face datasets pull.
"""

from __future__ import annotations

import base64
import json
import os
from pathlib import Path
from typing import Any, Iterable

from .types import (
    AudioQuery,
    SafetyVerdict,
    Suite,
    ToolCallExpectation,
    VoiceTask,
)

HF_REPO = "ServiceNow-AI/VoiceAgentBench"


class DatasetError(RuntimeError):
    """Raised when a dataset source produces malformed records."""


def _coerce_suite(raw: str) -> Suite:
    try:
        return Suite(raw)
    except ValueError as exc:
        raise DatasetError(f"unknown suite '{raw}'") from exc


def _coerce_safety(raw: str | None) -> SafetyVerdict | None:
    if raw is None:
        return None
    try:
        return SafetyVerdict(raw)
    except ValueError as exc:
        raise DatasetError(f"unknown safety verdict '{raw}'") from exc


def _record_to_task(rec: dict[str, Any]) -> VoiceTask:
    """Convert one JSONL record to a :class:`VoiceTask`."""
    queries: list[AudioQuery] = []
    for q in rec.get("queries", []):
        audio_bytes: bytes | None = None
        b64 = q.get("audio_b64")
        if isinstance(b64, str) and b64:
            audio_bytes = base64.b64decode(b64)
        queries.append(
            AudioQuery(
                audio_bytes=audio_bytes,
                transcript=str(q["transcript"]),
                language=str(q.get("language") or "en"),
                speaker_id=q.get("speaker_id"),
            )
        )

    expectations: list[ToolCallExpectation] = []
    for exp in rec.get("expected_tool_calls", []):
        expectations.append(
            ToolCallExpectation(
                tool_name=str(exp["tool_name"]),
                required_params=dict(exp.get("required_params") or {}),
                substring_params={
                    str(k): str(v)
                    for k, v in (exp.get("substring_params") or {}).items()
                },
                order=exp.get("order"),
            )
        )

    return VoiceTask(
        task_id=str(rec["task_id"]),
        suite=_coerce_suite(str(rec["suite"])),
        queries=queries,
        expected_tool_calls=expectations,
        tool_manifest=list(rec.get("tool_manifest") or []),
        safety_verdict=_coerce_safety(rec.get("safety_verdict")),
        expected_response_substrings=list(
            rec.get("expected_response_substrings") or []
        ),
        description=str(rec.get("description") or ""),
    )


def load_jsonl(path: Path) -> list[VoiceTask]:
    if not path.is_file():
        raise DatasetError(f"dataset file not found: {path}")
    tasks: list[VoiceTask] = []
    with path.open("r", encoding="utf-8") as fh:
        for line_no, raw in enumerate(fh, start=1):
            stripped = raw.strip()
            if not stripped:
                continue
            try:
                rec = json.loads(stripped)
            except json.JSONDecodeError as exc:
                raise DatasetError(
                    f"invalid JSON at {path}:{line_no}: {exc}"
                ) from exc
            tasks.append(_record_to_task(rec))
    return tasks


def load_from_huggingface() -> list[VoiceTask]:
    """Pull the canonical dataset from Hugging Face (lazy import)."""
    try:
        from datasets import load_dataset  # type: ignore[import-not-found]
    except ImportError as exc:
        raise DatasetError(
            "Real VoiceAgentBench runs require the `datasets` package. "
            "Install it (`pip install datasets`) and authenticate to Hugging Face "
            "if the dataset is gated."
        ) from exc

    repo = os.environ.get("VOICEAGENTBENCH_HF_REPO") or HF_REPO
    ds = load_dataset(repo, split="test")
    tasks: list[VoiceTask] = []
    for rec in ds:
        tasks.append(_record_to_task(dict(rec)))
    return tasks


def load_tasks(
    *,
    data_path: Path | None = None,
    suite_filter: Suite | None = None,
    limit: int | None = None,
) -> list[VoiceTask]:
    """Load tasks from the configured source, optionally filtered."""
    if data_path is not None:
        tasks = load_jsonl(data_path)
    else:
        tasks = load_from_huggingface()

    if suite_filter is not None:
        tasks = [t for t in tasks if t.suite == suite_filter]

    if limit is not None and limit > 0:
        tasks = tasks[:limit]

    return tasks


def filter_suites(
    tasks: Iterable[VoiceTask], suites: list[Suite] | None
) -> list[VoiceTask]:
    if suites is None:
        return list(tasks)
    keep = set(suites)
    return [t for t in tasks if t.suite in keep]
