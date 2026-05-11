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


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--write", type=Path, default=None)
    parser.add_argument(
        "--include-previews",
        action="store_true",
        help="Include redacted first/last message previews for manual review.",
    )
    args = parser.parse_args()

    audit = audit_output_dir(args.output_dir, include_previews=args.include_previews)
    text = json.dumps(audit, indent=2, ensure_ascii=False, sort_keys=True)
    if args.write:
        args.write.parent.mkdir(parents=True, exist_ok=True)
        args.write.write_text(text + "\n", encoding="utf-8")
    print(text)
    return 1 if audit["summary"]["issue_count"] else 0


def audit_output_dir(output_dir: str | Path, *, include_previews: bool = False) -> dict[str, Any]:
    root = Path(output_dir)
    results = _read_json(root / "results.json")
    all_trajectories = _read_json(root / "all_trajectories.json")
    task_trajectory_paths = sorted((root / "tasks").glob("*/*/trajectory.json"))

    trajectory_records = _flatten_aggregate(all_trajectories)
    per_task_records = []
    for path in task_trajectory_paths:
        data = _read_json(path)
        per_task_records.append((path, data))

    issues: list[dict[str, Any]] = []
    context_events = Counter()
    token_totals = Counter()
    max_prompt_tokens = 0
    max_total_tokens = 0
    message_counts = []
    full_history_counts = []
    sample_records = []

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

        task_dir = path.parent
        if not (task_dir / "eval.json").exists():
            issues.append({"path": label, "issue": "missing_eval_json"})
        if not (task_dir / "token_stats.json").exists():
            issues.append({"path": label, "issue": "missing_token_stats_json"})

    aggregate_count = len(trajectory_records)
    per_task_count = len(per_task_records)
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
    audit = {
        "output_dir": str(root),
        "summary": {
            "trajectory_count": per_task_count,
            "aggregate_trajectory_count": aggregate_count,
            "issue_count": len(issues),
            "avg_accuracy": results_summary.get("avg_accuracy"),
            "avg_steps": results_summary.get("avg_steps"),
            "avg_tool_calls": results_summary.get("avg_tool_calls"),
            "total_api_tokens": results_summary.get("total_api_tokens"),
            "max_prompt_tokens": max_prompt_tokens,
            "max_total_tokens": max_total_tokens,
            "avg_message_count": _mean(message_counts),
            "avg_full_history_count": _mean(full_history_counts),
        },
        "context_events": dict(context_events),
        "token_totals": dict(token_totals),
        "issues": issues,
    }
    if include_previews:
        audit["previews"] = sample_records[:10]
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

    if _has_unpaired_tool_result(full_history if isinstance(full_history, list) else []):
        issues.append({"path": label, "issue": "unpaired_tool_call_or_result"})

    provider_payload = trajectory.get("provider_payload", {})
    usage_tracking = provider_payload.get("usage_tracking", [])
    if not usage_tracking:
        issues.append({"path": label, "issue": "missing_usage_tracking"})
    for usage in usage_tracking if isinstance(usage_tracking, list) else []:
        token_totals["prompt_tokens"] += int(usage.get("prompt_tokens", 0) or 0)
        token_totals["completion_tokens"] += int(usage.get("completion_tokens", 0) or 0)
        token_totals["total_tokens"] += int(usage.get("total_tokens", 0) or 0)

    events = trajectory.get("events", {})
    for key in ("reset", "summary", "summary_skip", "trim", "thinking_reset"):
        value = events.get(key, [])
        context_events[key] += len(value) if isinstance(value, list) else 0

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
    if not isinstance(data, dict):
        return []
    records = []
    for states in data.values():
        if isinstance(states, dict):
            for trajectory in states.values():
                if isinstance(trajectory, dict):
                    records.append(trajectory)
    return records


def _usage_maxima(trajectory: dict[str, Any]) -> tuple[int, int]:
    usage = trajectory.get("provider_payload", {}).get("usage_tracking", [])
    if not isinstance(usage, list):
        return 0, 0
    max_prompt = 0
    max_total = 0
    for item in usage:
        if not isinstance(item, dict):
            continue
        max_prompt = max(max_prompt, int(item.get("prompt_tokens", 0) or 0))
        max_total = max(max_total, int(item.get("total_tokens", 0) or 0))
    return max_prompt, max_total


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


def _redact(text: str) -> str:
    return _SECRET_RE.sub("[REDACTED]", text)


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
