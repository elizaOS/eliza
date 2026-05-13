"""Audit LOCA-bench outputs for trajectory completeness and context behavior."""

from __future__ import annotations

import argparse
from collections import Counter
import json
from pathlib import Path
import re
import sys
from typing import Any


_SECRET_RE = re.compile(
    r"(?i)\b((?:sk|csk)-[a-z0-9_-]{12,}|password\s*[:=]\s*[^\s,;]+|api[_ -]?key\s*[:=]\s*[^\s,;]+)"
)


def _usage_int(usage: dict[str, Any], *keys: str) -> int:
    for key in keys:
        value = usage.get(key)
        if isinstance(value, (int, float)):
            return int(value)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--write", type=Path, default=None)
    parser.add_argument(
        "--include-previews",
        action="store_true",
        help="Include redacted first/last message previews for manual review.",
    )
    parser.add_argument(
        "--allow-empty",
        action="store_true",
        help="Allow an audit of an intentionally empty output directory.",
    )
    parser.add_argument(
        "--review-limit",
        type=int,
        default=20,
        help=(
            "Maximum per-trajectory manual review records to include. "
            "Use 0 to omit them."
        ),
    )
    args = parser.parse_args()

    audit = audit_output_dir(
        args.output_dir,
        include_previews=args.include_previews,
        allow_empty=args.allow_empty,
        review_limit=args.review_limit,
    )
    text = json.dumps(audit, indent=2, ensure_ascii=False, sort_keys=True)
    if args.write:
        args.write.parent.mkdir(parents=True, exist_ok=True)
        args.write.write_text(text + "\n", encoding="utf-8")
    print(text)
    return 1 if audit["summary"]["issue_count"] else 0


def audit_output_dir(
    output_dir: str | Path,
    *,
    include_previews: bool = False,
    allow_empty: bool = False,
    review_limit: int = 20,
) -> dict[str, Any]:
    root = Path(output_dir)
    issues: list[dict[str, Any]] = []

    results_path = root / "results.json"
    all_trajectories_path = root / "all_trajectories.json"
    results = _read_json(results_path)
    all_trajectories = _read_json(all_trajectories_path)
    if not results_path.exists():
        issues.append({"path": "results.json", "issue": "missing_results_json"})
    if not all_trajectories_path.exists():
        issues.append(
            {"path": "all_trajectories.json", "issue": "missing_all_trajectories_json"}
        )

    task_trajectory_paths = sorted((root / "tasks").glob("*/*/trajectory.json"))

    trajectory_records = _flatten_aggregate(all_trajectories)
    per_task_records = []
    for path in task_trajectory_paths:
        data = _read_json(path)
        per_task_records.append((path, data))

    context_events = Counter()
    token_totals = Counter()
    max_prompt_tokens = 0
    max_total_tokens = 0
    message_counts = []
    full_history_counts = []
    sample_records = []
    review_records = []
    failed_trajectory_count = 0

    for path, trajectory in per_task_records:
        label = str(path.relative_to(root))
        _audit_trajectory(
            label=label,
            trajectory=trajectory,
            issues=issues,
            context_events=context_events,
            token_totals=token_totals,
            message_counts=message_counts,
            full_history_counts=full_history_counts,
            sample_records=sample_records,
            include_previews=include_previews,
        )
        prompt_max, total_max = _usage_maxima(trajectory)
        max_prompt_tokens = max(max_prompt_tokens, prompt_max)
        max_total_tokens = max(max_total_tokens, total_max)
        _audit_secret_leaks(label, trajectory, issues)

        task_dir = path.parent
        eval_data = _read_json(task_dir / "eval.json")
        if not (task_dir / "eval.json").exists():
            issues.append({"path": label, "issue": "missing_eval_json"})
        if not (task_dir / "token_stats.json").exists():
            issues.append({"path": label, "issue": "missing_token_stats_json"})
        if _is_failed_eval(eval_data, trajectory):
            failed_trajectory_count += 1
        if review_limit > 0 and len(review_records) < review_limit:
            review_records.append(
                _build_review_record(
                    label=label,
                    trajectory=trajectory,
                    eval_data=eval_data,
                )
            )

    aggregate_count = len(trajectory_records)
    per_task_count = len(per_task_records)
    if aggregate_count == 0 and per_task_count == 0 and not allow_empty:
        issues.append(
            {
                "path": str(root),
                "issue": "empty_output",
                "allow_empty": False,
            }
        )
    if aggregate_count != per_task_count:
        issues.append(
            {
                "path": "all_trajectories.json",
                "issue": "aggregate_count_mismatch",
                "aggregate_count": aggregate_count,
                "per_task_count": per_task_count,
            }
        )

    results_summary = results.get("summary", {}) if isinstance(results, dict) else {}
    results_metadata = results.get("metadata", {}) if isinstance(results, dict) else {}
    total_tasks = results_metadata.get("total_tasks")
    if isinstance(total_tasks, int):
        if aggregate_count != total_tasks:
            issues.append(
                {
                    "path": "all_trajectories.json",
                    "issue": "metadata_total_tasks_mismatch",
                    "metadata_total_tasks": total_tasks,
                    "observed_count": aggregate_count,
                    "source": "aggregate",
                }
            )
        if per_task_count != total_tasks:
            issues.append(
                {
                    "path": "tasks",
                    "issue": "metadata_total_tasks_mismatch",
                    "metadata_total_tasks": total_tasks,
                    "observed_count": per_task_count,
                    "source": "per_task",
                }
            )
    summary_total_api_tokens = results_summary.get("total_api_tokens")
    if not summary_total_api_tokens and token_totals["total_tokens"]:
        summary_total_api_tokens = token_totals["total_tokens"]

    audit = {
        "output_dir": str(root),
        "summary": {
            "trajectory_count": per_task_count,
            "aggregate_trajectory_count": aggregate_count,
            "metadata_total_tasks": total_tasks,
            "issue_count": len(issues),
            "avg_accuracy": results_summary.get("avg_accuracy"),
            "avg_steps": results_summary.get("avg_steps"),
            "avg_tool_calls": results_summary.get("avg_tool_calls"),
            "total_api_tokens": summary_total_api_tokens,
            "max_prompt_tokens": max_prompt_tokens,
            "max_total_tokens": max_total_tokens,
            "avg_message_count": _mean(message_counts),
            "avg_full_history_count": _mean(full_history_counts),
            "failed_trajectory_count": failed_trajectory_count,
        },
        "context_events": dict(context_events),
        "token_totals": dict(token_totals),
        "issues": issues,
    }
    if include_previews:
        audit["previews"] = sample_records[:10]
    if review_limit > 0:
        audit["review_records"] = review_records
    return audit


