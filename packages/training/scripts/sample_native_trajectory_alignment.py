#!/usr/bin/env python3
"""Sample downloaded corpora and build native trajectory alignment fixtures.

The v5 native-tool refactor needs training rows that resemble the actual model
calls the runtime makes: message handler, planner, tool result, evaluator, then
the next planner call with an append-only context suffix. This harness creates
three artifacts for review:

1. Three raw samples per downloaded dataset.
2. A feature/similarity matrix showing how close each source is to the runtime
   stages we need to train.
3. Reference trajectories for simple, wallet, email, and calendar tasks,
   including the provider request/response envelope used by Cerebras and the
   Vercel AI Gateway adapter.

When CEREBRAS_API_KEY is present and --run-cerebras is set, the reference model
stages call https://api.cerebras.ai/v1/chat/completions with gpt-oss-120b.
Without a key, the script writes deterministic fixture responses and marks the
run as offline; this keeps the data-prep audit reproducible in CI and on local
machines without credentials.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import re
import time
import urllib.error
import urllib.request
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

import yaml

try:  # pyarrow is in packages/training/pyproject.toml.
    import pyarrow.parquet as pq
except Exception:  # pragma: no cover - exercised only in slim envs.
    pq = None


ROOT = Path(__file__).resolve().parent.parent
DATASETS_FILE = ROOT / "datasets.yaml"
RAW_DIR = ROOT / "data" / "raw"
NATIVE_DIR = ROOT / "data" / "native"
AUDIT_DIR = NATIVE_DIR / "audit"
SOURCE_MATRIX_JSON = NATIVE_DIR / "source_matrix.json"

DATASET_SAMPLES_JSONL = AUDIT_DIR / "dataset_samples.jsonl"
DATASET_SIMILARITY_JSON = AUDIT_DIR / "dataset_similarity.json"
REFERENCE_TRAJECTORIES_JSON = AUDIT_DIR / "runtime_reference_trajectories.json"
REFERENCE_TRAJECTORIES_MD = AUDIT_DIR / "runtime_reference_trajectories.md"
MODEL_CALL_SHAPES_JSON = AUDIT_DIR / "model_call_shapes.json"
COMPOSITION_AUDIT_MD = AUDIT_DIR / "composition_audit.md"

SCHEMA = "eliza.native_trajectory_alignment_audit.v1"
DEFAULT_MODEL = "gpt-oss-120b"
DEFAULT_BASE_URL = "https://api.cerebras.ai/v1"

MAX_PREVIEW_CHARS = 2_400
MAX_JSON_BYTES = 8 * 1024 * 1024
SKIP_DIRS = {".cache", ".git", "__pycache__", "node_modules"}
EXTENSION_PRIORITY = {
    ".jsonl": 0,
    ".parquet": 1,
    ".json": 2,
    ".csv": 3,
    ".tsv": 4,
    ".yaml": 5,
    ".yml": 5,
    ".txt": 6,
    ".md": 7,
}


REFERENCE_STAGE_FEATURES: dict[str, set[str]] = {
    "message_handler": {
        "chat_messages",
        "current_user_message",
        "response_decision",
        "context_labels",
        "internal_thought",
    },
    "planner": {
        "chat_messages",
        "tool_calls",
        "tool_schemas",
        "arguments_json",
        "planning_text",
    },
    "tool_result": {
        "tool_calls",
        "tool_results",
        "arguments_json",
        "multi_turn",
    },
    "evaluator": {
        "tool_results",
        "evaluator_decision",
        "success_label",
        "internal_thought",
        "user_visible_message",
    },
    "trajectory": {
        "chat_messages",
        "context_labels",
        "tool_calls",
        "tool_results",
        "evaluator_decision",
        "append_only_events",
        "cache_observation",
        "multi_turn",
    },
}


@dataclass(frozen=True)
class DatasetEntry:
    slug: str
    normalizer: str
    priority: str
    license: str
    raw_dir: Path


def stable_hash(*parts: object, length: int = 16) -> str:
    h = hashlib.sha256()
    for part in parts:
        h.update(json.dumps(part, sort_keys=True, default=str).encode("utf-8"))
        h.update(b"\0")
    return h.hexdigest()[:length]


def compact(value: Any, limit: int = MAX_PREVIEW_CHARS) -> Any:
    if isinstance(value, (bytes, bytearray, memoryview)):
        raw = bytes(value)
        return {
            "_bytes": raw[: min(64, len(raw))].hex(),
            "length": len(raw),
            **({"truncated": True} if len(raw) > 64 else {}),
        }
    if isinstance(value, str):
        value = value.replace("\x00", "")
        return value if len(value) <= limit else value[:limit] + f"... <truncated {len(value) - limit} chars>"
    if isinstance(value, list):
        return [compact(v, limit=max(300, limit // max(1, len(value)))) for v in value[:12]]
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        budget = max(300, limit // max(1, min(len(value), 20)))
        for idx, (key, item) in enumerate(value.items()):
            if idx >= 40:
                out["__truncated_keys__"] = len(value) - idx
                break
            out[str(key)] = compact(item, budget)
        return out
    return value


def load_yaml(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def load_source_matrix() -> dict[str, dict[str, Any]]:
    if not SOURCE_MATRIX_JSON.exists():
        return {}
    with SOURCE_MATRIX_JSON.open("r", encoding="utf-8") as f:
        raw = json.load(f)
    return {
        row["slug"]: row
        for row in raw.get("sources", [])
        if isinstance(row, dict) and isinstance(row.get("slug"), str)
    }


def load_dataset_entries() -> list[DatasetEntry]:
    registry = load_yaml(DATASETS_FILE)
    entries: list[DatasetEntry] = []
    for row in registry.get("datasets") or []:
        if not isinstance(row, dict) or not row.get("slug"):
            continue
        slug = str(row["slug"])
        entries.append(
            DatasetEntry(
                slug=slug,
                normalizer=str(row.get("normalizer") or ""),
                priority=str(row.get("priority") or "core"),
                license=str(row.get("license") or "unknown"),
                raw_dir=RAW_DIR / slug,
            )
        )
    return entries


def is_done(entry: DatasetEntry) -> bool:
    return (entry.raw_dir / ".done").exists()


def iter_candidate_files(root: Path) -> Iterable[Path]:
    if not root.exists():
        return
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        if any(part in SKIP_DIRS for part in path.parts):
            continue
        if path.name.startswith("."):
            continue
        if path.suffix.lower() in EXTENSION_PRIORITY:
            yield path


def sorted_candidate_files(root: Path) -> list[Path]:
    return sorted(
        iter_candidate_files(root),
        key=lambda p: (
            EXTENSION_PRIORITY.get(p.suffix.lower(), 99),
            len(p.parts),
            str(p.relative_to(root)),
        ),
    )


def read_jsonl_samples(path: Path, limit: int) -> list[Any]:
    rows: list[Any] = []
    with path.open("r", encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                rows.append({"_raw": compact(line)})
            if len(rows) >= limit:
                break
    return rows


def read_json_samples(path: Path, limit: int) -> list[Any]:
    if path.stat().st_size > MAX_JSON_BYTES:
        with path.open("r", encoding="utf-8", errors="replace") as f:
            return [{"_raw_preview": compact(f.read(MAX_PREVIEW_CHARS))}]
    with path.open("r", encoding="utf-8", errors="replace") as f:
        raw = json.load(f)
    if isinstance(raw, list):
        return raw[:limit]
    if isinstance(raw, dict):
        for key in ("data", "rows", "examples", "records", "messages"):
            value = raw.get(key)
            if isinstance(value, list) and value:
                return value[:limit]
        return [raw]
    return [{"value": raw}]


def read_parquet_samples(path: Path, limit: int) -> list[Any]:
    if pq is None:
        return [{"_parquet": "pyarrow unavailable", "path": str(path)}]
    pf = pq.ParquetFile(path)
    rows: list[Any] = []
    for batch in pf.iter_batches(batch_size=limit):
        rows.extend(batch.to_pylist())
        break
    return rows[:limit]


def read_tabular_samples(path: Path, limit: int, delimiter: str) -> list[Any]:
    rows: list[Any] = []
    with path.open("r", encoding="utf-8", errors="replace", newline="") as f:
        reader = csv.DictReader(f, delimiter=delimiter)
        for row in reader:
            rows.append(row)
            if len(rows) >= limit:
                break
    return rows


def read_text_sample(path: Path) -> list[Any]:
    with path.open("r", encoding="utf-8", errors="replace") as f:
        return [{"_text_preview": compact(f.read(MAX_PREVIEW_CHARS))}]


def read_samples_from_file(path: Path, limit: int) -> list[Any]:
    suffix = path.suffix.lower()
    try:
        if suffix == ".jsonl":
            return read_jsonl_samples(path, limit)
        if suffix == ".json":
            return read_json_samples(path, limit)
        if suffix == ".parquet":
            return read_parquet_samples(path, limit)
        if suffix == ".csv":
            return read_tabular_samples(path, limit, ",")
        if suffix == ".tsv":
            return read_tabular_samples(path, limit, "\t")
        return read_text_sample(path)
    except Exception as exc:  # noqa: BLE001 - keep audit moving.
        return [{"_read_error": f"{type(exc).__name__}: {exc}", "path": str(path)}]


def collect_dataset_samples(entry: DatasetEntry, samples_per_source: int) -> list[dict[str, Any]]:
    samples: list[dict[str, Any]] = []
    files = sorted_candidate_files(entry.raw_dir)
    for file_path in files:
        needed = samples_per_source - len(samples)
        if needed <= 0:
            break
        for row_idx, raw in enumerate(read_samples_from_file(file_path, needed)):
            features = infer_features(raw)
            samples.append(
                {
                    "schema": SCHEMA,
                    "dataset": entry.slug,
                    "normalizer": entry.normalizer,
                    "priority": entry.priority,
                    "license": entry.license,
                    "sampleIndex": len(samples),
                    "path": str(file_path.relative_to(entry.raw_dir)),
                    "rowIndex": row_idx,
                    "kind": file_path.suffix.lower().lstrip(".") or "file",
                    "features": sorted(features),
                    "stageSimilarity": stage_similarity(features),
                    "preview": compact(raw),
                }
            )
            if len(samples) >= samples_per_source:
                break
    while len(samples) < samples_per_source:
        samples.append(
            {
                "schema": SCHEMA,
                "dataset": entry.slug,
                "normalizer": entry.normalizer,
                "priority": entry.priority,
                "license": entry.license,
                "sampleIndex": len(samples),
                "path": None,
                "rowIndex": None,
                "kind": "placeholder",
                "features": [],
                "stageSimilarity": stage_similarity(set()),
                "preview": {
                    "note": "no additional readable records found for this source",
                    "rawDir": str(entry.raw_dir),
                },
            }
        )
    return samples


def flatten_keys(value: Any, *, max_nodes: int = 500) -> tuple[set[str], list[Any]]:
    keys: set[str] = set()
    list_values: list[Any] = []
    stack = [value]
    seen = 0
    while stack and seen < max_nodes:
        seen += 1
        item = stack.pop()
        if isinstance(item, dict):
            for key, child in item.items():
                keys.add(str(key))
                stack.append(child)
        elif isinstance(item, list):
            list_values.append(item)
            stack.extend(item[:40])
    return keys, list_values


def lower_text(value: Any) -> str:
    try:
        return json.dumps(value, default=str).lower()
    except Exception:
        return str(value).lower()


def infer_features(value: Any) -> set[str]:
    keys, list_values = flatten_keys(value)
    lower_keys = {k.lower() for k in keys}
    text = lower_text(value)
    features: set[str] = set()

    if "messages" in lower_keys or "conversations" in lower_keys or "conversation" in lower_keys:
        features.add("chat_messages")
    if "currentmessage" in lower_keys or "prompt" in lower_keys or "instruction" in lower_keys:
        features.add("current_user_message")
    if "system" in text or '"role": "system"' in text:
        features.add("system_prompt")
    if "assistant" in text and "user" in text:
        features.add("user_assistant_turns")
    if sum(1 for token in ('"role": "user"', '"role": "assistant"', "'role': 'user'", "'role': 'assistant'") if token in text) >= 2:
        features.add("multi_turn")

    tool_markers = {
        "tool_calls",
        "toolcalls",
        "function_call",
        "functioncall",
        "actions",
        "availableactions",
        "tools",
    }
    if lower_keys & tool_markers or "<tool_call" in text or "tool_calls[" in text:
        features.add("tool_calls")
    if "parameters" in lower_keys or "inputschema" in lower_keys or "json_schema" in lower_keys:
        features.add("tool_schemas")
    if "arguments" in lower_keys or "args" in lower_keys or "params" in lower_keys:
        features.add("arguments_json")
    if "tool_result" in lower_keys or "toolresults" in lower_keys or '"role": "tool"' in text:
        features.add("tool_results")

    if lower_keys & {"contexts", "primarycontext", "secondarycontexts", "context"}:
        features.add("context_labels")
    if lower_keys & {"shouldrespond", "action", "simple", "reply"}:
        features.add("response_decision")
    if lower_keys & {"thought", "reasoning", "scratchpad", "chain_of_thought"} or "<think>" in text:
        features.add("internal_thought")
    if lower_keys & {"decision", "task_completed", "taskcompleted", "quality_score"}:
        features.add("evaluator_decision")
    if lower_keys & {"success", "is_success", "passed"}:
        features.add("success_label")
    if lower_keys & {"messagetouser", "response", "final_answer", "answer", "content"}:
        features.add("user_visible_message")
    if lower_keys & {"events", "stages", "trajectory", "trajectoryid"}:
        features.add("append_only_events")
    if lower_keys & {"cachedprompttokens", "cachereadinputtokens", "cachecreationinputtokens", "cache_read_tokens", "cachewritetokens"}:
        features.add("cache_observation")
    if "plan" in text or "planner" in text:
        features.add("planning_text")

    for list_value in list_values:
        if len(list_value) >= 4:
            features.add("multi_turn")
            break

    return features


def stage_similarity(features: set[str]) -> dict[str, float]:
    out: dict[str, float] = {}
    for stage, expected in REFERENCE_STAGE_FEATURES.items():
        union = features | expected
        out[stage] = round(len(features & expected) / len(union), 4) if union else 0.0
    return out


def summarize_samples(
    samples: list[dict[str, Any]],
    source_matrix: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    by_dataset: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for sample in samples:
        by_dataset[sample["dataset"]].append(sample)

    datasets: list[dict[str, Any]] = []
    for dataset, rows in sorted(by_dataset.items()):
        feature_counts = Counter(
            feature for row in rows for feature in row.get("features", [])
        )
        stage_scores: dict[str, list[float]] = defaultdict(list)
        for row in rows:
            for stage, score in row.get("stageSimilarity", {}).items():
                stage_scores[stage].append(float(score))
        matrix_row = source_matrix.get(dataset, {})
        best_stage = max(
            ((stage, sum(vals) / len(vals)) for stage, vals in stage_scores.items() if vals),
            key=lambda item: item[1],
            default=("unknown", 0.0),
        )
        datasets.append(
            {
                "dataset": dataset,
                "samples": len(rows),
                "normalizer": rows[0].get("normalizer"),
                "transform": matrix_row.get("transform"),
                "targetStages": matrix_row.get("target_stages", []),
                "qualityRating": matrix_row.get("quality_rating"),
                "topFeatures": feature_counts.most_common(12),
                "averageStageSimilarity": {
                    stage: round(sum(vals) / len(vals), 4)
                    for stage, vals in sorted(stage_scores.items())
                    if vals
                },
                "bestObservedStage": best_stage[0],
                "bestObservedScore": round(best_stage[1], 4),
                "missingCriticalSignals": missing_critical_signals(feature_counts),
            }
        )
    return {
        "schema": SCHEMA,
        "generatedAt": int(time.time()),
        "datasets": datasets,
        "totals": {
            "datasets": len(datasets),
            "samples": len(samples),
        },
    }


def missing_critical_signals(feature_counts: Counter[str]) -> list[str]:
    missing = []
    if feature_counts["tool_calls"] == 0:
        missing.append("no native or recoverable tool-call signal")
    if feature_counts["tool_results"] == 0:
        missing.append("no action-result/evaluator input signal")
    if feature_counts["evaluator_decision"] == 0 and feature_counts["success_label"] == 0:
        missing.append("no explicit evaluator success/decision labels")
    if feature_counts["context_labels"] == 0:
        missing.append("contexts must be inferred")
    if feature_counts["cache_observation"] == 0:
        missing.append("no cache observations")
    return missing


def tool(name: str, description: str, properties: dict[str, Any], required: list[str] | None = None) -> dict[str, Any]:
    return {
        "name": name,
        "description": description,
        "parameters": {
            "type": "object",
            "additionalProperties": False,
            "properties": properties,
            "required": required or [],
        },
        "type": "function",
    }


SCENARIOS: dict[str, dict[str, Any]] = {
    "simple_reply": {
        "user": "What is the fastest way to rename a file on macOS?",
        "contexts": [],
        "tools": [],
        "fixture": {
            "messageHandler": {
                "action": "RESPOND",
                "simple": True,
                "contexts": [],
                "thought": "The user asks a general knowledge question that needs no tools.",
                "reply": "Use Finder to select the file, press Return, type the new name, then press Return again.",
            }
        },
    },
    "wallet_context": {
        "user": "Check my ETH balance, estimate gas, then prepare a 0.05 ETH transfer to Jordan if the balance is safe.",
        "contexts": ["wallet", "payments"],
        "tools": [
            tool("WALLET_GET_BALANCE", "Read a wallet balance.", {"chain": {"type": "string"}, "asset": {"type": "string"}}, ["chain", "asset"]),
            tool("WALLET_ESTIMATE_GAS", "Estimate gas for a transfer.", {"chain": {"type": "string"}, "asset": {"type": "string"}, "amount": {"type": "string"}, "recipient": {"type": "string"}}, ["chain", "asset", "amount", "recipient"]),
            tool("WALLET_PREPARE_TRANSFER", "Prepare but do not broadcast a transfer.", {"chain": {"type": "string"}, "asset": {"type": "string"}, "amount": {"type": "string"}, "recipient": {"type": "string"}}, ["chain", "asset", "amount", "recipient"]),
        ],
        "planned": [
            {"name": "WALLET_GET_BALANCE", "args": {"chain": "ethereum", "asset": "ETH"}},
            {"name": "WALLET_ESTIMATE_GAS", "args": {"chain": "ethereum", "asset": "ETH", "amount": "0.05", "recipient": "Jordan"}},
            {"name": "WALLET_PREPARE_TRANSFER", "args": {"chain": "ethereum", "asset": "ETH", "amount": "0.05", "recipient": "Jordan"}},
        ],
    },
    "email_context": {
        "user": "Find the latest email from Priya about the launch deck, draft a concise reply confirming I will update the metrics slide, and leave it as a draft.",
        "contexts": ["email", "contacts"],
        "tools": [
            tool("EMAIL_SEARCH", "Search email messages.", {"query": {"type": "string"}, "limit": {"type": "integer"}}, ["query"]),
            tool("EMAIL_DRAFT_REPLY", "Create an email reply draft.", {"messageId": {"type": "string"}, "body": {"type": "string"}}, ["messageId", "body"]),
        ],
        "planned": [
            {"name": "EMAIL_SEARCH", "args": {"query": "from:Priya launch deck metrics slide", "limit": 5}},
            {"name": "EMAIL_DRAFT_REPLY", "args": {"messageId": "msg_latest_priya_launch_deck", "body": "Thanks, Priya. I will update the metrics slide and send the revised deck shortly."}},
        ],
    },
    "calendar_context": {
        "user": "Schedule a 30 minute prep call with Sam next Tuesday afternoon, avoid conflicts, and tell me what you booked.",
        "contexts": ["calendar", "contacts"],
        "tools": [
            tool("CALENDAR_FIND_EVENTS", "Find events in a time window.", {"date": {"type": "string"}, "timeWindow": {"type": "string"}}, ["date", "timeWindow"]),
            tool("CALENDAR_CHECK_AVAILABILITY", "Check attendee availability.", {"attendee": {"type": "string"}, "date": {"type": "string"}, "durationMinutes": {"type": "integer"}, "timeWindow": {"type": "string"}}, ["attendee", "date", "durationMinutes"]),
            tool("CALENDAR_CREATE_EVENT", "Create a calendar event.", {"title": {"type": "string"}, "attendees": {"type": "array", "items": {"type": "string"}}, "start": {"type": "string"}, "durationMinutes": {"type": "integer"}}, ["title", "attendees", "start", "durationMinutes"]),
        ],
        "planned": [
            {"name": "CALENDAR_FIND_EVENTS", "args": {"date": "next Tuesday", "timeWindow": "afternoon"}},
            {"name": "CALENDAR_CHECK_AVAILABILITY", "args": {"attendee": "Sam", "date": "next Tuesday", "durationMinutes": 30, "timeWindow": "afternoon"}},
            {"name": "CALENDAR_CREATE_EVENT", "args": {"title": "Prep call with Sam", "attendees": ["Sam"], "start": "next Tuesday 2:30 PM", "durationMinutes": 30}},
        ],
    },
}


MESSAGE_HANDLER_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "action": {"type": "string", "enum": ["RESPOND", "IGNORE", "STOP"]},
        "simple": {"type": "boolean"},
        "contexts": {"type": "array", "items": {"type": "string"}},
        "thought": {"type": "string"},
        "reply": {"type": "string"},
    },
    "required": ["action", "simple", "contexts", "thought"],
}

EVALUATOR_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "success": {"type": "boolean"},
        "decision": {"type": "string", "enum": ["FINISH", "NEXT_RECOMMENDED", "CONTINUE"]},
        "thought": {"type": "string"},
        "messageToUser": {"type": "string"},
        "recommendedToolCallId": {"type": "string"},
    },
    "required": ["success", "decision", "thought"],
}


def prompt_segment(segment_id: str, label: str, content: str, stable: bool) -> dict[str, Any]:
    return {
        "id": segment_id,
        "label": label,
        "content": content,
        "stable": stable,
        "hash": stable_hash(label, content, length=24),
        "tokenEstimate": max(1, len(content) // 4),
    }


def prefix_hashes(segments: list[dict[str, Any]]) -> list[str]:
    out: list[str] = []
    running = ""
    for segment in segments:
        running = stable_hash(running, segment["hash"], length=32)
        out.append(running)
    return out


def base_context_object(scenario_name: str, scenario: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    system = "You are Eliza. Use native tool calls only when selected contexts require tools."
    registry = "contexts: general, wallet, payments, email, contacts, calendar"
    static_segments = [
        prompt_segment("static-system", "system", system, True),
        prompt_segment("static-registry", "context_registry", registry, True),
    ]
    user_event = {
        "id": f"event-user-{scenario_name}",
        "type": "message",
        "source": "user",
        "message": {"role": "user", "content": scenario["user"]},
    }
    context = {
        "id": f"ctx-{scenario_name}",
        "version": "v5",
        "metadata": {"scenario": scenario_name, "model": DEFAULT_MODEL},
        "staticPrefix": {
            "systemPrompt": static_segments[0],
            "staticProviders": [static_segments[1]],
            "alwaysTools": [
                tool("REPLY", "Send a user-visible reply.", {"text": {"type": "string"}}, ["text"]),
                tool("IGNORE", "Ignore the message.", {"reason": {"type": "string"}}, ["reason"]),
                tool("STOP", "Stop processing.", {"reason": {"type": "string"}}, ["reason"]),
            ],
            "contextRegistryDigest": stable_hash(registry, length=24),
        },
        "plannedQueue": [],
        "metrics": {},
        "limits": {"maxIterations": 50, "compactionEnabled": True},
        "events": [user_event],
    }
    return context, static_segments


def attach_context_prefix(context: dict[str, Any], scenario: dict[str, Any]) -> list[dict[str, Any]]:
    context_text = "selected_contexts: " + ", ".join(scenario["contexts"])
    provider_text = "context_provider_snapshot: " + json.dumps(
        {
            "contexts": scenario["contexts"],
            "availableTools": [t["name"] for t in scenario["tools"]],
        },
        sort_keys=True,
    )
    segments = [
        prompt_segment("trajectory-contexts", "selected_contexts", context_text, True),
        prompt_segment("trajectory-provider", "context_provider", provider_text, True),
    ]
    context["trajectoryPrefix"] = {
        "selectedContexts": scenario["contexts"],
        "contextProviders": segments,
        "expandedTools": scenario["tools"],
        "createdAtStageId": "stage-message-handler",
    }
    return segments


def stage_prompt(stage: str, context: dict[str, Any], trajectory_steps: list[dict[str, Any]] | None = None) -> str:
    if stage == "messageHandler":
        return "\n".join(
            [
                "task: Decide whether the agent should respond and which contexts are needed.",
                "",
                "context:",
                json.dumps(context, indent=2, sort_keys=True),
                "",
                "available_contexts:",
                "- general: normal conversation",
                "- wallet: wallet balances and transfers",
                "- payments: payment workflows",
                "- email: email search and draft workflows",
                "- contacts: contact lookup",
                "- calendar: scheduling and availability",
                "",
                "return JSON object only.",
            ]
        )
    if stage == "planner":
        return "\n".join(
            [
                "task: Plan the next native tool calls for the current ContextObject.",
                "",
                "context_object:",
                json.dumps(context, indent=2, sort_keys=True),
                "",
                "trajectory:",
                json.dumps(trajectory_steps or [], indent=2, sort_keys=True),
                "",
                "return native tool calls when tools are needed.",
            ]
        )
    return "\n".join(
        [
            "task: Evaluate the just-executed action and route the next planner-loop step.",
            "",
            "context_object:",
            json.dumps(context, indent=2, sort_keys=True),
            "",
            "trajectory:",
            json.dumps(trajectory_steps or [], indent=2, sort_keys=True),
            "",
            "return JSON object only.",
        ]
    )


def openai_tools(tools: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "type": "function",
            "function": {
                "name": t["name"],
                "description": t.get("description", ""),
                "parameters": t.get("parameters", {"type": "object", "properties": {}}),
            },
        }
        for t in tools
    ]


def runtime_params_to_cerebras_payload(
    *,
    model: str,
    prompt: str,
    tools: list[dict[str, Any]] | None = None,
    tool_choice: str | dict[str, Any] | None = None,
    response_schema: dict[str, Any] | None = None,
    prompt_cache_key: str | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
    }
    if tools:
        payload["tools"] = openai_tools(tools)
    if tool_choice:
        payload["tool_choice"] = tool_choice
    if response_schema:
        payload["response_format"] = {
            "type": "json_schema",
            "json_schema": {
                "name": "eliza_response",
                "strict": True,
                "schema": response_schema,
            },
        }
    if prompt_cache_key:
        payload["prompt_cache_key"] = prompt_cache_key
    return payload


def runtime_params_to_vercel_gateway_common(
    *,
    model: str,
    prompt: str,
    tools: list[dict[str, Any]] | None = None,
    tool_choice: str | dict[str, Any] | None = None,
    response_schema: dict[str, Any] | None = None,
) -> dict[str, Any]:
    common: dict[str, Any] = {
        "model": f"gateway({model})",
        "messages": [{"role": "user", "content": prompt}],
        "allowSystemInMessages": True,
    }
    if tools:
        common["tools"] = {
            t["name"]: {
                "description": t.get("description", ""),
                "inputSchema": t.get("parameters", {"type": "object"}),
                "outputSchema": {"type": "object", "additionalProperties": True},
            }
            for t in tools
        }
    if tool_choice:
        common["toolChoice"] = tool_choice
    if response_schema:
        common["output"] = {
            "name": "object",
            "responseFormat": {
                "type": "json",
                "schema": {"type": "object", "additionalProperties": True},
            },
            "note": "current cloud adapter ignores the caller's exact schema here",
        }
    return common


def call_cerebras(payload: dict[str, Any], *, base_url: str, api_key: str, timeout: int) -> dict[str, Any]:
    request = urllib.request.Request(
        f"{base_url.rstrip('/')}/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        return {"error": {"status": exc.code, "body": body}}
    except Exception as exc:  # noqa: BLE001
        return {"error": {"type": type(exc).__name__, "message": str(exc)}}


def normalize_openai_response(response: dict[str, Any]) -> dict[str, Any]:
    if "error" in response:
        return {"text": "", "toolCalls": [], "finishReason": "error", "error": response["error"]}
    choice = (response.get("choices") or [{}])[0]
    message = choice.get("message") or {}
    calls = []
    for raw in message.get("tool_calls") or []:
        fn = raw.get("function") or {}
        args = fn.get("arguments") or "{}"
        try:
            parsed_args = json.loads(args) if isinstance(args, str) else args
        except json.JSONDecodeError:
            parsed_args = {"_raw": args}
        calls.append(
            {
                "id": raw.get("id") or stable_hash(fn.get("name"), args),
                "name": fn.get("name") or "",
                "args": parsed_args if isinstance(parsed_args, dict) else {"value": parsed_args},
                "status": "queued",
            }
        )
    usage = response.get("usage") or {}
    return {
        "text": message.get("content") or "",
        "toolCalls": calls,
        "finishReason": choice.get("finish_reason"),
        "usage": {
            "promptTokens": usage.get("prompt_tokens", 0),
            "completionTokens": usage.get("completion_tokens", 0),
            "totalTokens": usage.get("total_tokens", 0),
            "cacheReadInputTokens": ((usage.get("prompt_tokens_details") or {}).get("cached_tokens")),
        },
    }


def fixture_message_handler(scenario_name: str, scenario: dict[str, Any]) -> dict[str, Any]:
    if "fixture" in scenario:
        return scenario["fixture"]["messageHandler"]
    return {
        "action": "RESPOND",
        "simple": False,
        "contexts": scenario["contexts"],
        "thought": f"The request requires {', '.join(scenario['contexts'])} context and native tools.",
    }


def fixture_planner_calls(scenario_name: str, scenario: dict[str, Any]) -> list[dict[str, Any]]:
    calls = []
    for idx, planned in enumerate(scenario.get("planned", []), start=1):
        calls.append(
            {
                "id": f"call-{scenario_name}-{idx}",
                "name": planned["name"],
                "args": planned["args"],
                "status": "queued",
            }
        )
    return calls


def fixture_tool_result(call: dict[str, Any], idx: int) -> dict[str, Any]:
    return {
        "success": True,
        "text": f"{call['name']} completed.",
        "data": {
            "toolCallId": call["id"],
            "summary": f"Simulated result for {call['name']}.",
            "idx": idx,
        },
    }


def fixture_evaluation(call: dict[str, Any], remaining: int) -> dict[str, Any]:
    if remaining > 0:
        return {
            "success": True,
            "decision": "NEXT_RECOMMENDED",
            "thought": f"{call['name']} succeeded and the queued plan still has grounded work.",
            "recommendedToolCallId": None,
        }
    return {
        "success": True,
        "decision": "FINISH",
        "thought": f"{call['name']} completed the final required step.",
        "messageToUser": "Done. I completed the requested workflow and recorded the result.",
    }


def build_model_call_shape(
    *,
    stage: str,
    scenario_name: str,
    model: str,
    prompt: str,
    tools: list[dict[str, Any]] | None = None,
    tool_choice: str | dict[str, Any] | None = None,
    response_schema: dict[str, Any] | None = None,
    prompt_segments: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    runtime_params: dict[str, Any] = {
        "prompt": prompt,
    }
    if tools:
        runtime_params["tools"] = tools
        runtime_params["toolChoice"] = tool_choice or "auto"
    if response_schema:
        runtime_params["responseFormat"] = {"type": "json_object"}
        runtime_params["responseSchema"] = response_schema
    if prompt_segments:
        runtime_params["promptSegments"] = prompt_segments
        runtime_params["promptSegmentsNote"] = "desired cache surface; current planner/evaluator do not pass this through"

    return {
        "stage": stage,
        "scenario": scenario_name,
        "runtimeUseModelParams": runtime_params,
        "cerebrasChatCompletionsPayload": runtime_params_to_cerebras_payload(
            model=model,
            prompt=prompt,
            tools=tools,
            tool_choice=tool_choice or ("auto" if tools else None),
            response_schema=response_schema,
            prompt_cache_key=f"eliza-v5-{scenario_name}",
        ),
        "vercelGatewayCommon": runtime_params_to_vercel_gateway_common(
            model=model,
            prompt=prompt,
            tools=tools,
            tool_choice=tool_choice or ("auto" if tools else None),
            response_schema=response_schema,
        ),
    }


def build_reference_trajectory(
    scenario_name: str,
    scenario: dict[str, Any],
    *,
    model: str,
    run_cerebras: bool,
    api_key: str | None,
    base_url: str,
    timeout: int,
) -> dict[str, Any]:
    context, static_segments = base_context_object(scenario_name, scenario)
    trajectory_segments = []
    stages: list[dict[str, Any]] = []
    steps: list[dict[str, Any]] = []

    mh_prompt = stage_prompt("messageHandler", context)
    mh_shape = build_model_call_shape(
        stage="messageHandler",
        scenario_name=scenario_name,
        model=model,
        prompt=mh_prompt,
        response_schema=MESSAGE_HANDLER_SCHEMA,
        prompt_segments=static_segments,
    )
    if run_cerebras and api_key:
        mh_raw = call_cerebras(
            mh_shape["cerebrasChatCompletionsPayload"],
            base_url=base_url,
            api_key=api_key,
            timeout=timeout,
        )
        mh_output_text = normalize_openai_response(mh_raw)["text"]
        try:
            mh_output = json.loads(mh_output_text)
        except json.JSONDecodeError:
            mh_output = fixture_message_handler(scenario_name, scenario)
    else:
        mh_raw = {"offlineFixture": True}
        mh_output = fixture_message_handler(scenario_name, scenario)

    context["events"].append(
        {
            "id": f"event-message-handler-{scenario_name}",
            "type": "message_handler",
            "metadata": mh_output,
        }
    )
    stages.append(
        recorded_model_stage(
            "messageHandler",
            1,
            mh_shape,
            mh_raw,
            {"messageHandler": mh_output},
            static_segments,
        )
    )

    if not mh_output.get("contexts"):
        context["events"].append(
            {
                "id": f"event-assistant-{scenario_name}",
                "type": "message",
                "message": {"role": "assistant", "content": mh_output.get("reply", "")},
            }
        )
        return finish_reference_trajectory(
            scenario_name,
            model,
            context,
            stages,
            "offline_fixture" if not (run_cerebras and api_key) else "cerebras",
        )

    trajectory_segments = attach_context_prefix(context, scenario)
    segments = static_segments + trajectory_segments

    planner_prompt = stage_prompt("planner", context, steps)
    planner_shape = build_model_call_shape(
        stage="planner",
        scenario_name=scenario_name,
        model=model,
        prompt=planner_prompt,
        tools=scenario["tools"],
        tool_choice="auto",
        prompt_segments=segments,
    )
    if run_cerebras and api_key:
        planner_raw = call_cerebras(
            planner_shape["cerebrasChatCompletionsPayload"],
            base_url=base_url,
            api_key=api_key,
            timeout=timeout,
        )
        planner_result = normalize_openai_response(planner_raw)
        tool_calls = planner_result["toolCalls"] or fixture_planner_calls(scenario_name, scenario)
    else:
        planner_raw = {"offlineFixture": True}
        tool_calls = fixture_planner_calls(scenario_name, scenario)
        planner_result = {"text": "", "toolCalls": tool_calls, "finishReason": "tool_calls"}

    context["plannedQueue"] = [{**call, "args": call.get("args", {}), "status": "queued"} for call in tool_calls]
    context["events"].append(
        {
            "id": f"event-planner-{scenario_name}-1",
            "type": "planner",
            "metadata": {"toolCalls": tool_calls, "text": planner_result.get("text", "")},
        }
    )
    stages.append(
        recorded_model_stage(
            "planner",
            1,
            planner_shape,
            planner_raw,
            planner_result,
            segments,
        )
    )

    for idx, call in enumerate(tool_calls, start=1):
        result = fixture_tool_result(call, idx)
        context["events"].append(
            {
                "id": f"event-tool-call-{call['id']}",
                "type": "tool_call",
                "toolCall": call,
            }
        )
        context["events"].append(
            {
                "id": f"event-tool-result-{call['id']}",
                "type": "tool_result",
                "toolCallId": call["id"],
                "result": result,
            }
        )
        stages.append(
            {
                "stageId": f"stage-tool-{call['id']}",
                "kind": "tool",
                "iteration": idx,
                "startedAt": 0,
                "endedAt": 0,
                "latencyMs": 0,
                "tool": {
                    "name": call["name"],
                    "args": call.get("args", {}),
                    "result": result,
                    "success": result["success"],
                    "durationMs": 0,
                },
            }
        )
        steps.append({"iteration": idx, "toolCall": call, "result": result})

        remaining = len(tool_calls) - idx
        evaluation = fixture_evaluation(call, remaining)
        if evaluation.get("recommendedToolCallId") is None and remaining > 0:
            evaluation["recommendedToolCallId"] = tool_calls[idx]["id"]
        eval_prompt = stage_prompt("evaluator", context, steps)
        eval_shape = build_model_call_shape(
            stage="evaluation",
            scenario_name=scenario_name,
            model=model,
            prompt=eval_prompt,
            response_schema=EVALUATOR_SCHEMA,
            prompt_segments=segments
            + [prompt_segment(f"growing-tool-{idx}", "growing_suffix", json.dumps(steps, sort_keys=True), False)],
        )
        if run_cerebras and api_key:
            eval_raw = call_cerebras(
                eval_shape["cerebrasChatCompletionsPayload"],
                base_url=base_url,
                api_key=api_key,
                timeout=timeout,
            )
        else:
            eval_raw = {"offlineFixture": True}
        context["events"].append(
            {
                "id": f"event-evaluation-{call['id']}",
                "type": "evaluation",
                "evaluatedToolCallId": call["id"],
                "result": evaluation,
            }
        )
        stages.append(
            recorded_model_stage(
                "evaluation",
                idx,
                eval_shape,
                eval_raw,
                {"evaluation": evaluation},
                eval_shape["runtimeUseModelParams"].get("promptSegments") or segments,
            )
        )

    return finish_reference_trajectory(
        scenario_name,
        model,
        context,
        stages,
        "offline_fixture" if not (run_cerebras and api_key) else "cerebras",
    )


def recorded_model_stage(
    kind: str,
    iteration: int,
    shape: dict[str, Any],
    raw_response: dict[str, Any],
    normalized: dict[str, Any],
    segments: list[dict[str, Any]],
) -> dict[str, Any]:
    hashes = prefix_hashes(segments)
    prompt = shape["runtimeUseModelParams"]["prompt"]
    response_text = json.dumps(normalized, sort_keys=True)
    return {
        "stageId": f"stage-{kind}-{iteration}",
        "kind": kind,
        "iteration": iteration,
        "startedAt": 0,
        "endedAt": 0,
        "latencyMs": 0,
        "model": {
            "modelType": "RESPONSE_HANDLER" if kind in {"messageHandler", "evaluation"} else "ACTION_PLANNER",
            "modelName": DEFAULT_MODEL,
            "provider": "cerebras",
            "prompt": prompt,
            "tools": shape["runtimeUseModelParams"].get("tools"),
            "toolChoice": shape["runtimeUseModelParams"].get("toolChoice"),
            "response": response_text,
            "toolCalls": normalized.get("toolCalls") or normalized.get("planner", {}).get("toolCalls"),
            "finishReason": normalized.get("finishReason"),
            "usage": normalize_openai_response(raw_response).get("usage") if raw_response else None,
        },
        "cache": {
            "segmentHashes": [s["hash"] for s in segments],
            "prefixHash": hashes[-1] if hashes else "no-context-segments",
            "prefixHashes": hashes,
        },
        "normalizedOutput": normalized,
        "providerEnvelope": {
            "runtimeUseModelParams": compact(shape["runtimeUseModelParams"]),
            "cerebrasChatCompletionsPayload": compact(shape["cerebrasChatCompletionsPayload"]),
            "vercelGatewayCommon": compact(shape["vercelGatewayCommon"]),
        },
        "rawProviderResponse": compact(raw_response),
    }


def finish_reference_trajectory(
    scenario_name: str,
    model: str,
    context: dict[str, Any],
    stages: list[dict[str, Any]],
    mode: str,
) -> dict[str, Any]:
    total_prompt = 0
    total_completion = 0
    total_cache = 0
    for stage in stages:
        usage = (stage.get("model") or {}).get("usage") or {}
        total_prompt += int(usage.get("promptTokens") or 0)
        total_completion += int(usage.get("completionTokens") or 0)
        total_cache += int(usage.get("cacheReadInputTokens") or 0)
    return {
        "schema": SCHEMA,
        "trajectoryId": f"ref-{scenario_name}",
        "scenario": scenario_name,
        "modelRun": {
            "mode": mode,
            "model": model,
            "note": "offline_fixture means CEREBRAS_API_KEY was unavailable or --run-cerebras was not set",
        },
        "contextObject": context,
        "stages": stages,
        "metrics": {
            "stageCount": len(stages),
            "toolCallsExecuted": sum(1 for s in stages if s["kind"] == "tool"),
            "totalPromptTokens": total_prompt,
            "totalCompletionTokens": total_completion,
            "totalCacheReadTokens": total_cache,
        },
    }


def build_reference_trajectories(args: argparse.Namespace) -> list[dict[str, Any]]:
    api_key = os.environ.get("CEREBRAS_API_KEY")
    run_live = bool(args.run_cerebras and api_key)
    return [
        build_reference_trajectory(
            scenario_name,
            scenario,
            model=args.model,
            run_cerebras=run_live,
            api_key=api_key,
            base_url=args.cerebras_base_url,
            timeout=args.timeout,
        )
        for scenario_name, scenario in SCENARIOS.items()
    ]


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, indent=2, sort_keys=True, default=str) + "\n",
        encoding="utf-8",
    )


def write_jsonl(path: Path, rows: Iterable[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, sort_keys=True, default=str) + "\n")


def write_reference_markdown(path: Path, trajectories: list[dict[str, Any]]) -> None:
    lines = [
        "# Runtime reference trajectories",
        "",
        "These are review fixtures for the v5 native-tool call composition. They print the model-call shape, normalized output, cache hash surface, and tool/evaluation chain.",
        "",
    ]
    for traj in trajectories:
        lines.extend(
            [
                f"## {traj['scenario']}",
                "",
                f"- model mode: `{traj['modelRun']['mode']}`",
                f"- stages: `{len(traj['stages'])}`",
                f"- tool calls executed: `{traj['metrics']['toolCallsExecuted']}`",
                "",
            ]
        )
        for stage in traj["stages"]:
            model = stage.get("model") or {}
            lines.extend(
                [
                    f"### {stage['kind']} iter {stage.get('iteration', 1)}",
                    "",
                    f"- prompt chars: `{len(model.get('prompt') or '')}`",
                    f"- tools: `{len(model.get('tools') or [])}`",
                    f"- prefix hash: `{(stage.get('cache') or {}).get('prefixHash')}`",
                    "",
                    "Normalized output:",
                    "",
                    "```json",
                    json.dumps(stage.get("normalizedOutput") or stage.get("tool"), indent=2, sort_keys=True),
                    "```",
                    "",
                ]
            )
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def write_composition_audit(path: Path, summary: dict[str, Any], trajectories: list[dict[str, Any]]) -> None:
    issue_lines = [
        "- Stage 1, planner, and evaluator currently render one large `prompt` string; planner/evaluator do not pass `messages` or `promptSegments` into `runtime.useModel`, so provider-side chat/caching inputs are not yet the plan-v5 shape.",
        "- Planner has `v5PlannerSchema` in code but does not pass `responseSchema`; it relies on native tool calls when tools exist or JSON parsing from text otherwise.",
        "- Evaluator has `v5EvaluatorSchema` in code but does not pass `responseSchema`; evaluator JSON strictness is weaker than Stage 1.",
        "- `renderContextObject()` computes segment hashes for planner recording, but the model adapters do not receive those segments as cache hints on planner/evaluator calls.",
        "- The cloud Vercel AI Gateway adapter maps AI SDK `usage.inputTokens/outputTokens/totalTokens` to OpenAI usage, but does not preserve AI SDK `cacheReadTokens/cacheWriteTokens` in the OpenAI-compatible response.",
        "- The cloud Vercel AI Gateway structured-output bridge currently replaces the caller response schema with `{type: object, additionalProperties: true}`.",
        "- Tool-result messages are better supported in the cloud adapter than in most bootstrap sources: OpenAI `tool` role messages become AI SDK `tool-result` parts with recovered tool names.",
    ]
    lines = [
        "# Native composition audit",
        "",
        "## Runtime/provider shape observations",
        "",
        *issue_lines,
        "",
        "## Dataset similarity summary",
        "",
        f"- datasets sampled: `{summary['totals']['datasets']}`",
        f"- rows sampled: `{summary['totals']['samples']}`",
        "",
        "| Dataset | Transform | Rating | Best observed stage | Score | Missing critical signals |",
        "| --- | --- | --- | --- | ---: | --- |",
    ]
    for row in summary["datasets"]:
        missing = "; ".join(row["missingCriticalSignals"][:3]) or "none in sampled rows"
        lines.append(
            f"| `{row['dataset']}` | `{row.get('transform') or ''}` | `{row.get('qualityRating') or ''}` | `{row['bestObservedStage']}` | {row['bestObservedScore']:.2f} | {missing} |"
        )
    lines.extend(
        [
            "",
            "## Reference trajectory call structure",
            "",
            "| Scenario | Stages | Tool stages | Model run mode |",
            "| --- | ---: | ---: | --- |",
        ]
    )
    for traj in trajectories:
        lines.append(
            f"| `{traj['scenario']}` | {len(traj['stages'])} | {traj['metrics']['toolCallsExecuted']} | `{traj['modelRun']['mode']}` |"
        )
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def write_model_call_shapes(path: Path, trajectories: list[dict[str, Any]]) -> None:
    shapes = []
    for traj in trajectories:
        for stage in traj["stages"]:
            if "providerEnvelope" in stage:
                shapes.append(
                    {
                        "scenario": traj["scenario"],
                        "kind": stage["kind"],
                        "iteration": stage.get("iteration"),
                        **stage["providerEnvelope"],
                    }
                )
    write_json(
        path,
        {
            "schema": SCHEMA,
            "notes": [
                "runtimeUseModelParams is the eliza runtime abstraction.",
                "cerebrasChatCompletionsPayload mirrors plugins/plugin-cerebras/index.ts buildRequestPayload.",
                "vercelGatewayCommon mirrors cloud/packages/lib/providers/vercel-ai-gateway.ts before generateText/streamText.",
            ],
            "shapes": shapes,
        },
    )


def run(args: argparse.Namespace) -> dict[str, Any]:
    AUDIT_DIR.mkdir(parents=True, exist_ok=True)
    source_matrix = load_source_matrix()
    entries = [entry for entry in load_dataset_entries() if is_done(entry)]
    if args.max_sources:
        entries = entries[: args.max_sources]

    samples: list[dict[str, Any]] = []
    for entry in entries:
        samples.extend(collect_dataset_samples(entry, args.samples_per_source))
    summary = summarize_samples(samples, source_matrix)
    trajectories = build_reference_trajectories(args)

    write_jsonl(DATASET_SAMPLES_JSONL, samples)
    write_json(DATASET_SIMILARITY_JSON, summary)
    write_json(REFERENCE_TRAJECTORIES_JSON, {"schema": SCHEMA, "trajectories": trajectories})
    write_reference_markdown(REFERENCE_TRAJECTORIES_MD, trajectories)
    write_model_call_shapes(MODEL_CALL_SHAPES_JSON, trajectories)
    write_composition_audit(COMPOSITION_AUDIT_MD, summary, trajectories)

    return {
        "datasets": len(entries),
        "samples": len(samples),
        "liveCerebras": bool(args.run_cerebras and os.environ.get("CEREBRAS_API_KEY")),
        "outputs": [
            str(DATASET_SAMPLES_JSONL),
            str(DATASET_SIMILARITY_JSON),
            str(REFERENCE_TRAJECTORIES_JSON),
            str(REFERENCE_TRAJECTORIES_MD),
            str(MODEL_CALL_SHAPES_JSON),
            str(COMPOSITION_AUDIT_MD),
        ],
    }


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Sample corpora and build v5 native trajectory alignment audit artifacts."
    )
    parser.add_argument("--samples-per-source", type=int, default=3)
    parser.add_argument("--max-sources", type=int, default=0)
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--run-cerebras", action="store_true")
    parser.add_argument("--cerebras-base-url", default=DEFAULT_BASE_URL)
    parser.add_argument("--timeout", type=int, default=90)
    return parser


def main() -> int:
    args = build_arg_parser().parse_args()
    result = run(args)
    print(json.dumps(result, indent=2, sort_keys=True))
    if args.run_cerebras and not os.environ.get("CEREBRAS_API_KEY"):
        print("warning: --run-cerebras set but CEREBRAS_API_KEY is not present; wrote offline fixtures")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
