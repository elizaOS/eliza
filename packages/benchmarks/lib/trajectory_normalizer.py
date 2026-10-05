"""Convert per-agent native trajectory formats into the canonical
``eliza_native_v1`` JSONL schema for cross-agent comparison + diffing.

The same schema is what ``apps/app-training``'s native optimizers (MIPRO,
GEPA, bootstrap-fewshot) already consume, so normalized trajectories
become training data for free.

Supported sources:

* **Eliza** — already in ``eliza_native_v1``. Pass-through with metadata.
* **OpenClaw** — JSON response from ``openclaw agent --json``,
  shaped as ``{"messages": [{"role": ..., "content": ..., "tool_calls": [...]}, ...]}``.
  Boundary: ``openclaw_agent_v1``.
* **Hermes-agent** — Atropos ``samples.jsonl`` rows in ShareGPT style:
  ``{"messages": [{"from": "human"|"gpt"|"tool", "value": ...}], "tools": [...]}``.
  Tool calls must be carried as native ``tool_calls`` fields.
  Boundary: ``hermes_atropos_v1``.

Stdlib only. Consumed by both Python (tests, viewer) and Node (eliza training).
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict, dataclass, field, fields, replace
from pathlib import Path
from typing import Any, Iterable

class TrajectoryFormatError(ValueError):
    """Native evidence cannot be normalized without loss."""


def _jsonl_rows(path: Path) -> Iterable[dict[str, Any]]:
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError as exc:
            raise TrajectoryFormatError(f"{path}:{number}: invalid JSON") from exc
        if not isinstance(row, dict):
            raise TrajectoryFormatError(f"{path}:{number}: expected an object")
        yield row


@dataclass(frozen=True)
class CanonicalEntry:
    """One LLM boundary in the canonical ``eliza_native_v1`` schema.

    The first four fields are the schema contract (see
    ``eliza/plugins/app-training/src/backends/native.ts`` ~L64). The
    remaining fields are extension metadata used by the cross-agent
    viewer; they are preserved on disk but ignored by the native
    optimizers.
    """

    format: str = "eliza_native_v1"
    boundary: str = "vercel_ai_sdk.generateText"
    request: dict[str, Any] = field(default_factory=dict)
    response: dict[str, Any] = field(default_factory=dict)
    agent_id: str = ""
    benchmark_id: str = ""
    task_id: str = ""
    step_index: int = 0
    timestamp_ms: int | None = None
    model: str | None = None
    scenarioId: str | None = None
    batchId: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)
    trajectoryTotals: dict[str, Any] = field(default_factory=dict)
    cacheStats: dict[str, Any] = field(default_factory=dict)
    extensions: dict[str, Any] = field(default_factory=dict, repr=False)

    @classmethod
    def from_row(cls, row: dict[str, Any]) -> CanonicalEntry:
        names = {item.name for item in fields(cls)} - {"extensions"}
        return cls(
            **{key: value for key, value in row.items() if key in names},
            extensions={key: value for key, value in row.items() if key not in names},
        )

    def to_json(self) -> str:
        """Serialize to a single-line JSON string (no whitespace).

        ``json.dumps`` recursively handles nested ``request.messages``
        and ``response.toolCalls`` because they are plain dict/list
        structures by construction.
        """
        row = asdict(self)
        extensions = row.pop("extensions")
        return json.dumps({**extensions, **row}, separators=(",", ":"), ensure_ascii=False)


# ---------------------------------------------------------------------------
# Eliza pass-through
# ---------------------------------------------------------------------------


def normalize_eliza_jsonl(
    path: Path,
    *,
    agent_id: str = "eliza",
    benchmark_id: str,
    task_id: str,
) -> list[CanonicalEntry]:
    """Enrich canonical evidence, retaining native fields and rejecting corrupt rows."""
    entries = []
    for step, row in enumerate(_jsonl_rows(path)):
        if row.get("format", "eliza_native_v1") != "eliza_native_v1":
            raise TrajectoryFormatError(f"{path}: unsupported trajectory format")
        if not isinstance(row.get("request"), dict) or not isinstance(row.get("response"), dict):
            raise TrajectoryFormatError(f"{path}: request and response must be objects")
        entries.append(replace(
            CanonicalEntry.from_row(row), agent_id=agent_id,
            benchmark_id=benchmark_id, task_id=task_id,
            step_index=row.get("step_index", step),
            timestamp_ms=row.get("timestamp_ms", row.get("timestamp")),
        ))
    return entries


# ---------------------------------------------------------------------------
# OpenClaw
# ---------------------------------------------------------------------------


def _normalize_tool_calls(raw: Any) -> list[dict[str, Any]]:
    """Normalize flat/OpenAI calls without silently dropping invalid evidence."""
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise TrajectoryFormatError("Tool calls must be a list")
    calls = []
    for call in raw:
        if not isinstance(call, dict):
            raise TrajectoryFormatError("Tool calls must contain objects")
        function = call.get("function", call)
        if not isinstance(function, dict) or not isinstance(function.get("name"), str) or not function["name"]:
            raise TrajectoryFormatError("Tool call requires a nonempty function name")
        arguments = function.get("arguments", {})
        if "function" in call and isinstance(arguments, str):
            try:
                arguments = json.loads(arguments)
            except json.JSONDecodeError:
                pass  # Incomplete generated JSON remains exact model evidence.
        calls.append({
            "name": function["name"], "arguments": arguments,
            "id": call.get("id", ""), "result": call.get("result"),
        })
    return calls


def normalize_openclaw_response(
    response_json: dict[str, Any],
    *,
    benchmark_id: str,
    task_id: str,
    model: str | None = None,
) -> list[CanonicalEntry]:
    """Normalize OpenClaw ``agent --json`` output.

    Emits one ``CanonicalEntry`` per assistant turn and an explicit incomplete
    entry for a pending tail. The conversation
    prefix (every message before the assistant turn) is folded into
    ``request.messages``; the assistant ``content`` populates
    ``response.text``; ``tool_calls`` (if any) populate
    ``response.toolCalls`` after coercion.
    """
    messages = response_json.get("messages")
    if not isinstance(messages, list) or not messages or any(not isinstance(msg, dict) for msg in messages):
        raise TrajectoryFormatError("OpenClaw messages must be a nonempty list of objects")
    entries: list[CanonicalEntry] = []
    step = 0
    for idx, msg in enumerate(messages):
        if msg.get("role") != "assistant":
            continue

        prior_messages = [dict(prior) for prior in messages[:idx]]
        request: dict[str, Any] = {"messages": prior_messages}
        if "tools" in response_json:
            request["tools"] = response_json["tools"]

        tool_calls = _normalize_tool_calls(msg.get("tool_calls"))

        response: dict[str, Any] = {}
        text = msg.get("content")
        if isinstance(text, str):
            response["text"] = text
        elif text is not None:
            response["content"] = text
        if tool_calls:
            response["toolCalls"] = tool_calls

        entries.append(
            CanonicalEntry(
                boundary="openclaw_agent_v1",
                metadata={"native": response_json, "complete": True},
                request=request,
                response=response,
                agent_id="openclaw",
                benchmark_id=benchmark_id,
                task_id=task_id,
                step_index=step,
                model=model,
            )
        )
        step += 1
    if messages[-1].get("role") != "assistant":
        request = {"messages": [dict(message) for message in messages]}
        if "tools" in response_json:
            request["tools"] = response_json["tools"]
        entries.append(CanonicalEntry(
            boundary="openclaw_agent_v1",
            metadata={"native": response_json, "complete": False},
            request=request, response={}, agent_id="openclaw",
            benchmark_id=benchmark_id, task_id=task_id, step_index=step, model=model,
        ))
    return entries


# ---------------------------------------------------------------------------
# Hermes
# ---------------------------------------------------------------------------


_HERMES_ROLE_MAP = {
    "human": "user",
    "gpt": "assistant",
    "tool": "tool",
    "system": "system",
}


def _stringify_tool_value(value: Any) -> str:
    """Tool-role ``value`` fields are sometimes structured (dict/list)
    and sometimes already a string. Normalize to a single string."""
    if isinstance(value, str):
        return value
    if value is None:
        return ""
    try:
        return json.dumps(value, ensure_ascii=False)
    except (TypeError, ValueError):
        return str(value)


def normalize_hermes_samples_jsonl(
    path: Path,
    *,
    benchmark_id: str,
    task_id: str,
    model: str | None = None,
) -> list[CanonicalEntry]:
    """Normalize Hermes/Atropos ``samples.jsonl``.

    Each input row becomes exactly one ``CanonicalEntry``. The non-
    final messages in ``row["messages"]`` map into
    ``request.messages``; the final assistant turn populates
    ``response``. ``from`` → role mapping: ``human``→user,
    ``gpt``→assistant, ``tool``→tool, ``system``→system. Tool calls are
    read only from native ``tool_calls`` / ``toolCalls`` fields.

    Rows whose final message is not from ``gpt`` (rare — usually a
    truncated rollout) still produce an entry, with the trailing
    non-assistant turns rolled into ``request.messages`` and an empty
    response.
    """
    entries: list[CanonicalEntry] = []
    for step, row in enumerate(_jsonl_rows(path)):
        msgs = row.get("messages")
        if not isinstance(msgs, list) or not msgs or any(not isinstance(msg, dict) for msg in msgs):
            raise TrajectoryFormatError(f"{path}: Hermes messages must be a nonempty list of objects")
        split_idx = len(msgs) - 1 if msgs[-1].get("from") == "gpt" else -1
        request_messages: list[dict[str, Any]] = []
        prefix = msgs if split_idx == -1 else msgs[:split_idx]
        for msg in prefix:
            role = _HERMES_ROLE_MAP.get(msg.get("from"))
            if role is None:
                raise TrajectoryFormatError(f"{path}: unsupported Hermes message role")
            converted = {key: value for key, value in msg.items() if key not in {"from", "value"}}
            converted.update(role=role, content=_stringify_tool_value(msg.get("value")) if role == "tool" else msg.get("value", ""))
            request_messages.append(converted)

        request: dict[str, Any] = {"messages": request_messages}
        if "tools" in row:
            request["tools"] = row["tools"]

        response: dict[str, Any] = {}
        if split_idx != -1:
            final = msgs[split_idx]
            value = final.get("value", "")
            if isinstance(value, str):
                response["text"] = value
            elif value is not None:
                response["content"] = value
            tool_calls = _normalize_tool_calls(final.get("tool_calls", final.get("toolCalls")))
            if tool_calls:
                response["toolCalls"] = tool_calls

        entries.append(
            CanonicalEntry(
                boundary="hermes_atropos_v1",
                metadata={"native": row, "complete": split_idx != -1},
                request=request,
                response=response,
                agent_id="hermes",
                benchmark_id=benchmark_id,
                task_id=task_id,
                step_index=step,
                model=model,
            )
        )
        step += 1
    return entries


# ---------------------------------------------------------------------------
# Writer + viewer helpers
# ---------------------------------------------------------------------------


def write_canonical_jsonl(entries: Iterable[CanonicalEntry], path: Path) -> int:
    """Write entries to a JSONL file, returning the count written.

    Parent directory is created if missing. Lines are separated by
    ``\\n`` (no trailing whitespace on each line).
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    count = 0
    with path.open("w", encoding="utf-8") as fh:
        for entry in entries:
            fh.write(entry.to_json())
            fh.write("\n")
            count += 1
    return count