def _audit_trajectory(
    *,
    label: str,
    trajectory: dict[str, Any],
    issues: list[dict[str, Any]],
    context_events: Counter,
    token_totals: Counter,
    message_counts: list[int],
    full_history_counts: list[int],
    sample_records: list[dict[str, Any]],
    include_previews: bool,
) -> None:
    if not isinstance(trajectory, dict):
        issues.append({"path": label, "issue": "trajectory_not_json_object"})
        return

    if trajectory.get("schema_version") != "loca_traj_v1":
        issues.append(
            {
                "path": label,
                "issue": "unexpected_or_missing_schema_version",
                "schema_version": trajectory.get("schema_version"),
            }
        )

    conversation = trajectory.get("conversation", {})
    messages = conversation.get("messages", trajectory.get("messages", []))
    full_history = conversation.get("full_messages_history", [])
    if not messages:
        issues.append({"path": label, "issue": "missing_current_messages"})
    if not full_history:
        issues.append({"path": label, "issue": "missing_full_messages_history"})
    message_counts.append(len(messages) if isinstance(messages, list) else 0)
    full_history_counts.append(len(full_history) if isinstance(full_history, list) else 0)

    if _has_unpaired_tool_result(messages if isinstance(messages, list) else []):
        issues.append(
            {"path": label, "issue": "unpaired_tool_call_or_result", "scope": "messages"}
        )
    if _has_unpaired_tool_result(full_history if isinstance(full_history, list) else []):
        issues.append(
            {
                "path": label,
                "issue": "unpaired_tool_call_or_result",
                "scope": "full_messages_history",
            }
        )

    eliza_metadata = _collect_eliza_metadata(full_history if isinstance(full_history, list) else [])
    context_events["eliza_metadata"] += len(eliza_metadata)
    _audit_eliza_metadata(label, eliza_metadata, issues)

    provider_payload = trajectory.get("provider_payload", {})
    usage_tracking = provider_payload.get("usage_tracking", [])
    if not usage_tracking and not provider_payload.get("error"):
        issues.append({"path": label, "issue": "missing_usage_tracking"})
    for usage in usage_tracking if isinstance(usage_tracking, list) else []:
        token_totals["prompt_tokens"] += _usage_int(
            usage,
            "prompt_tokens",
            "promptTokens",
        )
        token_totals["completion_tokens"] += _usage_int(
            usage,
            "completion_tokens",
            "completionTokens",
        )
        token_totals["total_tokens"] += _usage_int(
            usage,
            "total_tokens",
            "totalTokens",
        )

    events = trajectory.get("events", {})
    for key in ("reset", "summary", "summary_skip", "trim", "thinking_reset"):
        value = events.get(key, [])
        context_events[key] += len(value) if isinstance(value, list) else 0
    _audit_summary_events(label, events.get("summary", []), issues)

    if include_previews:
        sample_records.append(
            {
                "path": label,
                "first_message": _message_preview(messages, 0),
                "last_message": _message_preview(messages, -1),
                "last_full_history_message": _message_preview(full_history, -1),
            }
        )


