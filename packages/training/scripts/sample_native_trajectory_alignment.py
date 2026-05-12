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
stages call the configured Cerebras-compatible chat-completions endpoint. The
model defaults from env/CLI, with the current development backend only as a
fallback. Without a key, the script writes deterministic fixture responses and
marks the run as offline; this keeps the data-prep audit reproducible in CI and
on local machines without credentials.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import random
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
REAL_ELIZA_COMPARISON_JSON = AUDIT_DIR / "real_eliza_trajectory_comparison.json"
REAL_ELIZA_COMPARISON_MD = AUDIT_DIR / "real_eliza_trajectory_comparison.md"
REAL_ELIZA_NATIVE_ROWS_JSONL = AUDIT_DIR / "real_eliza_native_rows.jsonl"
SYNTHESIS_TEMPLATES_JSON = AUDIT_DIR / "native_synthesis_templates.json"
SYNTHESIS_TEMPLATES_MD = AUDIT_DIR / "native_synthesis_templates.md"

SCHEMA = "eliza.native_trajectory_alignment_audit.v1"
NATIVE_BOUNDARY_FORMAT = "eliza_native_v1"
DEFAULT_MODEL = (
    os.environ.get("CEREBRAS_MODEL")
    or os.environ.get("ELIZA_COLLECTION_MODEL")
    or "gpt-oss-120b"
)
DEFAULT_BASE_URL = "https://api.cerebras.ai/v1"
DEFAULT_SEED = "eliza-native-audit-2026-05-07"

MAX_PREVIEW_CHARS = 2_400
MAX_JSON_BYTES = 8 * 1024 * 1024
DEFAULT_MAX_SCAN_ROWS = 50_000
SKIP_DIRS = {".cache", ".git", "__pycache__", "node_modules"}
DEFAULT_REAL_TRAJECTORY_ROOTS = (
    "trajectories",
    "trajectories-eliza-cerebras",
    "artifacts",
)
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


def stable_int(*parts: object) -> int:
    return int(stable_hash(*parts, length=16), 16)


def rng_for(seed: str, *parts: object) -> random.Random:
    return random.Random(stable_int(seed, *parts))


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


def read_jsonl_samples(
    path: Path,
    limit: int,
    rng: random.Random,
    *,
    max_scan_rows: int = DEFAULT_MAX_SCAN_ROWS,
) -> list[Any]:
    rows: list[Any] = []
    with path.open("r", encoding="utf-8", errors="replace") as f:
        seen = 0
        for line in f:
            line = line.strip()
            if not line:
                continue
            seen += 1
            try:
                parsed = json.loads(line)
            except json.JSONDecodeError:
                parsed = {"_raw": compact(line)}
            if len(rows) < limit:
                rows.append(parsed)
            else:
                replace_at = rng.randrange(seen)
                if replace_at < limit:
                    rows[replace_at] = parsed
            if max_scan_rows > 0 and seen >= max_scan_rows:
                break
    return rows


def read_json_samples(path: Path, limit: int, rng: random.Random) -> list[Any]:
    if path.stat().st_size > MAX_JSON_BYTES:
        with path.open("r", encoding="utf-8", errors="replace") as f:
            return [{"_raw_preview": compact(f.read(MAX_PREVIEW_CHARS))}]
    with path.open("r", encoding="utf-8", errors="replace") as f:
        raw = json.load(f)
    if isinstance(raw, list):
        if len(raw) <= limit:
            return raw
        return [raw[i] for i in sorted(rng.sample(range(len(raw)), limit))]
    if isinstance(raw, dict):
        for key in ("data", "rows", "examples", "records", "messages"):
            value = raw.get(key)
            if isinstance(value, list) and value:
                if len(value) <= limit:
                    return value
                return [value[i] for i in sorted(rng.sample(range(len(value)), limit))]
        return [raw]
    return [{"value": raw}]


