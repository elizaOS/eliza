"""Synthetic long-context LOCA trajectory fixtures.

The live LOCA debug task is useful, but it is too short to catch deep
compaction regressions. This module generates deterministic LOCA-shaped
trajectories with needles buried across very long histories, then builds a
summary+tail compacted view and audits whether every needle survives.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import json
from pathlib import Path
import sys
from typing import Any


APPROX_CHARS_PER_TOKEN = 4
SCHEMA_VERSION = "loca_traj_v1"
CONTEXT_TIERS = {
    "128k": 128 * 1024,
    "256k": 256 * 1024,
    "512k": 512 * 1024,
    "1m": 1_000_000,
}
DEFAULT_CURRENT_TOKEN_RATIO = 0.08
DEFAULT_MAX_CURRENT_TOKENS = 64_000


@dataclass(frozen=True)
class Needle:
    key: str
    value: str
    turn: int


@dataclass(frozen=True)
class LongContextRecord:
    key: str
    value: str
    turn: int
    kind: str
    should_preserve: bool


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument(
        "--tier",
        choices=tuple(CONTEXT_TIERS),
        default="1m",
        help="Preset target context tier. --target-tokens overrides this value.",
    )
    parser.add_argument("--target-tokens", type=int)
    parser.add_argument("--turns", type=int, default=400)
    parser.add_argument("--needle-count", type=int, default=32)
    parser.add_argument("--tail-messages", type=int, default=16)
    parser.add_argument(
        "--summary-mode",
        choices=("perfect", "lossy", "corrupt"),
        default="perfect",
        help=(
            "perfect preserves every audited value as a fixture sanity check; "
            "lossy/corrupt intentionally drops and mutates values so the audit fails."
        ),
    )
    parser.add_argument(
        "--max-current-token-ratio",
        type=float,
        default=DEFAULT_CURRENT_TOKEN_RATIO,
        help="Fail audit if compacted current tokens exceed this fraction of full history.",
    )
    parser.add_argument(
        "--max-current-tokens",
        type=int,
        default=DEFAULT_MAX_CURRENT_TOKENS,
        help="Fail audit if compacted current tokens exceed this absolute token estimate.",
    )
    parser.add_argument("--no-compact", action="store_true")
    args = parser.parse_args()

    if args.target_tokens is not None:
        target_tokens = args.target_tokens
    else:
        target_tokens = CONTEXT_TIERS[args.tier]
    trajectory = build_long_context_trajectory(
        target_tokens=target_tokens,
        tier=args.tier,
        turns=args.turns,
        needle_count=args.needle_count,
    )
    if not args.no_compact:
        trajectory = compact_with_summary_tail(
            trajectory,
            tail_messages=args.tail_messages,
            summary_mode=args.summary_mode,
        )

    audit = audit_long_context_trajectory(
        trajectory,
        max_current_token_ratio=args.max_current_token_ratio,
        max_current_tokens=args.max_current_tokens,
    )
    write_loca_output(args.output_dir, trajectory, audit=audit)
    (args.output_dir / "long_context_audit.json").write_text(
        json.dumps(audit, indent=2, ensure_ascii=False, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(audit, indent=2, ensure_ascii=False, sort_keys=True))
    return 1 if audit["failure_count"] else 0


def build_long_context_trajectory(
    *,
    target_tokens: int = 1_000_000,
    tier: str | None = None,
    turns: int = 400,
    needle_count: int = 32,
) -> dict[str, Any]:
    if target_tokens <= 0:
        raise ValueError("target_tokens must be positive")
    if turns < 4:
        raise ValueError("turns must be at least 4")
    if needle_count <= 0:
        raise ValueError("needle_count must be positive")

    needles = _make_needles(needle_count, turns)
    records = _make_context_records(needles, turns)
    needles_by_turn = {needle.turn: needle for needle in needles}
    records_by_turn: dict[int, list[LongContextRecord]] = {}
    for record in records:
        records_by_turn.setdefault(record.turn, []).append(record)
    filler_chars = max(128, (target_tokens * APPROX_CHARS_PER_TOKEN) // turns)
    filler = _filler(filler_chars)

    full_history: list[dict[str, Any]] = []
    for turn in range(turns):
        needle = needles_by_turn.get(turn)
        turn_records = records_by_turn.get(turn, [])
        record_block = _format_records(turn_records)
        if needle:
            content = (
                f"Turn {turn}: source observation.\n"
                f"LOCA_LONG_CONTEXT_NEEDLE {needle.key}: {needle.value}\n"
                f"{record_block}"
                f"{filler}"
            )
        elif record_block:
            content = f"Turn {turn}: context update.\n{record_block}{filler}"
        else:
            content = f"Turn {turn}: routine working context.\n{filler}"
        message: dict[str, Any] = {
            "role": "user" if turn % 2 == 0 else "assistant",
            "content": content,
        }
        if turn_records and turn % 7 == 0:
            call_id = f"call_loca_probe_{turn:04d}"
            message = {
                "role": "assistant",
                "content": content,
                "tool_calls": [
                    {
                        "id": call_id,
                        "type": "function",
                        "function": {
                            "name": "observe_loca_state",
                            "arguments": json.dumps(
                                {
                                    "turn": turn,
                                    "record_keys": [record.key for record in turn_records],
                                },
                                separators=(",", ":"),
                            ),
                        },
                    }
                ],
            }
            full_history.append(message)
            full_history.append(
                {
                    "role": "tool",
                    "tool_call_id": call_id,
                    "content": (
                        "TOOL_OBSERVATION audit="
                        + ";".join(record.value for record in turn_records)
                    ),
                }
            )
            continue
        full_history.append(message)

    current_messages = [
        {
            "role": "user",
            "content": (
                "Continue the long-running LOCA task. Recall every "
                "LOCA_LONG_CONTEXT_NEEDLE exactly when asked."
            ),
        },
        *full_history[-12:],
    ]

    estimated_full_tokens = estimate_messages_tokens(full_history)
    return {
        "schema_version": SCHEMA_VERSION,
        "backend": "synthetic",
        "task": {
            "task_id": "long_context_needles",
            "config_id": f"synthetic_{tier or target_tokens}",
            "run_id": 0,
            "config_name": "LongContextNeedles",
        },
        "conversation": {
            "messages": current_messages,
            "full_messages_history": full_history,
        },
        "events": {
            "reset": [],
            "summary": [],
            "summary_skip": [],
            "trim": [],
            "thinking_reset": [],
        },
        "metrics": {
            "accuracy": 0.0,
            "completed": False,
            "estimated_full_history_tokens": estimated_full_tokens,
        },
        "provider_payload": {
            "model": "synthetic",
            "usage_tracking": [
                {
                    "step": turns,
                    "prompt_tokens": estimated_full_tokens,
                    "completion_tokens": 0,
                    "total_tokens": estimated_full_tokens,
                }
            ],
        },
        "metadata": {
            "long_context": {
                "tier": tier,
                "target_tokens": target_tokens,
                "turns": turns,
                "needle_count": needle_count,
                "needles": [needle.__dict__ for needle in needles],
                "records": [record.__dict__ for record in records],
                "current_token_thresholds": {
                    "max_current_token_ratio": DEFAULT_CURRENT_TOKEN_RATIO,
                    "max_current_tokens": DEFAULT_MAX_CURRENT_TOKENS,
                },
            }
        },
    }


def compact_with_summary_tail(
    trajectory: dict[str, Any],
    *,
    tail_messages: int = 16,
    summary_mode: str = "perfect",
) -> dict[str, Any]:
    if summary_mode not in {"perfect", "lossy", "corrupt"}:
        raise ValueError("summary_mode must be one of: perfect, lossy, corrupt")
    full_history = list(trajectory.get("conversation", {}).get("full_messages_history", []))
    needles = _needles_from_trajectory(trajectory)
    records = _records_from_trajectory(trajectory)
    summary_lines = [
        "Summary of compacted long-context trajectory.",
        f"Summary mode: {summary_mode}.",
        "Preserve these exact LOCA_LONG_CONTEXT_NEEDLE values:",
    ]
    for index, needle in enumerate(needles):
        if summary_mode in {"lossy", "corrupt"} and index == 0:
            summary_lines.append(f"- {needle.key}: LC-CORRUPTED-{index:03d}")
            continue
        summary_lines.append(f"- {needle.key}: {needle.value}")
    summary_lines.append("Preserve these exact active context records:")
    for index, record in enumerate(record for record in records if record.should_preserve):
        if summary_mode == "lossy" and index % 5 == 0:
            continue
        if summary_mode == "corrupt" and index % 4 == 0:
            summary_lines.append(f"- {record.key}: CORRUPTED-{record.kind}")
            continue
        summary_lines.append(f"- {record.key}: {record.value}")
    summary_message = {"role": "user", "content": "\n".join(summary_lines)}
    tail = _select_tail_preserving_tool_pairs(full_history, tail_messages)

    compacted = json.loads(json.dumps(trajectory, ensure_ascii=False))
    compacted["conversation"]["messages"] = [summary_message, *tail]
    compacted["events"]["summary"] = [
        {
            "step": len(full_history),
            "trigger_reason": "synthetic_long_context",
            "summary_mode": summary_mode,
            "messages_before_count": len(full_history),
            "messages_after_count": len(compacted["conversation"]["messages"]),
            "summary_tail_count": len(tail),
            "total_tokens": estimate_messages_tokens(full_history),
        }
    ]
    compacted["metrics"]["accuracy"] = 1.0
    compacted["metrics"]["completed"] = True
    compacted["metrics"]["estimated_current_tokens"] = estimate_messages_tokens(
        compacted["conversation"]["messages"]
    )
    return compacted


def audit_long_context_trajectory(
    trajectory: dict[str, Any],
    *,
    max_current_token_ratio: float | None = None,
    max_current_tokens: int | None = None,
) -> dict[str, Any]:
    needles = _needles_from_trajectory(trajectory)
    records = _records_from_trajectory(trajectory)
    conversation = trajectory.get("conversation", {})
    current_text = _messages_text(conversation.get("messages", []))
    full_text = _messages_text(conversation.get("full_messages_history", []))
    missing_current = [needle.key for needle in needles if needle.value not in current_text]
    missing_full = [needle.key for needle in needles if needle.value not in full_text]
    preservable_records = [record for record in records if record.should_preserve]
    missing_current_records = [
        record.key for record in preservable_records if record.value not in current_text
    ]
    missing_full_records = [
        record.key for record in preservable_records if record.value not in full_text
    ]
    current_tokens = estimate_messages_tokens(conversation.get("messages", []))
    full_tokens = estimate_messages_tokens(conversation.get("full_messages_history", []))
    compression_ratio = current_tokens / full_tokens if full_tokens else 1.0
    metadata_thresholds = (
        trajectory.get("metadata", {})
        .get("long_context", {})
        .get("current_token_thresholds", {})
    )
    ratio_threshold = (
        max_current_token_ratio
        if max_current_token_ratio is not None
        else metadata_thresholds.get("max_current_token_ratio", DEFAULT_CURRENT_TOKEN_RATIO)
    )
    current_token_limit = (
        max_current_tokens
        if max_current_tokens is not None
        else metadata_thresholds.get("max_current_tokens", DEFAULT_MAX_CURRENT_TOKENS)
    )
    ratio_ok = compression_ratio <= float(ratio_threshold)
    current_tokens_ok = current_tokens <= int(current_token_limit)
    failures = {
        "missing_current_needles": missing_current,
        "missing_full_history_needles": missing_full,
        "missing_current_records": missing_current_records,
        "missing_full_history_records": missing_full_records,
        "current_token_ratio_exceeded": [] if ratio_ok else [compression_ratio],
        "current_token_limit_exceeded": [] if current_tokens_ok else [current_tokens],
    }
    return {
        "needle_count": len(needles),
        "record_count": len(records),
        "preserved_record_count": len(preservable_records),
        "missing_current_needles": missing_current,
        "missing_full_history_needles": missing_full,
        "missing_current_records": missing_current_records,
        "missing_full_history_records": missing_full_records,
        "estimated_current_tokens": current_tokens,
        "estimated_full_history_tokens": full_tokens,
        "compression": {
            "current_to_full_ratio": compression_ratio,
            "max_current_token_ratio": ratio_threshold,
            "max_current_tokens": current_token_limit,
            "within_current_token_ratio": ratio_ok,
            "within_current_token_limit": current_tokens_ok,
        },
        "summary_events": len(trajectory.get("events", {}).get("summary", []) or []),
        "failure_count": sum(len(value) for value in failures.values()),
        "failures": failures,
    }


def write_loca_output(
    output_dir: Path,
    trajectory: dict[str, Any],
    *,
    audit: dict[str, Any] | None = None,
) -> None:
    task_dir = output_dir / "tasks" / "LongContextNeedles" / "state0"
    task_dir.mkdir(parents=True, exist_ok=True)
    audit = audit if audit is not None else audit_long_context_trajectory(trajectory)
    accuracy = 0.0 if audit["failure_count"] else 1.0
    status = "success" if accuracy == 1.0 else "error"
    _write_json(task_dir / "trajectory.json", trajectory)
    _write_json(task_dir / "eval.json", {"status": status, "accuracy": accuracy, "steps": 1})
    _write_json(task_dir / "token_stats.json", trajectory["provider_payload"])
    _write_json(output_dir / "all_trajectories.json", {"LongContextNeedles": {"state0": trajectory}})
    _write_json(
        output_dir / "results.json",
        {
            "summary": {
                "avg_accuracy": accuracy,
                "avg_steps": 1,
                "avg_tool_calls": 0,
                "total_api_tokens": trajectory["provider_payload"]["usage_tracking"][0][
                    "total_tokens"
                ],
            }
        },
    )


def estimate_messages_tokens(messages: Any) -> int:
    if not isinstance(messages, list):
        return 0
    text = json.dumps(messages, ensure_ascii=False, separators=(",", ":"))
    return max(1, len(text) // APPROX_CHARS_PER_TOKEN)


def _make_needles(count: int, turns: int) -> list[Needle]:
    positions = sorted(
        {
            max(1, min(turns - 2, (index + 1) * turns // (count + 1)))
            for index in range(count)
        }
    )
    needles = []
    for index, turn in enumerate(positions):
        needles.append(
            Needle(
                key=f"needle_{index:03d}",
                value=(
                    f"LC-{index:03d}-"
                    f"course=CTX{(index % 17) + 100}-"
                    f"owner=Analyst{index:03d}-"
                    f"deadline=2026-12-{(index % 28) + 1:02d}T23:59:00Z"
                ),
                turn=turn,
            )
        )
    return needles


def _make_context_records(needles: list[Needle], turns: int) -> list[LongContextRecord]:
    records: list[LongContextRecord] = []
    for index, needle in enumerate(needles):
        corrected_turn = min(turns - 2, needle.turn + 1)
        rescinded_turn = min(turns - 2, needle.turn + 2)
        tool_turn = min(turns - 2, needle.turn + 3)
        records.extend(
            [
                LongContextRecord(
                    key=f"stale_update_{index:03d}",
                    value=(
                        f"LOCA_CONFLICTING_UPDATE stale_update_{index:03d}: "
                        f"owner=Analyst{index + 900:03d} status=SUPERSEDED_BY {needle.key}"
                    ),
                    turn=needle.turn,
                    kind="conflicting_update",
                    should_preserve=False,
                ),
                LongContextRecord(
                    key=f"active_update_{index:03d}",
                    value=(
                        f"LOCA_ACTIVE_UPDATE active_update_{index:03d}: "
                        f"{needle.value} status=FINAL"
                    ),
                    turn=corrected_turn,
                    kind="conflicting_update",
                    should_preserve=True,
                ),
                LongContextRecord(
                    key=f"rescission_{index:03d}",
                    value=(
                        f"LOCA_RESCINDED_DECISION rescission_{index:03d}: "
                        f"decision=auto-close-{index:03d} status=RESCINDED "
                        f"replacement={needle.key}"
                    ),
                    turn=rescinded_turn,
                    kind="rescinded_decision",
                    should_preserve=True,
                ),
                LongContextRecord(
                    key=f"tool_observation_{index:03d}",
                    value=(
                        f"LOCA_TOOL_OBSERVATION tool_observation_{index:03d}: "
                        f"tool=health_probe checksum=CHK{index:03d}{(index * 37) % 997:03d} "
                        f"valid=true source={needle.key}"
                    ),
                    turn=tool_turn,
                    kind="tool_observation",
                    should_preserve=True,
                ),
                LongContextRecord(
                    key=f"distractor_{index:03d}",
                    value=(
                        f"LOCA_DISTRACTOR distractor_{index:03d}: "
                        f"course=CTX{(index % 17) + 100} owner=Analyst{index:03d} "
                        f"deadline=2025-01-{(index % 28) + 1:02d}T00:00:00Z"
                    ),
                    turn=max(1, needle.turn - 1),
                    kind="distractor",
                    should_preserve=False,
                ),
            ]
        )
    return records


def _needles_from_trajectory(trajectory: dict[str, Any]) -> list[Needle]:
    raw = trajectory.get("metadata", {}).get("long_context", {}).get("needles", [])
    return [
        Needle(key=str(item["key"]), value=str(item["value"]), turn=int(item["turn"]))
        for item in raw
        if isinstance(item, dict) and {"key", "value", "turn"} <= set(item)
    ]


def _records_from_trajectory(trajectory: dict[str, Any]) -> list[LongContextRecord]:
    raw = trajectory.get("metadata", {}).get("long_context", {}).get("records", [])
    return [
        LongContextRecord(
            key=str(item["key"]),
            value=str(item["value"]),
            turn=int(item["turn"]),
            kind=str(item["kind"]),
            should_preserve=bool(item["should_preserve"]),
        )
        for item in raw
        if isinstance(item, dict)
        and {"key", "value", "turn", "kind", "should_preserve"} <= set(item)
    ]


def _format_records(records: list[LongContextRecord]) -> str:
    if not records:
        return ""
    return "".join(f"{record.value}\n" for record in records)


def _select_tail_preserving_tool_pairs(
    full_history: list[dict[str, Any]],
    tail_messages: int,
) -> list[dict[str, Any]]:
    if tail_messages <= 0:
        return []
    tail_start = max(0, len(full_history) - tail_messages)

    while tail_start > 0:
        tail = list(full_history[tail_start:])
        missing = _tool_result_ids(tail) - _assistant_tool_call_ids(tail)
        if not missing:
            break
        producer_index = _find_latest_tool_call_producer(full_history, tail_start, missing)
        if producer_index is None:
            break
        tail_start = producer_index

    tail = list(full_history[tail_start:])
    produced = _assistant_tool_call_ids(tail)
    while tail and tail[0].get("role") == "tool":
        tool_id = tail[0].get("tool_call_id")
        if isinstance(tool_id, str) and tool_id in produced:
            break
        tail.pop(0)
    return tail


def _assistant_tool_call_ids(messages: list[dict[str, Any]]) -> set[str]:
    ids: set[str] = set()
    for message in messages:
        if message.get("role") != "assistant":
            continue
        calls = message.get("tool_calls")
        if not isinstance(calls, list):
            continue
        for call in calls:
            if not isinstance(call, dict):
                continue
            call_id = call.get("id")
            if isinstance(call_id, str) and call_id:
                ids.add(call_id)
    return ids


def _tool_result_ids(messages: list[dict[str, Any]]) -> set[str]:
    ids: set[str] = set()
    for message in messages:
        if message.get("role") != "tool":
            continue
        tool_id = message.get("tool_call_id")
        if isinstance(tool_id, str) and tool_id:
            ids.add(tool_id)
    return ids


def _find_latest_tool_call_producer(
    full_history: list[dict[str, Any]],
    before_index: int,
    missing_ids: set[str],
) -> int | None:
    for index in range(before_index - 1, -1, -1):
        message = full_history[index]
        if message.get("role") != "assistant":
            continue
        if _assistant_tool_call_ids([message]) & missing_ids:
            return index
    return None


def _filler(chars: int) -> str:
    unit = (
        "LOCA_BACKGROUND_CONTEXT row contains planning chatter, stale candidate "
        "values, tool transcripts, and routine notes; the compactor must keep "
        "audited facts distinct from filler. "
    )
    repeats = (chars // len(unit)) + 1
    return (unit * repeats)[:chars]


def _messages_text(messages: Any) -> str:
    if not isinstance(messages, list):
        return ""
    parts = []
    for message in messages:
        if isinstance(message, dict):
            content = message.get("content", "")
            if isinstance(content, str):
                parts.append(content)
    return "\n".join(parts)


def _write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    sys.exit(main())