def _flatten_aggregate(data: Any) -> list[dict[str, Any]]:
    if isinstance(data, list):
        return [item for item in data if isinstance(item, dict)]
    if not isinstance(data, dict):
        return []
    if isinstance(data.get("trajectories"), list):
        return [item for item in data["trajectories"] if isinstance(item, dict)]
    records = []
    for states in data.values():
        if isinstance(states, dict):
            for trajectory in states.values():
                if isinstance(trajectory, dict):
                    records.append(trajectory)
    return records


def _is_failed_eval(eval_data: Any, trajectory: dict[str, Any]) -> bool:
    if isinstance(eval_data, dict):
        status = str(eval_data.get("status", "")).strip().lower()
        if status in {"error", "failed", "failure", "truncated"}:
            return True
        accuracy = eval_data.get("accuracy")
        if isinstance(accuracy, (int, float)) and float(accuracy) < 1.0:
            return True
    metrics = trajectory.get("metrics", {})
    if isinstance(metrics, dict):
        status = str(metrics.get("status", "")).strip().lower()
        if status in {"error", "failed", "failure", "truncated"}:
            return True
        accuracy = metrics.get("accuracy")
        if isinstance(accuracy, (int, float)) and float(accuracy) < 1.0:
            return True
    return False


def _build_review_record(
    *,
    label: str,
    trajectory: dict[str, Any],
    eval_data: Any,
) -> dict[str, Any]:
    conversation = trajectory.get("conversation", {})
    messages = conversation.get("messages", trajectory.get("messages", []))
    full_history = conversation.get("full_messages_history", [])
    events = trajectory.get("events", {})
    metrics = (
        trajectory.get("metrics", {})
        if isinstance(trajectory.get("metrics"), dict)
        else {}
    )
    eval_obj = eval_data if isinstance(eval_data, dict) else {}
    return {
        "path": label,
        "task": trajectory.get("task", {}),
        "status": eval_obj.get("status") or metrics.get("status"),
        "accuracy": eval_obj.get("accuracy", metrics.get("accuracy")),
        "scoring_reason": _scoring_reason(eval_obj, metrics),
        "expected_answer": _expected_answer(eval_obj, trajectory),
        "model_input": _last_message_preview(messages, "user")
        or _last_message_preview(full_history, "user"),
        "model_output": _last_message_preview(messages, "assistant")
        or _last_message_preview(full_history, "assistant"),
        "last_full_history_message": _message_preview(full_history, -1),
        "compaction_events": _compaction_event_summary(events),
        "provider_usage": _usage_summary(trajectory),
    }


def _scoring_reason(eval_data: dict[str, Any], metrics: dict[str, Any]) -> str | None:
    for key in ("feedback", "reason", "scoring_reason", "error", "stop_reason"):
        value = eval_data.get(key)
        if value:
            return _short_string(value)
    for key in ("status", "stop_reason", "error"):
        value = metrics.get(key)
        if value:
            return _short_string(value)
    return None


def _expected_answer(eval_data: dict[str, Any], trajectory: dict[str, Any]) -> Any:
    for key in (
        "expected_answer",
        "expected",
        "ground_truth",
        "correct_answer",
        "answer_key",
    ):
        value = eval_data.get(key)
        if value not in (None, "", []):
            return _redact_json(value)
    long_context = trajectory.get("metadata", {}).get("long_context", {})
    if isinstance(long_context, dict):
        needles = long_context.get("needles", [])
        records = long_context.get("records", [])
        preserved_records = [
            record
            for record in records
            if isinstance(record, dict) and record.get("should_preserve") is True
        ] if isinstance(records, list) else []
        if needles or preserved_records:
            return {
                "kind": "long_context_exact_values",
                "needle_count": len(needles) if isinstance(needles, list) else 0,
                "preserved_record_count": len(preserved_records),
                "sample_needles": _redact_json(needles[:3] if isinstance(needles, list) else []),
                "sample_preserved_records": _redact_json(preserved_records[:3]),
            }
    return None