def read_parquet_samples(
    path: Path,
    limit: int,
    rng: random.Random,
    *,
    max_scan_rows: int = DEFAULT_MAX_SCAN_ROWS,
) -> list[Any]:
    if pq is None:
        return [{"_parquet": "pyarrow unavailable", "path": str(path)}]
    pf = pq.ParquetFile(path)
    rows: list[Any] = []
    seen = 0
    batch_size = max(128, limit * 16)
    for batch in pf.iter_batches(batch_size=batch_size):
        for parsed in batch.to_pylist():
            seen += 1
            if len(rows) < limit:
                rows.append(parsed)
            else:
                replace_at = rng.randrange(seen)
                if replace_at < limit:
                    rows[replace_at] = parsed
            if max_scan_rows > 0 and seen >= max_scan_rows:
                break
        if max_scan_rows > 0 and seen >= max_scan_rows:
            break
    return rows


def read_tabular_samples(
    path: Path,
    limit: int,
    delimiter: str,
    rng: random.Random,
    *,
    max_scan_rows: int = DEFAULT_MAX_SCAN_ROWS,
) -> list[Any]:
    rows: list[Any] = []
    with path.open("r", encoding="utf-8", errors="replace", newline="") as f:
        reader = csv.DictReader(f, delimiter=delimiter)
        seen = 0
        for row in reader:
            seen += 1
            if len(rows) < limit:
                rows.append(row)
            else:
                replace_at = rng.randrange(seen)
                if replace_at < limit:
                    rows[replace_at] = row
            if max_scan_rows > 0 and seen >= max_scan_rows:
                break
    return rows


def read_text_sample(path: Path) -> list[Any]:
    with path.open("r", encoding="utf-8", errors="replace") as f:
        return [{"_text_preview": compact(f.read(MAX_PREVIEW_CHARS))}]


def read_samples_from_file(
    path: Path,
    limit: int,
    rng: random.Random,
    *,
    max_scan_rows: int = DEFAULT_MAX_SCAN_ROWS,
) -> list[Any]:
    suffix = path.suffix.lower()
    try:
        if suffix == ".jsonl":
            return read_jsonl_samples(path, limit, rng, max_scan_rows=max_scan_rows)
        if suffix == ".json":
            return read_json_samples(path, limit, rng)
        if suffix == ".parquet":
            return read_parquet_samples(path, limit, rng, max_scan_rows=max_scan_rows)
        if suffix == ".csv":
            return read_tabular_samples(path, limit, ",", rng, max_scan_rows=max_scan_rows)
        if suffix == ".tsv":
            return read_tabular_samples(path, limit, "\t", rng, max_scan_rows=max_scan_rows)
        return read_text_sample(path)
    except Exception as exc:  # noqa: BLE001 - keep audit moving.
        return [{"_read_error": f"{type(exc).__name__}: {exc}", "path": str(path)}]


def collect_dataset_samples(
    entry: DatasetEntry,
    samples_per_source: int,
    *,
    seed: str = DEFAULT_SEED,
    max_scan_rows: int = DEFAULT_MAX_SCAN_ROWS,
) -> list[dict[str, Any]]:
    samples: list[dict[str, Any]] = []
    files = sorted_candidate_files(entry.raw_dir)
    rng = rng_for(seed, entry.slug)
    rng.shuffle(files)
    for file_path in files:
        needed = samples_per_source - len(samples)
        if needed <= 0:
            break
        file_rng = rng_for(seed, entry.slug, str(file_path.relative_to(entry.raw_dir)))
        for row_idx, raw in enumerate(
            read_samples_from_file(
                file_path,
                needed,
                file_rng,
                max_scan_rows=max_scan_rows,
            )
        ):
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
                    "nativeBoundaryComponents": native_boundary_components(features),
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
                "nativeBoundaryComponents": native_boundary_components(set()),
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
    if lower_keys & {"thought", "reasoning", "chain_of_thought"} or "<think>" in text:
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