def align_by_step(
    entries_a: list[CanonicalEntry],
    entries_b: list[CanonicalEntry],
) -> list[tuple[CanonicalEntry | None, CanonicalEntry | None]]:
    """Pair entries by ``step_index`` for a two-agent diff view.

    Pads the shorter side with ``None``.
    """
    left = {entry.step_index: entry for entry in entries_a}
    right = {entry.step_index: entry for entry in entries_b}
    if len(left) != len(entries_a) or len(right) != len(entries_b):
        raise TrajectoryFormatError("Duplicate step indices cannot be aligned")
    return [(left.get(step), right.get(step)) for step in sorted(left.keys() | right.keys())]


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _read_jsonl_entries(path: Path) -> list[CanonicalEntry]:
    """Re-read complete canonical evidence for the diff command."""
    return [CanonicalEntry.from_row(row) for row in _jsonl_rows(path)]


def cli() -> int:
    parser = argparse.ArgumentParser(
        prog="trajectory_normalizer",
        description="Normalize per-agent trajectories to eliza_native_v1.",
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    norm = sub.add_parser("normalize", help="Normalize a native trajectory file.")
    norm.add_argument(
        "--agent",
        choices=("eliza", "openclaw", "hermes"),
        required=True,
    )
    norm.add_argument("--input", type=Path, required=True)
    norm.add_argument("--output", type=Path, required=True)
    norm.add_argument("--benchmark", required=True)
    norm.add_argument("--task", required=True)
    norm.add_argument("--model", default=None)

    diff = sub.add_parser("diff", help="Step-align two canonical JSONL files.")
    diff.add_argument("--a", type=Path, required=True)
    diff.add_argument("--b", type=Path, required=True)

    args = parser.parse_args()

    if args.cmd == "normalize":
        if args.agent == "eliza":
            entries = normalize_eliza_jsonl(
                args.input,
                benchmark_id=args.benchmark,
                task_id=args.task,
            )
        elif args.agent == "openclaw":
            response_json = json.loads(args.input.read_text(encoding="utf-8"))
            entries = normalize_openclaw_response(
                response_json,
                benchmark_id=args.benchmark,
                task_id=args.task,
                model=args.model,
            )
        else:
            entries = normalize_hermes_samples_jsonl(
                args.input,
                benchmark_id=args.benchmark,
                task_id=args.task,
                model=args.model,
            )
        written = write_canonical_jsonl(entries, args.output)
        print(f"wrote {written} entries to {args.output}")
        return 0

    if args.cmd == "diff":
        entries_a = _read_jsonl_entries(args.a)
        entries_b = _read_jsonl_entries(args.b)
        pairs = align_by_step(entries_a, entries_b)
        payload = [
            {
                "step": a.step_index if a is not None else b.step_index,
                "a": asdict(a) if a is not None else None,
                "b": asdict(b) if b is not None else None,
            }
            for a, b in pairs
        ]
        json.dump(payload, sys.stdout, ensure_ascii=False)
        sys.stdout.write("\n")
        return 0

    return 1


if __name__ == "__main__":
    raise SystemExit(cli())
