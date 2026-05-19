"""Dataset loader for VoiceAgentBench.

The canonical dataset is hosted on Hugging Face under
``krutrim-ai-labs/VoiceAgentBench``. The loader supports two sources,
in priority order:

  1. ``--data-path /path/to/local.jsonl`` - explicit local override.
  2. Hugging Face Hub task JSON + audio files.
"""

from __future__ import annotations

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

HF_REPO = "krutrim-ai-labs/VoiceAgentBench"

HF_SUITE_FILES: dict[Suite, str] = {
    Suite.SINGLE: "data/single_tool_data/english/single_tool_english.json",
    Suite.PARALLEL: "data/parallel_tool_data/english/parallel_tool_english.json",
    Suite.SEQUENTIAL: "data/seqdep_tool_data/english/seqdep_tool_english.json",
    Suite.MULTI_TURN: "data/multi_turn_data/english/multi_turn_english.json",
    Suite.SAFETY: "data/safety_data/english/safety_english.json",
    Suite.MULTILINGUAL: "data/single_tool_data/hindi/single_tool_hindi.json",
}


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


def _tool_manifest(raw: Any) -> list[dict[str, Any]]:
    if isinstance(raw, list):
        out: list[dict[str, Any]] = []
        for item in raw:
            if isinstance(item, dict):
                out.append(item)
            elif isinstance(item, str):
                out.append({"name": item, "parameters": {"type": "dict", "properties": {}}})
        return out
    return []


def _expectations(raw: Any) -> list[ToolCallExpectation]:
    expectations: list[ToolCallExpectation] = []
    if not isinstance(raw, list):
        return expectations
    for idx, item in enumerate(raw):
        if not isinstance(item, dict):
            continue
        for tool_name, params in item.items():
            required: dict[str, Any] = {}
            substrings: dict[str, str] = {}
            if isinstance(params, dict):
                for key, value in params.items():
                    if isinstance(value, list) and value:
                        substrings[str(key)] = str(value[0])
                    else:
                        required[str(key)] = value
            expectations.append(
                ToolCallExpectation(
                    tool_name=str(tool_name),
                    required_params=required,
                    substring_params=substrings,
                    order=idx,
                )
            )
    return expectations


def _audio_query_from_hf(
    *,
    repo: str,
    audio_path: str,
    transcript: str,
    language: str = "en",
) -> AudioQuery:
    from huggingface_hub import hf_hub_download  # type: ignore[import-not-found]

    local_audio = hf_hub_download(repo, audio_path, repo_type="dataset")
    return AudioQuery(
        audio_bytes=Path(local_audio).read_bytes(),
        transcript=transcript,
        language=language,
    )


def _hf_row_to_task(rec: dict[str, Any], suite: Suite, repo: str) -> VoiceTask:
    task_id = str(rec.get("id") or rec.get("task_id") or "")
    if not task_id:
        raise DatasetError(f"VoiceAgentBench HF row missing id: {rec!r}")

    if suite == Suite.MULTI_TURN:
        queries = []
        for turn in rec.get("chat_history") or []:
            if not isinstance(turn, dict) or turn.get("role") != "user":
                continue
            path = turn.get("path")
            if not isinstance(path, str) or not path:
                raise DatasetError(f"VoiceAgentBench multi-turn user row missing audio path: {turn!r}")
            queries.append(
                _audio_query_from_hf(
                    repo=repo,
                    audio_path=path,
                    transcript=str(turn.get("content") or ""),
                )
            )
    else:
        transcript = str(rec.get("query") or rec.get("user_request") or "")
        path = rec.get("path")
        if not isinstance(path, str) or not path:
            raise DatasetError(f"VoiceAgentBench row {task_id!r} missing audio path")
        language = "hi" if suite == Suite.MULTILINGUAL else "en"
        queries = [
            _audio_query_from_hf(
                repo=repo,
                audio_path=path,
                transcript=transcript,
                language=language,
            )
        ]

    if not queries:
        raise DatasetError(f"VoiceAgentBench row {task_id!r} produced no audio queries")

    safety = SafetyVerdict.MUST_REFUSE if suite == Suite.SAFETY else None
    return VoiceTask(
        task_id=task_id,
        suite=suite,
        queries=queries,
        expected_tool_calls=[] if suite == Suite.SAFETY else _expectations(rec.get("expected_tool_call")),
        tool_manifest=_tool_manifest(rec.get("functions")),
        safety_verdict=safety,
        expected_response_substrings=[],
        description=str(rec.get("query") or rec.get("user_request") or rec.get("description") or ""),
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


def load_from_huggingface(
    *,
    suite_filter: Suite | None = None,
    limit: int | None = None,
) -> list[VoiceTask]:
    """Pull the canonical dataset from Hugging Face Hub (lazy imports)."""
    try:
        from huggingface_hub import hf_hub_download  # type: ignore[import-not-found]
    except ImportError as exc:
        raise DatasetError(
            "Real VoiceAgentBench runs require `huggingface_hub` to fetch "
            "the upstream task JSON and audio files."
        ) from exc

    repo = os.environ.get("VOICEAGENTBENCH_HF_REPO") or HF_REPO
    tasks: list[VoiceTask] = []
    suite_items = (
        [(suite_filter, HF_SUITE_FILES[suite_filter])]
        if suite_filter is not None
        else list(HF_SUITE_FILES.items())
    )
    for suite, repo_path in suite_items:
        local_json = hf_hub_download(repo, repo_path, repo_type="dataset")
        rows = json.loads(Path(local_json).read_text(encoding="utf-8"))
        if not isinstance(rows, list):
            raise DatasetError(f"VoiceAgentBench HF file {repo_path} is not a list")
        for rec in rows:
            if isinstance(rec, dict):
                tasks.append(_hf_row_to_task(rec, suite, repo))
                if limit is not None and len(tasks) >= limit:
                    return tasks
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
        tasks = load_from_huggingface(suite_filter=suite_filter, limit=limit)

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