def native_boundary_components(features: set[str]) -> dict[str, bool]:
    """Map loose raw-source features to final `eliza_native_v1` components."""
    return {
        "request.messages": bool(features & {"chat_messages", "current_user_message"}),
        "request.prompt": bool(features & {"current_user_message", "planning_text"}),
        "request.tools": "tool_schemas" in features,
        "request.toolChoice": False,
        "request.responseSchema": False,
        "response.text": "user_visible_message" in features,
        "response.toolCalls": "tool_calls" in features,
        "response.finishReason": "tool_calls" in features,
        "response.usage": "cache_observation" in features,
        "tool.result.messages": "tool_results" in features,
        "evaluation.decision": bool(features & {"evaluator_decision", "success_label"}),
        "metadata.contexts": "context_labels" in features,
        "cacheStats": "cache_observation" in features,
    }


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
        component_counts = Counter(
            component
            for row in rows
            for component, present in (row.get("nativeBoundaryComponents") or {}).items()
            if present
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
                "nativeComponentCoverage": {
                    component: round(component_counts[component] / max(1, len(rows)), 4)
                    for component in sorted(
                        {
                            component
                            for row in rows
                            for component in (row.get("nativeBoundaryComponents") or {})
                        }
                    )
                },
                "missingCriticalSignals": missing_critical_signals(feature_counts),
                "transformationAssessment": transformation_assessment(
                    matrix_row.get("transform"),
                    feature_counts,
                    component_counts,
                ),
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


def transformation_assessment(
    transform: str | None,
    feature_counts: Counter[str],
    component_counts: Counter[str],
) -> dict[str, Any]:
    has_tools = feature_counts["tool_calls"] > 0
    has_schemas = feature_counts["tool_schemas"] > 0
    has_results = feature_counts["tool_results"] > 0
    has_eval = feature_counts["evaluator_decision"] > 0 or feature_counts["success_label"] > 0
    has_contexts = feature_counts["context_labels"] > 0
    if transform == "function_calling_to_planner" and has_tools and has_schemas:
        verdict = "good_planner_seed_needs_runtime_context"
    elif has_tools and has_results and has_eval:
        verdict = "strong_full_trajectory_seed"
    elif has_tools:
        verdict = "planner_seed_missing_execution_loop"
    elif feature_counts["chat_messages"] > 0:
        verdict = "message_handler_seed_only"
    else:
        verdict = "low_alignment_or_unreadable_sample"

    improvements: list[str] = []
    if not has_contexts:
        improvements.append("synthesize or infer selected contexts, then mark them inferred")
    if not has_schemas and has_tools:
        improvements.append("backfill AI SDK/OpenAI-compatible tool schemas")
    if has_tools and not has_results:
        improvements.append("synthesize grounded tool-result events or pair with executable fixtures")
    if has_results and not has_eval:
        improvements.append("synthesize evaluator decision rows from goal, call, and result")
    if component_counts["request.toolChoice"] == 0:
        improvements.append("set explicit toolChoice from runtime policy: required for internal routing tools, auto for planner tools")

    return {
        "verdict": verdict,
        "idealFinalFormat": NATIVE_BOUNDARY_FORMAT,
        "improvements": improvements,
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


def base_context_object(
    scenario_name: str,
    scenario: dict[str, Any],
    *,
    model: str,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
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
        "metadata": {"scenario": scenario_name, "model": model},
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
    context, static_segments = base_context_object(scenario_name, scenario, model=model)
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
            "modelName": shape["cerebrasChatCompletionsPayload"].get("model", DEFAULT_MODEL),
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
        "- The final training row is `eliza_native_v1`: one Vercel AI SDK model boundary with `request` and `response`, not the intermediate `eliza.native_tool_calling.v1` bootstrap shape.",
        "- Real recorder files are stage-based JSON; this audit exports their model stages back into `eliza_native_v1` rows for local smoke training.",
        "- Newer real stages preserve `messages`, `tools`, `toolChoice`, `response`, `toolCalls`, `finishReason`, and `usage`; older stages may only have a large `prompt` plus `response`.",
        "- `responseSchema`, `providerOptions`, and `providerMetadata` are absent in the sampled real runs, so dataset transforms should not invent them.",
        "- Stage 1 is now native tool-call shaped when `MESSAGE_HANDLER_PLAN` is present with `toolChoice: required`; those rows are excellent routing supervision.",
        "- Provider usage/cache counters should be copied only from live runs; bootstrap corpora should leave usage/cache fields empty.",
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
                "cerebrasChatCompletionsPayload mirrors plugin-openai with OPENAI_BASE_URL=https://api.cerebras.ai/v1.",
                "vercelGatewayCommon mirrors cloud/packages/lib/providers/vercel-ai-gateway.ts before generateText/streamText.",
            ],
            "shapes": shapes,
        },
    )