def _compaction_event_summary(events: Any) -> dict[str, Any]:
    if not isinstance(events, dict):
        return {}
    summary: dict[str, Any] = {}
    for key in ("summary", "summary_skip", "trim", "reset", "thinking_reset"):
        value = events.get(key, [])
        count = len(value) if isinstance(value, list) else 0
        summary[f"{key}_count"] = count
        if isinstance(value, list) and value:
            summary[f"last_{key}"] = _compact_event_preview(value[-1])
    return summary


def _compact_event_preview(event: Any) -> Any:
    if not isinstance(event, dict):
        return _redact_json(event)
    preview: dict[str, Any] = {}
    for key, value in event.items():
        if key in {"summary_tail", "summary_user_message", "summary_response_original"}:
            if isinstance(value, list):
                preview[key] = {
                    "count": len(value),
                    "first": _message_preview(value, 0),
                    "last": _message_preview(value, -1),
                }
            elif isinstance(value, dict):
                preview[key] = _message_preview([value], 0)
            else:
                preview[key] = _redact_json(value)
            continue
        preview[key] = _redact_json(value)
    return preview


def _usage_summary(trajectory: dict[str, Any]) -> dict[str, int]:
    usage = trajectory.get("provider_payload", {}).get("usage_tracking", [])
    if not isinstance(usage, list):
        return {}
    return {
        "call_count": len([item for item in usage if isinstance(item, dict)]),
        "max_prompt_tokens": max(
            [
                _usage_int(item, "prompt_tokens", "promptTokens")
                for item in usage
                if isinstance(item, dict)
            ]
            or [0]
        ),
        "max_total_tokens": max(
            [
                _usage_int(item, "total_tokens", "totalTokens")
                for item in usage
                if isinstance(item, dict)
            ]
            or [0]
        ),
        "total_tokens": sum(
            _usage_int(item, "total_tokens", "totalTokens")
            for item in usage
            if isinstance(item, dict)
        ),
    }


def _usage_maxima(trajectory: dict[str, Any]) -> tuple[int, int]:
    usage = trajectory.get("provider_payload", {}).get("usage_tracking", [])
    if not isinstance(usage, list):
        return 0, 0
    max_prompt = 0
    max_total = 0
    for item in usage:
        if not isinstance(item, dict):
            continue
        max_prompt = max(max_prompt, _usage_int(item, "prompt_tokens", "promptTokens"))
        max_total = max(max_total, _usage_int(item, "total_tokens", "totalTokens"))
    return max_prompt, max_total


def _audit_secret_leaks(
    label: str,
    data: Any,
    issues: list[dict[str, Any]],
) -> None:
    for json_path, value in _walk_json_strings(data):
        if _SECRET_RE.search(value):
            issues.append(
                {
                    "path": label,
                    "issue": "secret_leak_detected",
                    "json_path": json_path,
                }
            )


def _walk_json_strings(data: Any, prefix: str = "$") -> list[tuple[str, str]]:
    if isinstance(data, str):
        return [(prefix, data)]
    if isinstance(data, list):
        values = []
        for index, item in enumerate(data):
            values.extend(_walk_json_strings(item, f"{prefix}[{index}]"))
        return values
    if isinstance(data, dict):
        values = []
        for key, item in data.items():
            values.extend(_walk_json_strings(item, f"{prefix}.{key}"))
        return values
    return []


def _audit_summary_events(
    label: str,
    summary_events: Any,
    issues: list[dict[str, Any]],
) -> None:
    if summary_events in (None, []):
        return
    if not isinstance(summary_events, list):
        issues.append({"path": label, "issue": "summary_events_not_list"})
        return
    for index, event in enumerate(summary_events):
        event_path = f"events.summary[{index}]"
        if not isinstance(event, dict):
            issues.append(
                {"path": label, "issue": "summary_event_not_object", "event_path": event_path}
            )
            continue

        before_count = event.get("messages_before_count")
        after_count = event.get("messages_after_count")
        if before_count is not None and after_count is not None:
            if not isinstance(before_count, int) or not isinstance(after_count, int):
                issues.append(
                    {
                        "path": label,
                        "issue": "summary_event_invalid_message_counts",
                        "event_path": event_path,
                    }
                )
            elif after_count > before_count:
                issues.append(
                    {
                        "path": label,
                        "issue": "summary_event_message_count_increased",
                        "event_path": event_path,
                        "messages_before_count": before_count,
                        "messages_after_count": after_count,
                    }
                )

        summary_user_message = event.get("summary_user_message")
        if isinstance(summary_user_message, dict) and summary_user_message.get("role") != "user":
            issues.append(
                {
                    "path": label,
                    "issue": "summary_event_invalid_summary_user_role",
                    "event_path": event_path,
                    "role": summary_user_message.get("role"),
                }
            )

        summary_response = event.get("summary_response_original")
        if isinstance(summary_response, dict) and summary_response.get("role") != "assistant":
            issues.append(
                {
                    "path": label,
                    "issue": "summary_event_invalid_summary_response_role",
                    "event_path": event_path,
                    "role": summary_response.get("role"),
                }
            )

        summary_tail = event.get("summary_tail")
        summary_tail_count = event.get("summary_tail_count")
        if isinstance(summary_tail, list) and summary_tail_count is not None:
            if summary_tail_count != len(summary_tail):
                issues.append(
                    {
                        "path": label,
                        "issue": "summary_event_tail_count_mismatch",
                        "event_path": event_path,
                        "summary_tail_count": summary_tail_count,
                        "observed_count": len(summary_tail),
                    }
                )


