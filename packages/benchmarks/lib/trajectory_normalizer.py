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
import logging
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Iterable

logger = logging.getLogger(__name__)

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

    def to_json(self) -> str:
        """Serialize to a single-line JSON string (no whitespace).

        ``json.dumps`` recursively handles nested ``request.messages``
        and ``response.toolCalls`` because they are plain dict/list
        structures by construction.
        """
        return json.dumps(asdict(self), separators=(",", ":"), ensure_ascii=False)


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
    """Parse an ``eliza_native_v1`` JSONL file and enrich with metadata.

    Each input row already conforms to the canonical schema; this
    function exists to add our cross-agent metadata (agent_id,
    benchmark_id, task_id, step_index) and to filter out non-schema
    rows defensively (lines that fail to parse are skipped with a
    debug log).
    """
    raw = path.read_text(encoding="utf-8")
    entries: list[CanonicalEntry] = []
    step = 0
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            logger.debug("Skipping malformed JSONL line in %s", path)
            continue
        if not isinstance(row, dict):
            continue
        entries.append(
            CanonicalEntry(
                format=row.get("format", "eliza_native_v1"),
                boundary=row.get("boundary", "vercel_ai_sdk.generateText"),
                request=row.get("request", {}) or {},
                response=row.get("response", {}) or {},
                agent_id=agent_id,
                benchmark_id=benchmark_id,
                task_id=task_id,
                step_index=step,
                timestamp_ms=row.get("timestamp_ms") or row.get("timestamp"),
                model=row.get("model"),
                scenarioId=row.get("scenarioId"),
                batchId=row.get("batchId"),
                metadata=row.get("metadata", {}) or {},
                trajectoryTotals=row.get("trajectoryTotals", {}) or {},
                cacheStats=row.get("cacheStats", {}) or {},
            )
        )
        step += 1
    return entries


# ---------------------------------------------------------------------------
# OpenClaw
# ---------------------------------------------------------------------------


def _coerce_tool_call(raw: Any) -> dict[str, Any] | None:
    """Coerce a tool-call-like dict into our canonical shape.

    Accepts the OpenAI ``function``-wrapper shape and the flat shape;
    drops anything without a ``name``.
    """
    if not isinstance(raw, dict):
        return None
    if "function" in raw and isinstance(raw["function"], dict):
        fn = raw["function"]
        name = fn.get("name")
        if not name:
            return None
        args = fn.get("arguments", {})
        if isinstance(args, str):
            try:
                args = json.loads(args)
            except json.JSONDecodeError:
                # Keep the raw string — the schema does not constrain
                # the type of `arguments`.
                pass
        return {
            "name": name,
            "arguments": args,
            "id": raw.get("id", ""),
            "result": raw.get("result"),
        }
    name = raw.get("name")
    if not name:
        return None
    return {
        "name": name,
        "arguments": raw.get("arguments", {}),
        "id": raw.get("id", ""),
        "result": raw.get("result"),
    }