def iter_real_trajectory_files(roots: list[str]) -> list[Path]:
    files: list[Path] = []
    for raw_root in roots:
        root = (ROOT.parent.parent / raw_root).resolve() if not Path(raw_root).is_absolute() else Path(raw_root)
        if not root.exists():
            continue
        if root.name == "artifacts":
            files.extend(root.glob("*/trajectories/**/*.json"))
        else:
            files.extend(root.glob("**/*.json"))
    return sorted({path.resolve() for path in files})


def load_real_trajectory(path: Path) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    if not isinstance(value, dict):
        return None
    if not value.get("trajectoryId") or not isinstance(value.get("stages"), list):
        return None
    return value


def summarize_real_trajectories(paths: list[Path], seed: str, max_trajectories: int) -> dict[str, Any]:
    loaded: list[tuple[Path, dict[str, Any]]] = []
    for path in paths:
        trajectory = load_real_trajectory(path)
        if trajectory is not None:
            loaded.append((path, trajectory))

    rng = rng_for(seed, "real-eliza-trajectories")
    sampled = loaded[:]
    rng.shuffle(sampled)
    sampled = sampled[:max_trajectories] if max_trajectories > 0 else sampled

    stage_counts: Counter[str] = Counter()
    model_component_counts: Counter[str] = Counter()
    model_stage_counts: Counter[str] = Counter()
    examples: list[dict[str, Any]] = []
    native_rows: list[dict[str, Any]] = []
    for path, trajectory in loaded:
        for row in native_rows_from_recorded_trajectory(trajectory, path):
            native_rows.append(row)

    for path, trajectory in sampled:
        stages = trajectory.get("stages") or []
        for index, stage in enumerate(stages):
            kind = str(stage.get("kind") or "unknown")
            stage_counts[kind] += 1
            model = stage.get("model") if isinstance(stage.get("model"), dict) else None
            if model:
                model_stage_counts[kind] += 1
                for field in (
                    "prompt",
                    "messages",
                    "tools",
                    "toolChoice",
                    "responseSchema",
                    "providerOptions",
                    "response",
                    "toolCalls",
                    "finishReason",
                    "usage",
                    "providerMetadata",
                ):
                    value = model.get(field)
                    if value not in (None, "", []):
                        model_component_counts[f"{kind}.{field}"] += 1
                        model_component_counts[field] += 1
                if len(examples) < 12:
                    examples.append(
                        {
                            "path": str(path),
                            "trajectoryId": trajectory.get("trajectoryId"),
                            "stageIndex": index,
                            "stageId": stage.get("stageId"),
                            "kind": kind,
                            "modelType": model.get("modelType"),
                            "modelName": model.get("modelName"),
                            "provider": model.get("provider"),
                            "requestComponents": {
                                key: key in model and model.get(key) not in (None, "", [])
                                for key in ("prompt", "messages", "tools", "toolChoice", "responseSchema", "providerOptions")
                            },
                            "responseComponents": {
                                key: key in model and model.get(key) not in (None, "", [])
                                for key in ("response", "toolCalls", "finishReason", "usage", "providerMetadata")
                            },
                            "promptPreview": compact(model.get("prompt") or "", 500),
                            "toolCallsPreview": compact(model.get("toolCalls"), 800),
                        }
                    )

    return {
        "schema": SCHEMA,
        "format": NATIVE_BOUNDARY_FORMAT,
        "discoveredFiles": len(paths),
        "validTrajectoryFiles": len(loaded),
        "sampledTrajectoryFiles": len(sampled),
        "stageCounts": dict(sorted(stage_counts.items())),
        "modelStageCounts": dict(sorted(model_stage_counts.items())),
        "modelComponentCounts": dict(sorted(model_component_counts.items())),
        "nativeRowsExported": len(native_rows),
        "samples": examples,
        "nativeRows": native_rows,
    }


