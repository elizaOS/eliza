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


@dataclass(frozen=True)
class Needle:
    key: str
    value: str
    turn: int


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--target-tokens", type=int, default=1_000_000)
    parser.add_argument("--turns", type=int, default=400)
    parser.add_argument("--needle-count", type=int, default=32)
    parser.add_argument("--tail-messages", type=int, default=16)
    parser.add_argument("--no-compact", action="store_true")
    args = parser.parse_args()

    trajectory = build_long_context_trajectory(
        target_tokens=args.target_tokens,
        turns=args.turns,
        needle_count=args.needle_count,
    )
    if not args.no_compact:
        trajectory = compact_with_summary_tail(
            trajectory,
            tail_messages=args.tail_messages,
        )

    write_loca_output(args.output_dir, trajectory)
    audit = audit_long_context_trajectory(trajectory)
    (args.output_dir / "long_context_audit.json").write_text(
        json.dumps(audit, indent=2, ensure_ascii=False, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(audit, indent=2, ensure_ascii=False, sort_keys=True))
    return 1 if audit["missing_current_needles"] or audit["missing_full_history_needles"] else 0


def build_long_context_trajectory(
    *,
    target_tokens: int = 1_000_000,
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
    needles_by_turn = {needle.turn: needle for needle in needles}
    filler_chars = max(128, (target_tokens * APPROX_CHARS_PER_TOKEN) // turns)
    filler = _filler(filler_chars)

    full_history: list[dict[str, Any]] = []
    for turn in range(turns):
        needle = needles_by_turn.get(turn)
        if needle:
            content = (
                f"Turn {turn}: source observation.\n"
                f"LOCA_LONG_CONTEXT_NEEDLE {needle.key}: {needle.value}\n"
                f"{filler}"
            )
        else:
            content = f"Turn {turn}: routine working context.\n{filler}"
        full_history.append({"role": "user" if turn % 2 == 0 else "assistant", "content": content})

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
            "config_id": "synthetic_1m",
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
                "target_tokens": target_tokens,
                "turns": turns,
                "needle_count": needle_count,
                "needles": [needle.__dict__ for needle in needles],
            }
        },
    }


def compact_with_summary_tail(
    trajectory: dict[str, Any],
    *,
    tail_messages: int = 16,
) -> dict[str, Any]:
    full_history = list(trajectory.get("conversation", {}).get("full_messages_history", []))
    needles = _needles_from_trajectory(trajectory)
    summary_lines = [
        "Summary of compacted long-context trajectory.",
        "Preserve these exact LOCA_LONG_CONTEXT_NEEDLE values:",
    ]
    for needle in needles:
        summary_lines.append(f"- {needle.key}: {needle.value}")
    summary_message = {"role": "user", "content": "\n".join(summary_lines)}
    tail = full_history[-tail_messages:] if tail_messages > 0 else []

    compacted = json.loads(json.dumps(trajectory, ensure_ascii=False))
    compacted["conversation"]["messages"] = [summary_message, *tail]
    compacted["events"]["summary"] = [
        {
            "step": len(full_history),
            "trigger_reason": "synthetic_long_context",
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


def audit_long_context_trajectory(trajectory: dict[str, Any]) -> dict[str, Any]:
    needles = _needles_from_trajectory(trajectory)
    conversation = trajectory.get("conversation", {})
    current_text = _messages_text(conversation.get("messages", []))
    full_text = _messages_text(conversation.get("full_messages_history", []))
    missing_current = [needle.key for needle in needles if needle.value not in current_text]
    missing_full = [needle.key for needle in needles if needle.value not in full_text]
    return {
        "needle_count": len(needles),
        "missing_current_needles": missing_current,
        "missing_full_history_needles": missing_full,
        "estimated_current_tokens": estimate_messages_tokens(conversation.get("messages", [])),
        "estimated_full_history_tokens": estimate_messages_tokens(
            conversation.get("full_messages_history", [])
        ),
        "summary_events": len(trajectory.get("events", {}).get("summary", []) or []),
    }


def write_loca_output(output_dir: Path, trajectory: dict[str, Any]) -> None:
    task_dir = output_dir / "tasks" / "LongContextNeedles" / "state0"
    task_dir.mkdir(parents=True, exist_ok=True)
    _write_json(task_dir / "trajectory.json", trajectory)
    _write_json(task_dir / "eval.json", {"status": "success", "accuracy": 1.0, "steps": 1})
    _write_json(task_dir / "token_stats.json", trajectory["provider_payload"])
    _write_json(output_dir / "all_trajectories.json", {"LongContextNeedles": {"state0": trajectory}})
    _write_json(
        output_dir / "results.json",
        {
            "summary": {
                "avg_accuracy": 1.0,
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
    positions = sorted({max(1, min(turns - 2, (index + 1) * turns // (count + 1))) for index in range(count)})
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


def _needles_from_trajectory(trajectory: dict[str, Any]) -> list[Needle]:
    raw = trajectory.get("metadata", {}).get("long_context", {}).get("needles", [])
    return [
        Needle(key=str(item["key"]), value=str(item["value"]), turn=int(item["turn"]))
        for item in raw
        if isinstance(item, dict) and {"key", "value", "turn"} <= set(item)
    ]


def _filler(chars: int) -> str:
    unit = (
        "LOCA_BACKGROUND_CONTEXT row preserves irrelevant working notes; "
        "the compactor must not confuse filler with exact needle facts. "
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