def _has_unpaired_tool_result(messages: list[Any]) -> bool:
    pending: set[str] = set()
    seen_results: set[str] = set()
    for message in messages:
        if not isinstance(message, dict):
            continue
        for call in message.get("tool_calls", []) or []:
            if isinstance(call, dict) and call.get("id"):
                pending.add(str(call["id"]))
        if message.get("role") == "tool":
            tool_call_id = message.get("tool_call_id")
            if tool_call_id:
                seen_results.add(str(tool_call_id))
    return bool((pending - seen_results) or (seen_results - pending))


def _collect_eliza_metadata(messages: list[Any]) -> list[dict[str, Any]]:
    metadata: list[dict[str, Any]] = []
    for message in messages:
        if not isinstance(message, dict):
            continue
        raw = message.get("metadata")
        if isinstance(raw, dict) and raw.get("agent_label") == "eliza":
            metadata.append(raw)
    return metadata


def _audit_eliza_metadata(
    label: str,
    metadata_records: list[dict[str, Any]],
    issues: list[dict[str, Any]],
) -> None:
    required = {
        "benchmark",
        "task_id",
        "trajectory_step",
        "trajectory_endpoint",
        "diagnostics_endpoint",
        "tool_schema_count",
        "tool_names",
    }
    for index, metadata in enumerate(metadata_records):
        missing = sorted(key for key in required if key not in metadata)
        if missing:
            issues.append(
                {
                    "path": label,
                    "issue": "eliza_metadata_missing_fields",
                    "metadata_index": index,
                    "missing": missing,
                }
            )
        if metadata.get("agent_label") != "eliza":
            issues.append(
                {
                    "path": label,
                    "issue": "eliza_metadata_wrong_agent_label",
                    "metadata_index": index,
                    "agent_label": metadata.get("agent_label"),
                }
            )


def _message_preview(messages: Any, index: int) -> dict[str, Any] | None:
    if not isinstance(messages, list) or not messages:
        return None
    try:
        message = messages[index]
    except IndexError:
        return None
    if not isinstance(message, dict):
        return {"type": type(message).__name__}
    content = message.get("content", "")
    if not isinstance(content, str):
        content = json.dumps(content, ensure_ascii=False)[:1000]
    return {
        "role": message.get("role"),
        "content_preview": _redact(content[:500]),
        "content_length": len(content),
        "tool_call_count": len(message.get("tool_calls", []) or []),
    }


def _last_message_preview(messages: Any, role: str) -> dict[str, Any] | None:
    if not isinstance(messages, list):
        return None
    for message in reversed(messages):
        if isinstance(message, dict) and message.get("role") == role:
            return _message_preview([message], 0)
    return None


def _redact(text: str) -> str:
    return _SECRET_RE.sub("[REDACTED]", text)


def _redact_json(value: Any) -> Any:
    if isinstance(value, str):
        return _redact(value)
    if isinstance(value, list):
        return [_redact_json(item) for item in value]
    if isinstance(value, dict):
        return {str(key): _redact_json(item) for key, item in value.items()}
    return value


def _short_string(value: Any) -> str:
    if isinstance(value, str):
        text = value
    else:
        text = json.dumps(value, ensure_ascii=False, sort_keys=True)
    return _redact(text[:1000])


def _read_json(path: Path) -> Any:
    if not path.exists():
        return {}
    with path.open("r", encoding="utf-8") as fh:
        return json.load(fh)


def _mean(values: list[int]) -> float | None:
    if not values:
        return None
    return round(sum(values) / len(values), 2)


if __name__ == "__main__":
    sys.exit(main())