def _status_to_native(status: Any) -> str:
    if status == "finished":
        return "completed"
    if status == "errored":
        return "error"
    if status == "running":
        return "active"
    return "completed"


def _stage_kind_to_task_type(kind: Any) -> str:
    normalized = str(kind or "").replace("-", "_").lower()
    if normalized == "messagehandler":
        return "should_respond"
    if normalized in {"planner", "subplanner"}:
        return "action_planner"
    if normalized == "evaluation":
        return "evaluator"
    return normalized or "response"


def _usage_from_model(model: dict[str, Any]) -> dict[str, Any] | None:
    usage = model.get("usage")
    if not isinstance(usage, dict):
        return None
    out: dict[str, Any] = {}
    for src, dst in (
        ("promptTokens", "promptTokens"),
        ("completionTokens", "completionTokens"),
        ("totalTokens", "totalTokens"),
        ("cacheReadInputTokens", "cacheReadInputTokens"),
        ("cacheCreationInputTokens", "cacheCreationInputTokens"),
    ):
        if usage.get(src) is not None:
            out[dst] = usage[src]
    return out or None


def native_rows_from_recorded_trajectory(trajectory: dict[str, Any], path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    metrics = trajectory.get("metrics") if isinstance(trajectory.get("metrics"), dict) else {}
    stages = trajectory.get("stages") or []
    for index, stage in enumerate(stages):
        if not isinstance(stage, dict) or not isinstance(stage.get("model"), dict):
            continue
        model = stage["model"]
        request: dict[str, Any] = {}
        if isinstance(model.get("prompt"), str) and model["prompt"].strip():
            request["prompt"] = model["prompt"]
        if isinstance(model.get("messages"), list) and model["messages"]:
            request["messages"] = model["messages"]
        for key in ("tools", "toolChoice", "responseSchema", "providerOptions"):
            if key in model and model.get(key) is not None:
                request[key] = model[key]
        response: dict[str, Any] = {"text": model.get("response") if isinstance(model.get("response"), str) else ""}
        if isinstance(model.get("toolCalls"), list):
            response["toolCalls"] = model["toolCalls"]
        if isinstance(model.get("finishReason"), str):
            response["finishReason"] = model["finishReason"]
        usage = _usage_from_model(model)
        if usage:
            response["usage"] = usage
        if model.get("providerMetadata") is not None:
            response["providerMetadata"] = model["providerMetadata"]

        stage_id = str(stage.get("stageId") or f"stage-{index}")
        row = {
            "format": NATIVE_BOUNDARY_FORMAT,
            "schemaVersion": 1,
            "boundary": "vercel_ai_sdk.generateText",
            "trajectoryId": trajectory.get("trajectoryId"),
            "agentId": trajectory.get("agentId"),
            "source": "recorded_eliza_runtime_stage",
            "status": _status_to_native(trajectory.get("status")),
            "stepId": stage_id,
            "callId": f"{stage_id}:model",
            "stepIndex": index,
            "callIndex": 0,
            "timestamp": stage.get("startedAt") or trajectory.get("startedAt") or 0,
            "purpose": stage.get("kind"),
            "stepType": stage.get("kind"),
            "model": model.get("modelName") or model.get("modelType"),
            "modelType": model.get("modelType"),
            "provider": model.get("provider"),
            "request": request,
            "response": response,
            "metadata": {
                "task_type": _stage_kind_to_task_type(stage.get("kind")),
                "source_dataset": "real_eliza_runtime",
                "trajectory_id": trajectory.get("trajectoryId"),
                "step_id": stage_id,
                "call_id": f"{stage_id}:model",
                "source_path": str(path),
            },
            "trajectoryTotals": {
                "stepCount": len(stages),
                "llmCallCount": sum(1 for s in stages if isinstance(s, dict) and isinstance(s.get("model"), dict)),
                "providerAccessCount": 0,
                "promptTokens": metrics.get("totalPromptTokens", 0),
                "completionTokens": metrics.get("totalCompletionTokens", 0),
                "cacheReadInputTokens": metrics.get("totalCacheReadTokens", 0),
                "cacheCreationInputTokens": metrics.get("totalCacheCreationTokens", 0),
            },
            "cacheStats": {
                "totalInputTokens": metrics.get("totalPromptTokens", 0),
                "promptTokens": metrics.get("totalPromptTokens", 0),
                "completionTokens": metrics.get("totalCompletionTokens", 0),
                "cacheReadInputTokens": metrics.get("totalCacheReadTokens", 0),
                "cacheCreationInputTokens": metrics.get("totalCacheCreationTokens", 0),
                "cachedCallCount": 0,
                "cacheReadCallCount": 0,
                "cacheWriteCallCount": 0,
                "tokenUsageEstimatedCallCount": 0,
            },
        }
        if request and (response["text"] or response.get("toolCalls")):
            rows.append(row)
    return rows


def write_real_eliza_markdown(path: Path, comparison: dict[str, Any]) -> None:
    counts = comparison["modelComponentCounts"]
    lines = [
        "# Real Eliza trajectory comparison",
        "",
        f"- valid trajectory files: `{comparison['validTrajectoryFiles']}`",
        f"- sampled trajectory files: `{comparison['sampledTrajectoryFiles']}`",
        f"- exported native boundary rows: `{comparison['nativeRowsExported']}`",
        "",
        "## Observed Model-Boundary Components",
        "",
        "| Component | Count in sampled model stages |",
        "| --- | ---: |",
    ]
    for key in (
        "prompt",
        "messages",
        "tools",
        "toolChoice",
        "responseSchema",
        "providerOptions",
        "response",
        "toolCalls",
        "finishReason",
        "usage",
        "providerMetadata",
    ):
        lines.append(f"| `{key}` | {counts.get(key, 0)} |")
    lines.extend(["", "## Sampled Stages", ""])
    for sample in comparison["samples"]:
        lines.extend(
            [
                f"### `{sample['trajectoryId']}` / `{sample['kind']}`",
                "",
                f"- file: `{sample['path']}`",
                f"- model: `{sample.get('modelName') or sample.get('modelType')}` via `{sample.get('provider')}`",
                f"- request: `{sample['requestComponents']}`",
                f"- response: `{sample['responseComponents']}`",
                "",
            ]
        )
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


SYNTHESIS_TEMPLATE_LIBRARY: dict[str, dict[str, Any]] = {
    "context_routing_backfill": {
        "target": "request/response pair for Stage 1 messageHandler",
        "when": "dataset has chat text but no selected contexts",
        "output": {
            "format": NATIVE_BOUNDARY_FORMAT,
            "request": {
                "messages": ["runtime-style system/context registry message", "conversation up to current user turn"],
                "tools": {"MESSAGE_HANDLER_PLAN": "strict internal routing tool"},
                "toolChoice": "required",
            },
            "response": {"toolCalls": ["MESSAGE_HANDLER_PLAN({processMessage, plan.contexts, thought})"]},
        },
        "quality": "mark contexts as inferred unless they came from an Eliza trajectory",
    },
    "tool_schema_backfill": {
        "target": "request.tools",
        "when": "dataset has tool names/calls but lacks full JSON schemas",
        "output": {"request": {"tools": "AI SDK tool map with inputSchema-compatible JSON schema"}},
        "quality": "silver if source supplied schema text; bronze if schema is teacher inferred",
    },
    "planner_tool_call_backfill": {
        "target": "response.toolCalls",
        "when": "dataset has user task and tool specs but no native tool_calls array",
        "output": {"response": {"text": "", "toolCalls": [{"toolCallId": "stable id", "toolName": "name", "input": {}}], "finishReason": "tool-calls"}},
        "quality": "preserve source calls when present; only synthesize missing args with review required",
    },
    "tool_result_and_evaluator_backfill": {
        "target": "tool result messages plus evaluator model boundary",
        "when": "planner data has calls but no execution/evaluator loop",
        "output": {
            "tool_result": {"role": "tool", "tool_call_id": "call id", "content": "grounded result JSON"},
            "evaluation": {"success": True, "decision": "FINISH|NEXT_RECOMMENDED|CONTINUE", "thought": "short reason"},
        },
        "quality": "bronze/synthetic unless result was actually executed in Eliza",
    },
    "runtime_usage_capture": {
        "target": "response.usage/providerMetadata/cacheStats",
        "when": "dataset lacks provider token/cache observations",
        "output": "do not synthesize; capture from real Eliza runs only",
        "quality": "missing is acceptable for bootstrap rows",
    },
}


def dataset_synthesis_plan(summary: dict[str, Any]) -> dict[str, Any]:
    datasets: list[dict[str, Any]] = []
    for row in summary.get("datasets", []):
        missing = set(row.get("missingCriticalSignals") or [])
        coverage = row.get("nativeComponentCoverage") or {}
        template_ids: list[str] = []
        if coverage.get("metadata.contexts", 0) < 0.5:
            template_ids.append("context_routing_backfill")
        if coverage.get("request.tools", 0) < 0.5 and coverage.get("response.toolCalls", 0) > 0:
            template_ids.append("tool_schema_backfill")
        if "no native or recoverable tool-call signal" in missing:
            if row.get("bestObservedStage") in {"message_handler", "planner"}:
                template_ids.append("planner_tool_call_backfill")
        elif coverage.get("response.toolCalls", 0) < 0.7:
            template_ids.append("planner_tool_call_backfill")
        if "no action-result/evaluator input signal" in missing or "no explicit evaluator success/decision labels" in missing:
            template_ids.append("tool_result_and_evaluator_backfill")
        if coverage.get("cacheStats", 0) == 0:
            template_ids.append("runtime_usage_capture")
        datasets.append(
            {
                "dataset": row["dataset"],
                "transform": row.get("transform"),
                "qualityRating": row.get("qualityRating"),
                "bestObservedStage": row.get("bestObservedStage"),
                "nativeComponentCoverage": coverage,
                "missingCriticalSignals": row.get("missingCriticalSignals") or [],
                "templateIds": list(dict.fromkeys(template_ids)),
                "recommendedFrame": recommended_synthesis_frame(row, template_ids),
            }
        )
    return {
        "schema": SCHEMA,
        "format": NATIVE_BOUNDARY_FORMAT,
        "templates": SYNTHESIS_TEMPLATE_LIBRARY,
        "datasets": datasets,
    }


def recommended_synthesis_frame(row: dict[str, Any], template_ids: list[str]) -> str:
    transform = row.get("transform") or ""
    if row.get("qualityRating") == "quarantine":
        return "keep out of default SFT; only synthesize in a dedicated side corpus"
    if transform == "function_calling_to_planner":
        return "frame as planner calls: preserve source tools/calls, add Eliza message-handler context and optional evaluator rows"
    if "dialogue" in transform:
        return "frame as message-handler routing plus direct REPLY terminal planner rows; do not invent non-grounded external tools"
    if "agent" in transform or "trajectory" in transform:
        return "frame as append-only trajectory slices; normalize tool names to Eliza tools and add evaluator rows only where results are present"
    if "runtime_usage_capture" in template_ids:
        return "use as bootstrap request/response data; collect usage/cache only from live Eliza comparisons"
    return "convert only the observed source signal to eliza_native_v1 and mark inferred components in metadata"


def write_synthesis_templates_markdown(path: Path, plan: dict[str, Any]) -> None:
    lines = [
        "# Native synthesis templates",
        "",
        f"Target final format: `{NATIVE_BOUNDARY_FORMAT}`.",
        "",
        "## Template Library",
        "",
    ]
    for template_id, template in plan["templates"].items():
        lines.extend(
            [
                f"### `{template_id}`",
                "",
                f"- target: {template['target']}",
                f"- when: {template['when']}",
                f"- quality: {template['quality']}",
                "",
            ]
        )
    lines.extend(
        [
            "## Dataset Plans",
            "",
            "| Dataset | Rating | Best stage | Templates | Frame |",
            "| --- | --- | --- | --- | --- |",
        ]
    )
    for row in plan["datasets"]:
        templates = ", ".join(f"`{item}`" for item in row["templateIds"]) or "none"
        lines.append(
            f"| `{row['dataset']}` | `{row.get('qualityRating') or ''}` | `{row.get('bestObservedStage') or ''}` | {templates} | {row['recommendedFrame']} |"
        )
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def run(args: argparse.Namespace) -> dict[str, Any]:
    AUDIT_DIR.mkdir(parents=True, exist_ok=True)
    source_matrix = load_source_matrix()
    entries = [entry for entry in load_dataset_entries() if is_done(entry)]
    if args.max_sources:
        entries = entries[: args.max_sources]

    samples: list[dict[str, Any]] = []
    for entry in entries:
        samples.extend(
            collect_dataset_samples(
                entry,
                args.samples_per_source,
                seed=args.seed,
                max_scan_rows=args.max_scan_rows,
            )
        )
    summary = summarize_samples(samples, source_matrix)
    trajectories = build_reference_trajectories(args)
    real_comparison = summarize_real_trajectories(
        iter_real_trajectory_files(args.trajectory_root),
        args.seed,
        args.max_real_trajectories,
    )
    synthesis_plan = dataset_synthesis_plan(summary)

    write_jsonl(DATASET_SAMPLES_JSONL, samples)
    write_json(DATASET_SIMILARITY_JSON, summary)
    write_json(REFERENCE_TRAJECTORIES_JSON, {"schema": SCHEMA, "trajectories": trajectories})
    write_reference_markdown(REFERENCE_TRAJECTORIES_MD, trajectories)
    write_model_call_shapes(MODEL_CALL_SHAPES_JSON, trajectories)
    write_composition_audit(COMPOSITION_AUDIT_MD, summary, trajectories)
    real_rows = real_comparison.pop("nativeRows")
    write_json(REAL_ELIZA_COMPARISON_JSON, real_comparison)
    write_real_eliza_markdown(REAL_ELIZA_COMPARISON_MD, real_comparison)
    write_jsonl(REAL_ELIZA_NATIVE_ROWS_JSONL, real_rows)
    write_json(SYNTHESIS_TEMPLATES_JSON, synthesis_plan)
    write_synthesis_templates_markdown(SYNTHESIS_TEMPLATES_MD, synthesis_plan)

    return {
        "datasets": len(entries),
        "samples": len(samples),
        "realElizaNativeRows": len(real_rows),
        "liveCerebras": bool(args.run_cerebras and os.environ.get("CEREBRAS_API_KEY")),
        "outputs": [
            str(DATASET_SAMPLES_JSONL),
            str(DATASET_SIMILARITY_JSON),
            str(REFERENCE_TRAJECTORIES_JSON),
            str(REFERENCE_TRAJECTORIES_MD),
            str(MODEL_CALL_SHAPES_JSON),
            str(COMPOSITION_AUDIT_MD),
            str(REAL_ELIZA_COMPARISON_JSON),
            str(REAL_ELIZA_COMPARISON_MD),
            str(REAL_ELIZA_NATIVE_ROWS_JSONL),
            str(SYNTHESIS_TEMPLATES_JSON),
            str(SYNTHESIS_TEMPLATES_MD),
        ],
    }


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Sample corpora and build final eliza_native_v1 trajectory alignment audit artifacts."
    )
    parser.add_argument("--samples-per-source", type=int, default=10)
    parser.add_argument("--max-sources", type=int, default=0)
    parser.add_argument("--seed", default=DEFAULT_SEED)
    parser.add_argument("--max-scan-rows", type=int, default=DEFAULT_MAX_SCAN_ROWS)
    parser.add_argument(
        "--trajectory-root",
        action="append",
        default=list(DEFAULT_REAL_TRAJECTORY_ROOTS),
        help="Recorded Eliza trajectory root. Repeatable. Defaults to local trajectories, trajectories-eliza-cerebras, and artifacts.",
    )
    parser.add_argument("--max-real-trajectories", type=int, default=30)
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
