#!/usr/bin/env python3
"""Prepare Eliza-1 trajectory SFT splits.

Inputs:
  * `eliza_native_v1` model-boundary rows from runtime trajectory export.
  * LifeOpsBench result JSON emitted by `LifeOpsBenchRunner.save_results`.

Outputs:
  * `train.jsonl`, `val.jsonl`, `test.jsonl` as train-local-compatible
    `eliza_native_v1` rows by default.
  * `repair_eval.jsonl` for failed or low-scoring trajectories.
  * `trajectory_records/*.jsonl` with auditable candidate trajectory records
    when `--output-format both` is used.
  * `manifest.json` with split counts, source counts, action counts, and
    privacy redaction totals.

The internal trajectory record is provider-agnostic: a Qwen/ChatML-oriented
`messages` array, OpenAI-style function `tools`, canonicalized `actions`, and
source/quality metadata. The default disk splits are converted back to the
existing `eliza_native_v1` training row shape because `train_local.py` loads
JSONL rows through `scripts/format_for_training.py`.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import re
import sys
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

TRAINING_ROOT = Path(__file__).resolve().parent.parent
REPO_ROOT = TRAINING_ROOT.parent.parent
DEFAULT_ALIAS_PATH = TRAINING_ROOT / "config" / "eliza1_action_aliases.json"

SCHEMA_VERSION = "eliza.eliza1_trajectory_record.v1"
MANIFEST_SCHEMA = "eliza.eliza1_trajectory_dataset_manifest.v1"
NATIVE_FORMAT = "eliza_native_v1"
NATIVE_BOUNDARIES = {"vercel_ai_sdk.generateText", "vercel_ai_sdk.streamText"}
TRAINING_BOUNDARY = "vercel_ai_sdk.generateText"
INPUT_SUFFIXES = {".json", ".jsonl", ".ndjson"}
OUTPUT_FORMAT_NATIVE = "eliza-native"
OUTPUT_FORMAT_NATIVE_ALIAS = "eliza-record"
OUTPUT_FORMAT_TRAJECTORY = "trajectory-record"
OUTPUT_FORMAT_BOTH = "both"
TRAINABLE_OUTPUT_FORMATS = {OUTPUT_FORMAT_NATIVE, OUTPUT_FORMAT_NATIVE_ALIAS, OUTPUT_FORMAT_BOTH}

LOG = logging.getLogger("prepare-eliza1-trajectories")


# ---------------------------------------------------------------------------
# Privacy filtering
# ---------------------------------------------------------------------------


def _load_privacy_filter():
    """Use the LifeOpsBench privacy filter when available, else a local port."""
    bench_pkg = REPO_ROOT / "packages" / "benchmarks" / "lifeops-bench"
    if bench_pkg.exists():
        sys.path.insert(0, str(bench_pkg))
        try:
            from eliza_lifeops_bench.ingest.privacy import (  # type: ignore
                FilterStats,
                apply_privacy_filter,
            )

            return apply_privacy_filter, FilterStats
        except Exception:  # pragma: no cover - fallback covered through behavior
            LOG.debug("LifeOpsBench privacy filter unavailable", exc_info=True)

    @dataclass
    class FilterStats:  # type: ignore[no-redef]
        redaction_count: int = 0
        anonymization_count: int = 0
        credential_hits: dict[str, int] = field(default_factory=dict)

    credential_patterns: list[tuple[str, re.Pattern[str]]] = [
        ("openai-key", re.compile(r"\bsk-[A-Za-z0-9_-]{16,}\b")),
        ("anthropic-key", re.compile(r"\bsk-ant-[A-Za-z0-9_-]{16,}\b")),
        ("bearer", re.compile(r"\bBearer\s+[A-Za-z0-9._-]{16,}\b")),
        ("github-token", re.compile(r"\bghp_[A-Za-z0-9]{20,}\b")),
        ("aws-access-key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ]
    geo_patterns: list[re.Pattern[str]] = [
        re.compile(
            r'"coords"\s*:\s*\{\s*"latitude"\s*:\s*-?\d+(?:\.\d+)?\s*,'
            r'\s*"longitude"\s*:\s*-?\d+(?:\.\d+)?'
            r'(?:\s*,\s*"[A-Za-z_][A-Za-z0-9_]*"\s*:\s*[^,}]+)*\s*\}'
        ),
        re.compile(
            r'"latitude"\s*:\s*-?\d+(?:\.\d+)?\s*,\s*"longitude"\s*:\s*-?\d+(?:\.\d+)?'
        ),
        re.compile(
            r"\b(?:current\s+location|location|coords|coordinates)\s*[:=]\s*"
            r"-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?",
            re.IGNORECASE,
        ),
        re.compile(
            r"\b(?:lat|latitude)\s*[:=]\s*-?\d+(?:\.\d+)?\s*[,;]\s*"
            r"(?:lng|lon|long|longitude)\s*[:=]\s*-?\d+(?:\.\d+)?",
            re.IGNORECASE,
        ),
        re.compile(r"\b-?\d{1,3}\.\d{2,}\s*,\s*-?\d{1,3}\.\d{2,}\b"),
    ]

    def _filter_value(value: Any, stats: FilterStats) -> Any:
        if isinstance(value, str):
            out = value
            for pattern in geo_patterns:
                out = pattern.sub(lambda _m: _count_geo(stats), out)
            for label, pattern in credential_patterns:
                out = pattern.sub(lambda _m, _label=label: _count_secret(stats, _label), out)
            return out
        if isinstance(value, dict):
            return {k: _filter_value(v, stats) for k, v in value.items()}
        if isinstance(value, list):
            return [_filter_value(v, stats) for v in value]
        return value

    def _count_geo(stats: FilterStats) -> str:
        stats.redaction_count += 1
        return "[REDACTED_GEO]"

    def _count_secret(stats: FilterStats, label: str) -> str:
        stats.redaction_count += 1
        stats.credential_hits[label] = stats.credential_hits.get(label, 0) + 1
        return f"<REDACTED:{label}>"

    def apply_privacy_filter(payload: dict[str, Any]) -> tuple[dict[str, Any], FilterStats]:
        stats = FilterStats()
        cleaned = _filter_value(payload, stats)
        if not isinstance(cleaned, dict):
            raise TypeError(f"privacy filter expected dict, got {type(payload).__name__}")
        return cleaned, stats

    return apply_privacy_filter, FilterStats


apply_privacy_filter, FilterStats = _load_privacy_filter()


# ---------------------------------------------------------------------------
# Action aliases and manifests
# ---------------------------------------------------------------------------


def normalize_action_name(name: Any) -> str:
    text = str(name or "").strip()
    text = re.sub(r"[\s.\-]+", "_", text)
    return text.upper()


@dataclass(frozen=True)
class ActionAliases:
    aliases: dict[str, str]
    prefix_aliases: tuple[tuple[str, str], ...]

    @classmethod
    def load(cls, path: Path) -> "ActionAliases":
        payload = json.loads(path.read_text(encoding="utf-8"))
        aliases = {
            normalize_action_name(k): normalize_action_name(v)
            for k, v in (payload.get("aliases") or {}).items()
            if str(k).strip() and str(v).strip()
        }
        prefixes: list[tuple[str, str]] = []
        for item in payload.get("prefixAliases") or []:
            if not isinstance(item, dict):
                continue
            src = normalize_action_name(item.get("from"))
            dst = normalize_action_name(item.get("to"))
            if src and dst:
                prefixes.append((src, dst))
        return cls(aliases=aliases, prefix_aliases=tuple(prefixes))

    def canonicalize(self, name: Any) -> str:
        normalized = normalize_action_name(name)
        if not normalized:
            return ""
        seen: set[str] = set()
        while normalized and normalized not in seen:
            seen.add(normalized)
            exact = self.aliases.get(normalized)
            if not exact:
                break
            normalized = exact
        for src, dst in self.prefix_aliases:
            if normalized.startswith(src):
                return f"{dst}{normalized[len(src):]}"
        return normalized


def normalize_json_schema(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        if raw.get("type") == "object":
            return raw
        if "properties" in raw:
            return {"type": "object", **raw}
    return {"type": "object", "properties": {}, "additionalProperties": True}


def tool_definition(name: str, description: str = "", parameters: Any = None) -> dict[str, Any]:
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": str(description or ""),
            "parameters": normalize_json_schema(parameters),
        },
    }


def load_action_manifest(path: Path | None, aliases: ActionAliases) -> dict[str, dict[str, Any]]:
    if path is None:
        return {}
    payload = json.loads(path.read_text(encoding="utf-8"))
    raw_actions = payload.get("actions") if isinstance(payload, dict) else payload
    if not isinstance(raw_actions, list):
        raise ValueError(f"action manifest {path} does not contain an actions list")

    out: dict[str, dict[str, Any]] = {}
    for item in raw_actions:
        if not isinstance(item, dict):
            continue
        fn = item.get("function") if isinstance(item.get("function"), dict) else item
        name = fn.get("name") if isinstance(fn, dict) else None
        if not isinstance(name, str) or not name.strip():
            continue
        canonical = aliases.canonicalize(name)
        params = fn.get("parameters") if isinstance(fn, dict) else None
        desc = fn.get("description") if isinstance(fn, dict) else ""
        out[canonical] = tool_definition(canonical, str(desc or ""), params)
    return out


# ---------------------------------------------------------------------------
# JSON input helpers
# ---------------------------------------------------------------------------


def _as_record(value: Any) -> dict[str, Any] | None:
    return value if isinstance(value, dict) else None


def _clean(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def _json_dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)


def stable_hash(*parts: Any, length: int = 24) -> str:
    h = hashlib.sha256()
    for part in parts:
        h.update(_json_dumps(part).encode("utf-8", "replace"))
        h.update(b"\0")
    return h.hexdigest()[:length]


def stable_unit(*parts: Any) -> float:
    digest = stable_hash(*parts, length=16)
    return int(digest, 16) / float(16**16)


def iter_input_files(paths: Iterable[str]) -> Iterable[Path]:
    for raw in paths:
        path = Path(raw)
        if path.is_dir():
            for child in sorted(path.rglob("*")):
                if child.is_file() and child.suffix.lower() in INPUT_SUFFIXES:
                    yield child
        else:
            yield path


def _expand_top_level(value: Any) -> Iterable[Any]:
    if isinstance(value, list):
        yield from value
        return
    if isinstance(value, dict) and "scenarios" not in value:
        for key in ("rows", "records", "examples", "data"):
            nested = value.get(key)
            if isinstance(nested, list):
                yield from nested
                return
    yield value


def read_json_records(path: Path) -> Iterable[Any]:
    text = path.read_text(encoding="utf-8").strip()
    if not text:
        return
    if text[0] in "[{":
        try:
            yield from _expand_top_level(json.loads(text))
            return
        except json.JSONDecodeError:
            pass

    for line_no, line in enumerate(text.splitlines(), start=1):
        line = line.strip()
        if not line:
            continue
        try:
            yield from _expand_top_level(json.loads(line))
        except json.JSONDecodeError as exc:
            LOG.warning("skip invalid JSON %s:%d: %s", path, line_no, exc)


# ---------------------------------------------------------------------------
# Message and tool normalization
# ---------------------------------------------------------------------------


def content_to_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        parts: list[str] = []
        for item in value:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                for key in ("text", "content", "value"):
                    text = item.get(key)
                    if isinstance(text, str):
                        parts.append(text)
                        break
                else:
                    parts.append(_json_dumps(item))
            else:
                parts.append(str(item))
        return "\n".join(p for p in parts if p)
    return _json_dumps(value)


def normalize_role(value: Any) -> str:
    role = str(value or "user").strip().lower()
    if role in {"system", "user", "assistant", "tool"}:
        return role
    if role in {"developer"}:
        return "system"
    if role in {"model", "ai", "gpt"}:
        return "assistant"
    if role in {"function", "tool_output", "observation"}:
        return "tool"
    return "user"


def normalize_message(raw: Any, aliases: ActionAliases | None = None) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    msg: dict[str, Any] = {
        "role": normalize_role(raw.get("role") or raw.get("from")),
        "content": content_to_text(raw.get("content", raw.get("value", ""))),
    }
    if isinstance(raw.get("name"), str):
        msg["name"] = raw["name"]
    if isinstance(raw.get("tool_call_id"), str):
        msg["tool_call_id"] = raw["tool_call_id"]
    raw_calls = raw.get("tool_calls", raw.get("toolCalls"))
    if aliases is not None and isinstance(raw_calls, list):
        tool_calls: list[dict[str, Any]] = []
        for idx, item in enumerate(raw_calls):
            normalized = normalize_tool_call(item, aliases, fallback_index=idx)
            if normalized is not None:
                tool_calls.append(normalized[0])
        if tool_calls:
            msg["tool_calls"] = tool_calls
    return msg


def coerce_arguments(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str):
        stripped = raw.strip()
        if not stripped:
            return {}
        try:
            decoded = json.loads(stripped)
            if isinstance(decoded, dict):
                return decoded
        except json.JSONDecodeError:
            pass
        return {"value": stripped}
    if raw is None:
        return {}
    return {"value": raw}


def _raw_tool_call_name(raw: dict[str, Any]) -> str:
    fn = raw.get("function") if isinstance(raw.get("function"), dict) else {}
    return str(
        raw.get("name")
        or raw.get("toolName")
        or raw.get("tool_name")
        or raw.get("tool")
        or fn.get("name")
        or ""
    )


def _raw_tool_call_args(raw: dict[str, Any]) -> Any:
    fn = raw.get("function") if isinstance(raw.get("function"), dict) else {}
    for key in ("arguments", "args", "input", "parameters"):
        if key in raw:
            return raw[key]
    if "arguments" in fn:
        return fn["arguments"]
    return {}


def normalize_tool_call(
    raw: Any,
    aliases: ActionAliases,
    *,
    fallback_index: int,
) -> tuple[dict[str, Any], dict[str, Any]] | None:
    if not isinstance(raw, dict):
        return None
    original_name = _raw_tool_call_name(raw)
    canonical = aliases.canonicalize(original_name)
    if not canonical:
        return None
    args = coerce_arguments(_raw_tool_call_args(raw))
    call_id = str(
        raw.get("id")
        or raw.get("toolCallId")
        or raw.get("tool_call_id")
        or f"call_{fallback_index}"
    )
    message_call = {
        "id": call_id,
        "type": "function",
        "function": {
            "name": canonical,
            "arguments": args,
        },
    }
    action = {
        "name": canonical,
        "originalName": normalize_action_name(original_name),
        "arguments": args,
    }
    return message_call, action


def normalize_tools(raw_tools: Any, aliases: ActionAliases) -> dict[str, dict[str, Any]]:
    tools: dict[str, dict[str, Any]] = {}
    if isinstance(raw_tools, dict):
        items = raw_tools.items()
        for name, spec in items:
            spec_obj = spec if isinstance(spec, dict) else {}
            fn = spec_obj.get("function") if isinstance(spec_obj.get("function"), dict) else spec_obj
            raw_name = fn.get("name") if isinstance(fn, dict) and isinstance(fn.get("name"), str) else name
            canonical = aliases.canonicalize(raw_name)
            if not canonical:
                continue
            desc = fn.get("description", "") if isinstance(fn, dict) else ""
            params = (
                fn.get("parameters", fn.get("inputSchema", fn.get("schema")))
                if isinstance(fn, dict)
                else None
            )
            tools[canonical] = tool_definition(canonical, str(desc or ""), params)
        return tools

    if not isinstance(raw_tools, list):
        return tools
    for item in raw_tools:
        if not isinstance(item, dict):
            continue
        fn = item.get("function") if isinstance(item.get("function"), dict) else item
        name = fn.get("name") if isinstance(fn, dict) else None
        if not isinstance(name, str) or not name.strip():
            continue
        canonical = aliases.canonicalize(name)
        desc = fn.get("description", "") if isinstance(fn, dict) else ""
        params = fn.get("parameters", fn.get("inputSchema", fn.get("schema"))) if isinstance(fn, dict) else None
        tools[canonical] = tool_definition(canonical, str(desc or ""), params)
    return tools


def finalize_tools(
    existing: dict[str, dict[str, Any]],
    actions: list[dict[str, Any]],
    manifest_tools: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    out = dict(existing)
    for action in actions:
        name = action["name"]
        if name in out:
            continue
        if name in manifest_tools:
            out[name] = manifest_tools[name]
        else:
            out[name] = tool_definition(name)
    return [out[name] for name in sorted(out)]


def actions_from_message_tool_calls(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    actions: list[dict[str, Any]] = []
    for message in messages:
        raw_calls = message.get("tool_calls")
        if not isinstance(raw_calls, list):
            continue
        for raw in raw_calls:
            if not isinstance(raw, dict):
                continue
            fn = raw.get("function") if isinstance(raw.get("function"), dict) else {}
            name = fn.get("name")
            if not isinstance(name, str) or not name.strip():
                continue
            actions.append(
                {
                    "name": name,
                    "originalName": normalize_action_name(name),
                    "arguments": coerce_arguments(fn.get("arguments")),
                }
            )
    return actions


def raw_response_tool_calls(response: dict[str, Any]) -> list[Any]:
    for key in ("toolCalls", "tool_calls", "toolcalls"):
        calls = response.get(key)
        if isinstance(calls, list):
            return calls
    return []


# ---------------------------------------------------------------------------
# Native row conversion
# ---------------------------------------------------------------------------


def infer_native_task_type(record: dict[str, Any]) -> str:
    metadata = _as_record(record.get("metadata")) or {}
    explicit = _clean(metadata.get("task_type") or metadata.get("taskType"))
    if explicit:
        return "response" if explicit == "reply" else explicit

    tokens: list[str] = []
    for key in ("purpose", "actionType", "stepType", "modelType"):
        value = _clean(record.get(key))
        if value:
            tokens.append(value.lower())
    tags = record.get("tags")
    if isinstance(tags, list):
        tokens.extend(_clean(tag).lower() for tag in tags if _clean(tag))

    token_text = " ".join(tokens).replace("-", "_")
    if "context_routing" in token_text:
        return "context_routing"
    if "should_respond" in token_text or "response_handler" in token_text:
        return "should_respond"
    if any(part in token_text for part in ("action_planner", "planner", "runtime_use_model")):
        return "action_planner"
    if any(part in token_text for part in ("media_description", "describe_image", "describe_audio")):
        return "media_description"
    return "response"


def is_native_row(raw: Any) -> bool:
    rec = _as_record(raw)
    return bool(rec and rec.get("format") == NATIVE_FORMAT and rec.get("boundary") in NATIVE_BOUNDARIES)


def _has_request_payload(request: dict[str, Any]) -> bool:
    messages = request.get("messages")
    if isinstance(messages, list) and messages:
        return True
    prompt = request.get("prompt")
    return isinstance(prompt, str) and bool(prompt.strip())


def _has_response_payload(response: dict[str, Any]) -> bool:
    if isinstance(response.get("text"), str) and response["text"].strip():
        return True
    return bool(raw_response_tool_calls(response))


def messages_from_native_request(request: dict[str, Any], aliases: ActionAliases) -> list[dict[str, Any]]:
    messages: list[dict[str, Any]] = []
    system = request.get("system")
    if isinstance(system, str) and system.strip():
        messages.append({"role": "system", "content": system.strip()})
    raw_messages = request.get("messages")
    if isinstance(raw_messages, list) and raw_messages:
        for raw in raw_messages:
            msg = normalize_message(raw, aliases)
            if msg is not None:
                messages.append(msg)
    else:
        prompt = content_to_text(request.get("prompt"))
        if prompt.strip():
            messages.append({"role": "user", "content": prompt})
    return messages


def native_success_and_score(row: dict[str, Any]) -> tuple[bool, float, list[str]]:
    reasons: list[str] = []
    status = str(row.get("status") or "").strip().lower()
    if status in {"error", "timeout", "failed", "failure"}:
        reasons.append(f"native_status={status}")
        return False, 0.0, reasons
    reward = row.get("reward")
    metadata = _as_record(row.get("metadata")) or {}
    if reward is None:
        reward = metadata.get("reward")
    if isinstance(reward, (int, float)):
        score = max(0.0, min(1.0, float(reward)))
        success = score >= 0.5
        if not success:
            reasons.append(f"native_reward={score:.3f}")
        return success, score, reasons
    return True, 1.0, reasons


def quality_block(success: bool, score: float, reasons: list[str]) -> dict[str, Any]:
    score = max(0.0, min(1.0, float(score)))
    if not success:
        rating = "repair"
        weight = 0.0
    elif score >= 0.99:
        rating = "gold"
        weight = score
    elif score >= 0.8:
        rating = "silver"
        weight = score
    else:
        rating = "bronze"
        weight = score
    return {
        "success": bool(success),
        "score": score,
        "weight": weight,
        "rating": rating,
        "requiresRepair": not success,
        "reasons": list(reasons),
    }


def target_block(base_model: str) -> dict[str, str]:
    return {
        "modelFamily": "qwen",
        "baseModel": base_model,
        "sftFormat": "messages",
        "chatTemplate": "chatml",
    }


def record_source(
    *,
    kind: str,
    dataset: str,
    path: Path,
    row_index: int,
    source_id: str | None,
    trajectory_id: str | None,
    scenario_id: str | None,
    turn_index: int | None,
    fmt: str | None,
) -> dict[str, Any]:
    return {
        "kind": kind,
        "dataset": dataset,
        "path": str(path),
        "rowIndex": int(row_index),
        "sourceId": source_id,
        "trajectoryId": trajectory_id,
        "scenarioId": scenario_id,
        "turnIndex": turn_index,
        "format": fmt,
    }


def build_native_record(
    row: dict[str, Any],
    *,
    path: Path,
    row_index: int,
    aliases: ActionAliases,
    manifest_tools: dict[str, dict[str, Any]],
    base_model: str,
) -> dict[str, Any] | None:
    request = _as_record(row.get("request")) or {}
    response = _as_record(row.get("response")) or {}
    if not _has_request_payload(request) or not _has_response_payload(response):
        return None

    messages = messages_from_native_request(request, aliases)
    if not messages or not any(message.get("role") == "user" for message in messages):
        return None

    context_actions = actions_from_message_tool_calls(messages)
    raw_tool_calls = raw_response_tool_calls(response)
    tool_calls: list[dict[str, Any]] = []
    actions: list[dict[str, Any]] = []
    for idx, raw in enumerate(raw_tool_calls):
        normalized = normalize_tool_call(raw, aliases, fallback_index=idx)
        if normalized is None:
            continue
        msg_call, action = normalized
        tool_calls.append(msg_call)
        actions.append(action)

    assistant: dict[str, Any] = {
        "role": "assistant",
        "content": content_to_text(response.get("text")),
    }
    if tool_calls:
        assistant["tool_calls"] = tool_calls
    messages.append(assistant)

    tools = normalize_tools(request.get("tools"), aliases)
    tools_list = finalize_tools(tools, [*context_actions, *actions], manifest_tools)

    metadata = _as_record(row.get("metadata")) or {}
    task = infer_native_task_type(row)
    success, score, reasons = native_success_and_score(row)
    trajectory_id = _clean(metadata.get("trajectory_id")) or _clean(row.get("trajectoryId")) or None
    step_id = _clean(metadata.get("step_id")) or _clean(row.get("stepId")) or None
    call_id = _clean(metadata.get("call_id")) or _clean(row.get("callId")) or None
    source_id = "|".join(part for part in (trajectory_id, step_id, call_id) if part) or None
    record_id = stable_hash("native", path.as_posix(), row_index, source_id, messages)
    return {
        "schema": SCHEMA_VERSION,
        "id": record_id,
        "split": "repair_eval",
        "task": task,
        "target": target_block(base_model),
        "messages": messages,
        "tools": tools_list,
        "actions": actions,
        "quality": quality_block(success, score, reasons),
        "source": record_source(
            kind=NATIVE_FORMAT,
            dataset=str(metadata.get("source_dataset") or metadata.get("dataset") or "runtime_trajectory_boundary"),
            path=path,
            row_index=row_index,
            source_id=source_id,
            trajectory_id=trajectory_id,
            scenario_id=_clean(row.get("scenarioId")) or _clean(metadata.get("scenario_id")) or None,
            turn_index=int(row["stepIndex"]) if isinstance(row.get("stepIndex"), int) else None,
            fmt=NATIVE_FORMAT,
        ),
        "metadata": {
            "boundary": row.get("boundary"),
            "model": row.get("model"),
            "provider": row.get("provider"),
            "finishReason": response.get("finishReason"),
            "promptTokens": (_as_record(response.get("usage")) or {}).get("promptTokens"),
            "completionTokens": (_as_record(response.get("usage")) or {}).get("completionTokens"),
            "cacheReadInputTokens": (_as_record(response.get("usage")) or {}).get("cacheReadInputTokens"),
        },
    }


# ---------------------------------------------------------------------------
# LifeOpsBench conversion
# ---------------------------------------------------------------------------


def is_lifeops_result(raw: Any) -> bool:
    rec = _as_record(raw)
    if not rec:
        return False
    if isinstance(rec.get("scenarios"), list) and ("pass_at_1" in rec or "model_name" in rec):
        return True
    return "scenario_id" in rec and isinstance(rec.get("turns"), list) and "total_score" in rec


def _scenario_instruction_from_repo() -> dict[str, dict[str, Any]]:
    bench_pkg = REPO_ROOT / "packages" / "benchmarks" / "lifeops-bench"
    if not bench_pkg.exists():
        return {}
    sys.path.insert(0, str(bench_pkg))
    try:
        from eliza_lifeops_bench.scenarios import SCENARIOS_BY_ID  # type: ignore
    except Exception:
        LOG.debug("could not import LifeOpsBench scenario registry", exc_info=True)
        return {}
    out: dict[str, dict[str, Any]] = {}
    for scenario_id, scenario in SCENARIOS_BY_ID.items():
        out[str(scenario_id)] = {
            "instruction": getattr(scenario, "instruction", ""),
            "name": getattr(scenario, "name", ""),
            "domain": getattr(getattr(scenario, "domain", None), "value", None),
            "mode": getattr(getattr(scenario, "mode", None), "value", None),
        }
    return out


def load_lifeops_scenarios(path: Path | None) -> dict[str, dict[str, Any]]:
    scenarios = _scenario_instruction_from_repo()
    if path is None:
        return scenarios
    payload = json.loads(path.read_text(encoding="utf-8"))
    raw_items = payload.get("scenarios") if isinstance(payload, dict) else payload
    if not isinstance(raw_items, list):
        raise ValueError(f"scenario file {path} must contain a list or scenarios list")
    for item in raw_items:
        if not isinstance(item, dict):
            continue
        scenario_id = str(item.get("id") or item.get("scenario_id") or "")
        if not scenario_id:
            continue
        scenarios[scenario_id] = {
            "instruction": str(item.get("instruction") or item.get("prompt") or ""),
            "name": str(item.get("name") or ""),
            "domain": item.get("domain"),
            "mode": item.get("mode"),
        }
    return scenarios


def _extract_scenario_results(raw: dict[str, Any]) -> Iterable[dict[str, Any]]:
    if isinstance(raw.get("scenarios"), list):
        for item in raw["scenarios"]:
            if isinstance(item, dict):
                yield item
        return
    yield raw


def lifeops_success_and_score(
    scenario: dict[str, Any],
    *,
    threshold: float,
) -> tuple[bool, float, list[str]]:
    score_raw = scenario.get("total_score", 0.0)
    max_raw = scenario.get("max_score", 1.0)
    try:
        score = float(score_raw) / (float(max_raw) if float(max_raw) > 0 else 1.0)
    except (TypeError, ValueError):
        score = 0.0
    score = max(0.0, min(1.0, score))
    reasons: list[str] = []
    if scenario.get("error"):
        reasons.append("lifeops_error")
    terminated = str(scenario.get("terminated_reason") or "")
    if terminated in {"error", "timeout", "cost_exceeded", "max_turns"}:
        reasons.append(f"terminated={terminated}")
    if score < threshold:
        reasons.append(f"score={score:.3f}<threshold={threshold:.3f}")
    success = not reasons and score >= threshold
    return success, score, reasons


def action_from_lifeops(raw: Any, aliases: ActionAliases) -> tuple[dict[str, Any], dict[str, Any]] | None:
    if not isinstance(raw, dict):
        return None
    name = raw.get("name")
    if not isinstance(name, str) or not name.strip():
        return None
    canonical = aliases.canonicalize(name)
    args = coerce_arguments(raw.get("kwargs", raw.get("arguments", raw.get("args", {}))))
    msg_call = {
        "id": str(raw.get("id") or f"call_{stable_hash(name, args, length=10)}"),
        "type": "function",
        "function": {"name": canonical, "arguments": args},
    }
    action = {
        "name": canonical,
        "originalName": normalize_action_name(name),
        "arguments": args,
    }
    return msg_call, action


def build_lifeops_records(
    result: dict[str, Any],
    *,
    path: Path,
    row_index: int,
    aliases: ActionAliases,
    manifest_tools: dict[str, dict[str, Any]],
    base_model: str,
    scenario_lookup: dict[str, dict[str, Any]],
    success_threshold: float,
) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for scenario_offset, scenario in enumerate(_extract_scenario_results(result)):
        scenario_id = str(scenario.get("scenario_id") or scenario.get("scenarioId") or "")
        scenario_meta = scenario_lookup.get(scenario_id, {})
        instruction = str(
            scenario.get("instruction")
            or scenario.get("scenario_instruction")
            or scenario_meta.get("instruction")
            or ""
        ).strip()
        missing_instruction = False
        if not instruction:
            instruction = f"LifeOpsBench scenario {scenario_id or '<unknown>'}"
            missing_instruction = True

        success, score, reasons = lifeops_success_and_score(scenario, threshold=success_threshold)
        if missing_instruction:
            reasons = [*reasons, "missing_lifeops_instruction"]
            success = False

        history: list[dict[str, Any]] = [{"role": "user", "content": instruction}]
        turns = scenario.get("turns") if isinstance(scenario.get("turns"), list) else []
        for turn_idx, turn in enumerate(turns):
            if not isinstance(turn, dict):
                continue
            raw_actions = turn.get("agent_actions") if isinstance(turn.get("agent_actions"), list) else []
            tool_calls: list[dict[str, Any]] = []
            actions: list[dict[str, Any]] = []
            for raw_action in raw_actions:
                normalized = action_from_lifeops(raw_action, aliases)
                if normalized is None:
                    continue
                msg_call, action = normalized
                tool_calls.append(msg_call)
                actions.append(action)

            assistant: dict[str, Any] = {
                "role": "assistant",
                "content": content_to_text(turn.get("agent_message")),
            }
            if tool_calls:
                assistant["tool_calls"] = tool_calls
            if not assistant["content"] and not tool_calls:
                continue

            messages = [dict(msg) for msg in history]
            messages.append(assistant)
            tools = finalize_tools({}, actions, manifest_tools)
            record_id = stable_hash(
                "lifeops",
                path.as_posix(),
                row_index,
                scenario_id,
                scenario.get("seed"),
                scenario_offset,
                turn_idx,
                messages,
            )
            records.append(
                {
                    "schema": SCHEMA_VERSION,
                    "id": record_id,
                    "split": "repair_eval",
                    "task": "lifeops_trajectory_turn",
                    "target": target_block(base_model),
                    "messages": messages,
                    "tools": tools,
                    "actions": actions,
                    "quality": quality_block(success, score, reasons),
                    "source": record_source(
                        kind="lifeops_bench_result",
                        dataset="lifeops_bench",
                        path=path,
                        row_index=row_index,
                        source_id=f"{scenario_id}#{scenario.get('seed', '')}#{turn_idx}",
                        trajectory_id=None,
                        scenario_id=scenario_id or None,
                        turn_index=turn_idx,
                        fmt="lifeops_bench_result.v1",
                    ),
                    "metadata": {
                        "benchmarkModel": result.get("model_name"),
                        "judgeModel": result.get("judge_model_name"),
                        "scenarioName": scenario_meta.get("name"),
                        "domain": scenario_meta.get("domain"),
                        "mode": scenario_meta.get("mode"),
                        "seed": scenario.get("seed"),
                        "terminatedReason": scenario.get("terminated_reason"),
                        "stateHashMatch": scenario.get("state_hash_match"),
                        "outputSubstringMatches": scenario.get("output_substring_matches"),
                        "latencyMs": turn.get("latency_ms"),
                        "inputTokens": turn.get("input_tokens"),
                        "outputTokens": turn.get("output_tokens"),
                        "costUsd": turn.get("cost_usd"),
                    },
                }
            )

            history.append(assistant)
            user_response = content_to_text(turn.get("user_response"))
            if user_response.strip():
                history.append({"role": "user", "content": user_response})
    return records


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------


@dataclass
class PrepStats:
    seen: int = 0
    produced: int = 0
    skipped: int = 0
    privacy_redactions: int = 0
    privacy_anonymizations: int = 0
    credential_hits: Counter[str] = field(default_factory=Counter)
    source_counts: Counter[str] = field(default_factory=Counter)
    task_counts: Counter[str] = field(default_factory=Counter)
    action_counts: Counter[str] = field(default_factory=Counter)


def _stats_int(stats: Any, *names: str) -> int:
    total = 0
    for name in names:
        value = getattr(stats, name, 0)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            total += int(value)
    return total


def _stats_counter(stats: Any, *names: str) -> Counter[str]:
    out: Counter[str] = Counter()
    for name in names:
        value = getattr(stats, name, None)
        if isinstance(value, dict):
            for key, count in value.items():
                if isinstance(count, (int, float)) and not isinstance(count, bool):
                    out[str(key)] += int(count)
    return out


def _credential_hits(stats: Any) -> Counter[str]:
    direct = _stats_counter(stats, "credential_hits")
    if direct:
        return direct
    by_category = _stats_counter(stats, "redactions_by_category")
    secret_count = by_category.get("secret", 0)
    if secret_count:
        return Counter({"secret": secret_count})
    return Counter()


def split_success_record(record: dict[str, Any], *, seed: str, val_ratio: float, test_ratio: float) -> str:
    unit = stable_unit(seed, record["id"])
    if unit < test_ratio:
        return "test"
    if unit < test_ratio + val_ratio:
        return "val"
    return "train"


def write_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False, separators=(",", ":"), sort_keys=True))
            f.write("\n")


def normalize_output_format(value: str) -> str:
    if value == OUTPUT_FORMAT_NATIVE_ALIAS:
        return OUTPUT_FORMAT_NATIVE
    return value


def _stringify_tool_arguments(value: Any) -> str:
    if isinstance(value, str):
        return value
    if value is None:
        return "{}"
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


def _request_message_for_native(message: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {
        "role": message.get("role"),
        "content": content_to_text(message.get("content")),
    }
    for key in ("name", "tool_call_id"):
        if isinstance(message.get(key), str):
            out[key] = message[key]

    raw_calls = message.get("tool_calls")
    if isinstance(raw_calls, list):
        calls: list[dict[str, Any]] = []
        for idx, raw in enumerate(raw_calls):
            if not isinstance(raw, dict):
                continue
            fn = raw.get("function") if isinstance(raw.get("function"), dict) else {}
            name = fn.get("name")
            if not isinstance(name, str) or not name.strip():
                continue
            calls.append(
                {
                    "id": str(raw.get("id") or f"call_{idx}"),
                    "type": "function",
                    "function": {
                        "name": name,
                        "arguments": _stringify_tool_arguments(fn.get("arguments")),
                    },
                }
            )
        if calls:
            out["tool_calls"] = calls
    return out


def _response_tool_call_for_native(call: dict[str, Any], fallback_index: int) -> dict[str, Any] | None:
    fn = call.get("function") if isinstance(call.get("function"), dict) else {}
    name = fn.get("name")
    if not isinstance(name, str) or not name.strip():
        return None
    return {
        "toolCallId": str(call.get("id") or f"call_{fallback_index}"),
        "toolName": name,
        "input": coerce_arguments(fn.get("arguments")),
    }


def trajectory_record_to_eliza_native(record: dict[str, Any]) -> dict[str, Any] | None:
    """Convert an auditable trajectory record into train_local.py input.

    `train_local.py` delegates to `format_for_training.format_record`, whose
    accepted runtime trajectory input is `eliza_native_v1`. This conversion
    keeps the train/val/test files on that existing path while preserving the
    richer candidate record under `trajectory_records/` when requested.
    """

    messages = record.get("messages")
    if not isinstance(messages, list) or not messages:
        return None
    last = messages[-1]
    if not isinstance(last, dict) or last.get("role") != "assistant":
        return None

    request_messages = [
        _request_message_for_native(message)
        for message in messages[:-1]
        if isinstance(message, dict)
    ]
    if not any(message.get("role") == "user" for message in request_messages):
        return None

    response: dict[str, Any] = {"text": content_to_text(last.get("content"))}
    raw_calls = last.get("tool_calls")
    if isinstance(raw_calls, list):
        tool_calls = [
            call
            for idx, raw in enumerate(raw_calls)
            if isinstance(raw, dict)
            if (call := _response_tool_call_for_native(raw, idx)) is not None
        ]
        if tool_calls:
            response["toolCalls"] = tool_calls
    if not response["text"].strip() and not response.get("toolCalls"):
        return None

    request: dict[str, Any] = {"messages": request_messages}
    tools = record.get("tools")
    if isinstance(tools, list) and tools:
        request["tools"] = tools

    source = _as_record(record.get("source")) or {}
    metadata = _as_record(record.get("metadata")) or {}
    native_metadata = {
        "task_type": record.get("task") or "response",
        "source_dataset": source.get("dataset") or "trajectory_dataset",
        "split": record.get("split"),
        "trajectory_record_id": record.get("id"),
        "trajectory_schema": record.get("schema"),
        "quality": record.get("quality"),
        "source": source,
        "target": record.get("target"),
        "trajectory_metadata": metadata,
    }
    native_row: dict[str, Any] = {
        "format": NATIVE_FORMAT,
        "boundary": metadata.get("boundary") or TRAINING_BOUNDARY,
        "request": request,
        "response": response,
        "metadata": native_metadata,
    }
    if isinstance(source.get("trajectoryId"), str) and source["trajectoryId"]:
        native_row["trajectoryId"] = source["trajectoryId"]
    if isinstance(source.get("scenarioId"), str) and source["scenarioId"]:
        native_row["scenarioId"] = source["scenarioId"]
    if isinstance(source.get("turnIndex"), int):
        native_row["stepIndex"] = source["turnIndex"]
    return native_row


def materialize_output_splits(
    splits: dict[str, list[dict[str, Any]]],
    *,
    output_format: str,
) -> tuple[dict[str, list[dict[str, Any]]], dict[str, list[dict[str, Any]]] | None]:
    normalized = normalize_output_format(output_format)
    if normalized == OUTPUT_FORMAT_TRAJECTORY:
        return splits, None

    trainable: dict[str, list[dict[str, Any]]] = {split: [] for split in splits}
    failed: list[str] = []
    for split, rows in splits.items():
        for row in rows:
            native = trajectory_record_to_eliza_native(row)
            if native is None:
                failed.append(str(row.get("id") or f"{split}:{len(failed)}"))
                continue
            trainable[split].append(native)
    if failed:
        shown = ", ".join(failed[:5])
        extra = "" if len(failed) <= 5 else f" (+{len(failed) - 5} more)"
        raise SystemExit(f"{len(failed)} record(s) cannot be converted to {NATIVE_FORMAT}: {shown}{extra}")

    trajectory = splits if normalized == OUTPUT_FORMAT_BOTH else None
    return trainable, trajectory


def prepare(args: argparse.Namespace) -> tuple[dict[str, list[dict[str, Any]]], dict[str, Any]]:
    if args.val_ratio < 0 or args.test_ratio < 0 or args.val_ratio + args.test_ratio >= 1:
        raise SystemExit("--val-ratio and --test-ratio must be non-negative and sum to < 1")

    aliases = ActionAliases.load(Path(args.action_aliases))
    manifest_tools = load_action_manifest(Path(args.action_manifest) if args.action_manifest else None, aliases)
    scenario_lookup = load_lifeops_scenarios(Path(args.lifeops_scenarios) if args.lifeops_scenarios else None)

    splits: dict[str, list[dict[str, Any]]] = {"train": [], "val": [], "test": [], "repair_eval": []}
    stats = PrepStats()
    max_records = int(args.max_records or 0)

    for path in iter_input_files(args.input):
        if not path.exists():
            raise SystemExit(f"input path does not exist: {path}")
        LOG.info("reading %s", path)
        for row_index, raw in enumerate(read_json_records(path)):
            stats.seen += 1
            if not isinstance(raw, dict):
                stats.skipped += 1
                continue
            cleaned, privacy_stats = apply_privacy_filter(raw)
            redactions = _stats_int(privacy_stats, "redaction_count", "redactions_total")
            anonymizations = _stats_int(privacy_stats, "anonymization_count", "anonymizations_total")
            credential_hits = _credential_hits(privacy_stats)
            stats.privacy_redactions += redactions
            stats.privacy_anonymizations += anonymizations
            stats.credential_hits.update(credential_hits)
            if args.strict_privacy and (redactions or anonymizations or credential_hits):
                raise SystemExit(
                    f"strict privacy filter found redaction(s) in {path}:{row_index}: "
                    f"redactions={redactions} anonymizations={anonymizations} "
                    f"credential_hits={sorted(credential_hits)}"
                )

            produced: list[dict[str, Any]] = []
            if is_native_row(cleaned):
                record = build_native_record(
                    cleaned,
                    path=path,
                    row_index=row_index,
                    aliases=aliases,
                    manifest_tools=manifest_tools,
                    base_model=args.base_model,
                )
                if record is not None:
                    produced.append(record)
            elif is_lifeops_result(cleaned):
                produced.extend(
                    build_lifeops_records(
                        cleaned,
                        path=path,
                        row_index=row_index,
                        aliases=aliases,
                        manifest_tools=manifest_tools,
                        base_model=args.base_model,
                        scenario_lookup=scenario_lookup,
                        success_threshold=args.lifeops_success_threshold,
                    )
                )
            else:
                stats.skipped += 1
                continue

            if not produced:
                stats.skipped += 1
                continue

            for record in produced:
                if record["quality"]["success"]:
                    split = split_success_record(
                        record,
                        seed=args.seed,
                        val_ratio=args.val_ratio,
                        test_ratio=args.test_ratio,
                    )
                else:
                    split = "repair_eval"
                record["split"] = split
                splits[split].append(record)
                stats.produced += 1
                stats.source_counts[record["source"]["kind"]] += 1
                stats.task_counts[record["task"]] += 1
                for action in record["actions"]:
                    stats.action_counts[action["name"]] += 1
                if max_records and stats.produced >= max_records:
                    break
            if max_records and stats.produced >= max_records:
                break
        if max_records and stats.produced >= max_records:
            break

    manifest = {
        "schema": MANIFEST_SCHEMA,
        "recordSchema": NATIVE_FORMAT
        if normalize_output_format(args.output_format) in TRAINABLE_OUTPUT_FORMATS
        else SCHEMA_VERSION,
        "trajectoryRecordSchema": SCHEMA_VERSION,
        "trainingReadySchema": NATIVE_FORMAT
        if normalize_output_format(args.output_format) in TRAINABLE_OUTPUT_FORMATS
        else None,
        "outputFormat": args.output_format,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "target": target_block(args.base_model),
        "inputs": list(args.input),
        "outputDir": str(Path(args.output_dir)),
        "files": {
            "train": "train.jsonl",
            "val": "val.jsonl",
            "test": "test.jsonl",
            "repair_eval": "repair_eval.jsonl",
        },
        "trainingFiles": {
            "train": "train.jsonl",
            "val": "val.jsonl",
            "test": "test.jsonl",
        }
        if normalize_output_format(args.output_format) in TRAINABLE_OUTPUT_FORMATS
        else {},
        "trajectoryFiles": {
            "train": "trajectory_records/train.jsonl",
            "val": "trajectory_records/val.jsonl",
            "test": "trajectory_records/test.jsonl",
            "repair_eval": "trajectory_records/repair_eval.jsonl",
        }
        if normalize_output_format(args.output_format) == OUTPUT_FORMAT_BOTH
        else (
            {
                "train": "train.jsonl",
                "val": "val.jsonl",
                "test": "test.jsonl",
                "repair_eval": "repair_eval.jsonl",
            }
            if normalize_output_format(args.output_format) == OUTPUT_FORMAT_TRAJECTORY
            else {}
        ),
        "counts": {split: len(rows) for split, rows in splits.items()},
        "successRecords": sum(len(splits[name]) for name in ("train", "val", "test")),
        "repairEvalRecords": len(splits["repair_eval"]),
        "seenRecords": stats.seen,
        "producedRecords": stats.produced,
        "skippedRecords": stats.skipped,
        "sourceCounts": dict(sorted(stats.source_counts.items())),
        "taskCounts": dict(sorted(stats.task_counts.items())),
        "actionCounts": dict(sorted(stats.action_counts.items())),
        "privacy": {
            "redactions": stats.privacy_redactions,
            "anonymizations": stats.privacy_anonymizations,
            "credentialHits": dict(sorted(stats.credential_hits.items())),
            "strict": bool(args.strict_privacy),
        },
        "split": {
            "seed": args.seed,
            "valRatio": args.val_ratio,
            "testRatio": args.test_ratio,
        },
        "actionAliases": str(Path(args.action_aliases)),
        "actionManifest": {
            "path": str(Path(args.action_manifest)) if args.action_manifest else None,
            "actionCount": len(manifest_tools),
        },
        "lifeopsSuccessThreshold": args.lifeops_success_threshold,
    }
    return splits, manifest


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--input",
        action="append",
        required=True,
        help="Input JSON/JSONL file or directory. Repeatable.",
    )
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--base-model", default="Qwen3.5/3.6")
    parser.add_argument("--val-ratio", type=float, default=0.05)
    parser.add_argument("--test-ratio", type=float, default=0.05)
    parser.add_argument("--seed", default="eliza1-trajectory-sft-v1")
    parser.add_argument("--max-records", type=int, default=0)
    parser.add_argument(
        "--output-format",
        choices=[
            OUTPUT_FORMAT_BOTH,
            OUTPUT_FORMAT_NATIVE,
            OUTPUT_FORMAT_NATIVE_ALIAS,
            OUTPUT_FORMAT_TRAJECTORY,
        ],
        default=OUTPUT_FORMAT_BOTH,
        help=(
            "Root split format. Default 'both' writes train/val/test as "
            "train_local.py-compatible eliza_native_v1 rows and writes the "
            "candidate trajectory schema under trajectory_records/. "
            "'eliza-record' is a compatibility alias for eliza-native."
        ),
    )
    parser.add_argument("--action-aliases", default=str(DEFAULT_ALIAS_PATH))
    parser.add_argument("--action-manifest", default="")
    parser.add_argument(
        "--lifeops-scenarios",
        default="",
        help="Optional JSON scenario metadata with id/instruction fields.",
    )
    parser.add_argument("--lifeops-success-threshold", type=float, default=0.99)
    parser.add_argument("--strict-privacy", action="store_true")
    parser.add_argument("--verbose", "-v", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
    )
    splits, manifest = prepare(args)
    output_dir = Path(args.output_dir)
    root_splits, trajectory_splits = materialize_output_splits(
        splits,
        output_format=args.output_format,
    )
    for split, rows in root_splits.items():
        write_jsonl(output_dir / manifest["files"][split], rows)
    if trajectory_splits is not None:
        for split, rows in trajectory_splits.items():
            write_jsonl(output_dir / "trajectory_records" / manifest["files"][split], rows)
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "manifest.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(manifest, indent=2, ensure_ascii=False, sort_keys=True))
    return 0 if manifest["successRecords"] or manifest["repairEvalRecords"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
