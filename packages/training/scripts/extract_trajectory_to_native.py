"""Extract a harvest trajectory into `eliza_native_v1` training JSONL.

This is the Stage-4 bridge between a *captured* trajectory and the training
corpus. It reads the two real harvest shapes the elizaOS runtime and the
scenario runner produce, and emits one validated `eliza_native_v1` row per
model-call boundary — the exact shape `elizaos/eliza-1-training-data` and
`train_local.py` / `run_pipeline.py` consume.

Why this exists (justification for a new script under scripts/):
  - The scenario runner already emits `eliza_native_v1` directly via
    `EXPORT_NATIVE_PATH=…/native.jsonl` — for that shape this script is a
    filter (keep only correct/passing rows) + validator, not a converter.
  - The *native trajectory recorder* (the on-disk `tj-<id>.json` files under
    `${STATE_DIR}/trajectories/<agentId>/`) writes a richer per-stage shape
    that is NOT yet `eliza_native_v1`. Harvesting THOSE for training needs a
    faithful converter that preserves the verbatim model output (never
    re-synthesizes it). The in-runtime TS path (`plugins/plugin-training`
    `buildElizaNativeTrajectoryRows`) does this inside a live AgentRuntime;
    this standalone, dependency-free script does the same conversion offline
    so the harvest → JSONL link is runnable without booting the runtime.

Both paths funnel through `lib.native_record.validate_native_record` — the
same acceptance gate `format_for_training` uses — so nothing invalid or
lossy reaches the corpus.

Usage:
    python extract_trajectory_to_native.py --input <path> [--output <path>]
        [--require-pass] [--stats-only]

    --input        A `tj-*.json` recorder trajectory, OR a `.jsonl` file of
                   either `eliza_native_v1` rows or recorder trajectories
                   (one JSON object per line).
    --output       Destination JSONL (default: stdout).
    --require-pass Drop rows whose quality signal is a failed/skipped
                   scenario (`scenarioStatus` / `metadata.scenario_status`).
                   Correct-trajectory harvest MUST pass this. Recorder rows
                   with no scenario signal are kept (they carry no gate).
    --stats-only   Do not write rows; just print the extraction summary.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Iterable

sys.path.insert(0, str(Path(__file__).resolve().parent))

from lib.native_record import (  # noqa: E402
    BOUNDARY_GENERATE_TEXT,
    FORMAT,
    SCHEMA_VERSION,
    validate_native_record,
)

# Model boundaries that map onto a Vercel AI SDK generateText/streamText call
# (the only boundaries the native corpus trains on).
_STREAM_TEXT = "vercel_ai_sdk.streamText"
NATIVE_BOUNDARIES = {BOUNDARY_GENERATE_TEXT, _STREAM_TEXT}

# Failed / skipped scenario statuses that must never train as gold (#8795).
_FAILED_STATUSES = {"failed", "error", "errored", "skipped", "timeout", "timed_out"}


def _scenario_status(row: dict[str, Any]) -> str | None:
    status = row.get("scenarioStatus")
    if isinstance(status, str):
        return status.lower()
    meta = row.get("metadata")
    if isinstance(meta, dict):
        s = meta.get("scenario_status") or meta.get("scenarioStatus")
        if isinstance(s, str):
            return s.lower()
    return None


def _is_failed(row: dict[str, Any]) -> bool:
    s = _scenario_status(row)
    return s is not None and s in _FAILED_STATUSES


def _non_system_turns(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for m in messages:
        if not isinstance(m, dict):
            continue
        if m.get("role") == "system":
            continue
        turn: dict[str, Any] = {"role": m.get("role"), "content": m.get("content")}
        if m.get("role") == "tool" and m.get("tool_call_id"):
            turn["tool_call_id"] = m["tool_call_id"]
        out.append(turn)
    return out


def _system_text(messages: list[dict[str, Any]]) -> str | None:
    for m in messages:
        if isinstance(m, dict) and m.get("role") == "system":
            c = m.get("content")
            if isinstance(c, str) and c.strip():
                return c
    return None


def _mirror_tool_calls(tool_calls: Any) -> list[dict[str, Any]]:
    """Convert recorder tool calls `{id,name,args}` to the AI-SDK mirror
    `{toolCallId,toolName,input}` used in `response.toolCalls`."""
    out: list[dict[str, Any]] = []
    if not isinstance(tool_calls, list):
        return out
    for i, c in enumerate(tool_calls):
        if not isinstance(c, dict):
            continue
        cid = c.get("id") or c.get("toolCallId") or f"call_{i}"
        name = c.get("name") or c.get("toolName")
        args = c.get("args")
        if args is None:
            args = c.get("input") or {}
        if not name:
            continue
        out.append({"toolCallId": cid, "toolName": name, "input": args})
    return out


def _row_from_recorder_stage(
    trajectory: dict[str, Any], stage: dict[str, Any]
) -> dict[str, Any] | None:
    """Build one verbatim `eliza_native_v1` row from a recorder stage.

    Preserves the model's real output (`stage.model.response`) — it does NOT
    re-synthesize an envelope, so the training target is exactly what the
    model emitted at capture time.
    """
    model = stage.get("model")
    if not isinstance(model, dict):
        return None
    messages = model.get("messages")
    if not isinstance(messages, list) or not messages:
        return None
    turns = _non_system_turns(messages)
    if not any(isinstance(t, dict) and t.get("role") == "user" for t in turns):
        return None

    response_text = model.get("response")
    mirror = _mirror_tool_calls(model.get("toolCalls"))
    if (not isinstance(response_text, str) or not response_text.strip()) and not mirror:
        return None

    request: dict[str, Any] = {"messages": turns}
    system = _system_text(messages)
    if system:
        request["system"] = system
    tools = model.get("tools")
    if isinstance(tools, list) and tools:
        request["tools"] = tools
    request["settings"] = {"temperature": 0.0, "topP": 1.0}

    response: dict[str, Any] = {}
    if isinstance(response_text, str) and response_text.strip():
        response["text"] = response_text
    response["finishReason"] = model.get("finishReason") or (
        "tool_calls" if mirror else "stop"
    )
    if mirror:
        response["toolCalls"] = mirror

    row: dict[str, Any] = {
        "format": FORMAT,
        "schemaVersion": SCHEMA_VERSION,
        "boundary": BOUNDARY_GENERATE_TEXT,
        "request": request,
        "response": response,
        "trajectoryId": trajectory.get("trajectoryId"),
        "agentId": trajectory.get("agentId"),
        "metadata": {
            "source": "native_trajectory_recorder",
            "stage_id": stage.get("stageId"),
            "stage_kind": stage.get("kind"),
            "model_type": model.get("modelType"),
            "model_name": model.get("modelName"),
            "provider": model.get("provider"),
        },
    }
    return row


def _iter_input_rows(path: Path) -> Iterable[dict[str, Any]]:
    """Yield candidate rows (already-native or recorder-derived) from `path`."""
    text = path.read_text(encoding="utf-8")
    stripped = text.lstrip()
    # A single JSON object (recorder trajectory `tj-*.json`).
    if stripped.startswith("{") and path.suffix == ".json":
        obj = json.loads(text)
        yield from _rows_from_object(obj)
        return
    # JSONL: each line is a native row or a recorder trajectory.
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        obj = json.loads(line)
        yield from _rows_from_object(obj)


def _rows_from_object(obj: dict[str, Any]) -> Iterable[dict[str, Any]]:
    if not isinstance(obj, dict):
        return
    # Already an eliza_native_v1 row → passthrough.
    if obj.get("format") == FORMAT:
        yield obj
        return
    # Recorder trajectory → one row per model-bearing stage.
    stages = obj.get("stages")
    if isinstance(stages, list):
        for stage in stages:
            if not isinstance(stage, dict):
                continue
            row = _row_from_recorder_stage(obj, stage)
            if row is not None:
                yield row


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", default=None)
    ap.add_argument("--require-pass", action="store_true")
    ap.add_argument("--stats-only", action="store_true")
    args = ap.parse_args()

    in_path = Path(args.input)
    if not in_path.exists():
        print(f"[extract] input not found: {in_path}", file=sys.stderr)
        return 1

    emitted: list[dict[str, Any]] = []
    seen = invalid = dropped_failed = 0
    for row in _iter_input_rows(in_path):
        seen += 1
        if row.get("boundary") not in NATIVE_BOUNDARIES:
            invalid += 1
            continue
        ok, reason = validate_native_record(row)
        if not ok:
            invalid += 1
            print(f"[extract] drop invalid row: {reason}", file=sys.stderr)
            continue
        if args.require_pass and _is_failed(row):
            dropped_failed += 1
            continue
        emitted.append(row)

    print(
        f"[extract] input={in_path.name} seen={seen} emitted={len(emitted)} "
        f"invalid={invalid} dropped_failed_scenario={dropped_failed}",
        file=sys.stderr,
    )
    if not args.stats_only:
        if args.output:
            out_path = Path(args.output)
            out_path.parent.mkdir(parents=True, exist_ok=True)
            with out_path.open("w", encoding="utf-8") as f:
                for row in emitted:
                    f.write(json.dumps(row, ensure_ascii=False) + "\n")
            print(f"[extract] wrote {len(emitted)} rows -> {out_path}", file=sys.stderr)
        else:
            for row in emitted:
                sys.stdout.write(json.dumps(row, ensure_ascii=False) + "\n")
    return 0 if emitted else 2


if __name__ == "__main__":
    raise SystemExit(main())