def normalize_openclaw_response(
    response_json: dict[str, Any],
    *,
    benchmark_id: str,
    task_id: str,
    model: str | None = None,
) -> list[CanonicalEntry]:
    """Normalize OpenClaw ``agent --json`` output.

    Emits one ``CanonicalEntry`` per assistant turn. The conversation
    prefix (every message before the assistant turn) is folded into
    ``request.messages``; the assistant ``content`` populates
    ``response.text``; ``tool_calls`` (if any) populate
    ``response.toolCalls`` after coercion.
    """
    messages = response_json.get("messages") or []
    entries: list[CanonicalEntry] = []
    step = 0
    for idx, msg in enumerate(messages):
        if not isinstance(msg, dict):
            continue
        if msg.get("role") != "assistant":
            continue

        prior_messages: list[dict[str, str]] = []
        for prior in messages[:idx]:
            if not isinstance(prior, dict):
                continue
            role = prior.get("role")
            if role not in {"system", "user", "assistant", "tool"}:
                continue
            content = prior.get("content")
            if content is None:
                content = ""
            prior_messages.append({"role": role, "content": str(content)})

        request: dict[str, Any] = {"messages": prior_messages}

        raw_tool_calls = msg.get("tool_calls") or []
        tool_calls: list[dict[str, Any]] = []
        for tc in raw_tool_calls:
            coerced = _coerce_tool_call(tc)
            if coerced is not None:
                tool_calls.append(coerced)

        response: dict[str, Any] = {}
        text = msg.get("content")
        if text:
            response["text"] = str(text)
        if tool_calls:
            response["toolCalls"] = tool_calls

        entries.append(
            CanonicalEntry(
                boundary="openclaw_agent_v1",
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
    raw = path.read_text(encoding="utf-8")
    entries: list[CanonicalEntry] = []
    step = 0

    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            logger.debug("Skipping malformed Hermes JSONL line in %s", path)
            continue
        if not isinstance(row, dict):
            continue

        msgs = row.get("messages") or []
        if not isinstance(msgs, list) or not msgs:
            continue

        # Find the index of the final ``gpt`` turn — that's the one we
        # split on. If there isn't one, treat the row as request-only.
        split_idx = -1
        for i in range(len(msgs) - 1, -1, -1):
            m = msgs[i]
            if isinstance(m, dict) and m.get("from") == "gpt":
                split_idx = i
                break

        request_messages: list[dict[str, str]] = []
        prefix = msgs if split_idx == -1 else msgs[:split_idx]
        for m in prefix:
            if not isinstance(m, dict):
                continue
            role = _HERMES_ROLE_MAP.get(m.get("from"), None)
            if role is None:
                continue
            content = _stringify_tool_value(m.get("value"))
            request_messages.append({"role": role, "content": content})

        request: dict[str, Any] = {"messages": request_messages}

        response: dict[str, Any] = {}
        if split_idx != -1:
            final = msgs[split_idx]
            text_value = _stringify_tool_value(final.get("value"))
            if text_value:
                response["text"] = text_value
            raw_calls = final.get("tool_calls") or final.get("toolCalls") or []
            tool_calls = [
                coerced
                for raw_call in raw_calls
                if (coerced := _coerce_tool_call(raw_call)) is not None
            ] if isinstance(raw_calls, list) else []
            if tool_calls:
                response["toolCalls"] = tool_calls

        entries.append(
            CanonicalEntry(
                boundary="hermes_atropos_v1",
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
    length = max(len(entries_a), len(entries_b))
    pairs: list[tuple[CanonicalEntry | None, CanonicalEntry | None]] = []
    for i in range(length):
        a = entries_a[i] if i < len(entries_a) else None
        b = entries_b[i] if i < len(entries_b) else None
        pairs.append((a, b))
    return pairs


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _read_jsonl_entries(path: Path) -> list[CanonicalEntry]:
    """Re-read a canonical JSONL file back into ``CanonicalEntry`` instances.

    Used by the diff subcommand. Unknown fields are ignored to keep
    the reader forward-compatible.
    """
    raw = path.read_text(encoding="utf-8")
    out: list[CanonicalEntry] = []
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        row = json.loads(line)
        out.append(
            CanonicalEntry(
                format=row.get("format", "eliza_native_v1"),
                boundary=row.get("boundary", "vercel_ai_sdk.generateText"),
                request=row.get("request", {}) or {},
                response=row.get("response", {}) or {},
                agent_id=row.get("agent_id", ""),
                benchmark_id=row.get("benchmark_id", ""),
                task_id=row.get("task_id", ""),
                step_index=row.get("step_index", 0),
                timestamp_ms=row.get("timestamp_ms"),
                model=row.get("model"),
            )
        )
    return out


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
                "step": idx,
                "a": asdict(a) if a is not None else None,
                "b": asdict(b) if b is not None else None,
            }
            for idx, (a, b) in enumerate(pairs)
        ]
        json.dump(payload, sys.stdout, ensure_ascii=False)
        sys.stdout.write("\n")
        return 0

    return 1


if __name__ == "__main__":
    raise SystemExit(cli())
