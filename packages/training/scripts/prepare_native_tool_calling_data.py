#!/usr/bin/env python3
"""Prepare native tool-calling bootstrap data.

This script is the bridge between the legacy training corpus and the v5
native-tool runtime plan. It does three things:

1. Builds a source matrix from datasets.yaml with per-source availability,
   transformation family, strengths, and weaknesses.
2. Converts already-normalized legacy ElizaRecord JSONL files into native
   tool-calling JSON rows.
3. Validates native rows without requiring jsonschema as a runtime dependency.

It intentionally does not replace download_datasets.py or normalize.py. Use:

    uv run python scripts/download_datasets.py --priority all
    uv run python scripts/normalize.py
    uv run python scripts/prepare_native_tool_calling_data.py --transform-normalized

For a fast smoke run:

    uv run python scripts/prepare_native_tool_calling_data.py --write-matrix
    uv run python scripts/prepare_native_tool_calling_data.py \
        --transform-normalized --only hermes-fc-v1 --max-records-per-source 100
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import logging
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

import yaml

ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS))

from lib.runtime_phases import PHASE_OOB, classify_phase  # noqa: E402


DATASETS_FILE = ROOT / "datasets.yaml"
RAW_DIR = ROOT / "data" / "raw"
NORMALIZED_DIR = ROOT / "data" / "normalized"
NATIVE_DIR = ROOT / "data" / "native"
NATIVE_RECORDS_DIR = NATIVE_DIR / "records"
NATIVE_ERRORS_DIR = NATIVE_DIR / "errors"
SOURCE_MATRIX_JSON = NATIVE_DIR / "source_matrix.json"
SOURCE_MATRIX_MD = NATIVE_DIR / "SOURCE_MATRIX.md"
MANIFEST_PATH = NATIVE_DIR / "manifest.json"

SCHEMA_VERSION = "eliza.native_tool_calling.v1"

TERMINAL_TOOLS = {"REPLY", "IGNORE", "STOP"}
LEGACY_TERMINAL_OR_ROUTING = {
    "RESPOND",
    "IGNORE",
    "STOP",
    "REPLY",
    "TASK_CALL",
    "SHELL",
    "MUTE_ROOM",
    "UNMUTE_ROOM",
    "FOLLOW_ROOM",
    "UNFOLLOW_ROOM",
}


logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("native-data")


@dataclass(frozen=True)
class TransformProfile:
    transform: str
    target_stages: tuple[str, ...]
    rating: str
    contexts: tuple[str, ...]
    strengths: tuple[str, ...]
    weaknesses: tuple[str, ...]
    recommended_weight: float
    default_include: bool = True


def profile(
    transform: str,
    stages: Iterable[str],
    rating: str,
    contexts: Iterable[str],
    strengths: Iterable[str],
    weaknesses: Iterable[str],
    weight: float,
    *,
    include: bool = True,
) -> TransformProfile:
    return TransformProfile(
        transform=transform,
        target_stages=tuple(stages),
        rating=rating,
        contexts=tuple(contexts),
        strengths=tuple(strengths),
        weaknesses=tuple(weaknesses),
        recommended_weight=weight,
        default_include=include,
    )


FUNCTION_CALLING_STRENGTHS = (
    "clear tool names and argument JSON",
    "good planner-call supervision after TASK_CALL unwrapping",
)
FUNCTION_CALLING_WEAKNESSES = (
    "usually single-turn and lacks action results",
    "contexts and evaluator decisions are inferred",
)


TRANSFORM_PROFILES: dict[str, TransformProfile] = {
    "scambench_passthrough": profile(
        "eliza_record_compat",
        ("message_handler", "planner", "evaluator"),
        "gold",
        ("wallet", "payments", "messaging", "security"),
        ("already in canonical ElizaRecord shape", "strong safety and scam-defense coverage"),
        ("legacy outputs may still be non-JSON", "native evaluator labels are partial"),
        1.0,
    ),
    "claude_distill": profile(
        "distill_reply_to_planner_reply",
        ("planner",),
        "bronze",
        ("general",),
        ("strong answer quality", "useful direct-reply style diversity"),
        ("raw thinking envelope is out of runtime distribution", "no native tools or action results"),
        0.15,
    ),
    "nubilio_trajectories": profile(
        "eliza_trajectory_compat",
        ("message_handler", "planner", "trajectory"),
        "gold",
        ("general", "messaging", "memory"),
        ("real deployed Eliza trajectories", "multi-turn agent behavior"),
        ("local corpus must be provided separately", "upstream response formats include mixed legacy envelopes"),
        1.0,
    ),
    "scam_defense_corpus": profile(
        "scam_defense_to_planner_and_evaluator",
        ("message_handler", "planner", "evaluator"),
        "gold",
        ("wallet", "payments", "security", "messaging"),
        ("high-value adversarial and scam workflows", "maps naturally to evaluator success/failure"),
        ("local corpus must be provided separately", "some refusal targets are inferred"),
        1.0,
    ),
    "light_multilight": profile(
        "dialogue_routing_to_message_handler",
        ("message_handler", "planner"),
        "silver",
        ("general", "messaging"),
        ("multi-party response-routing data", "good Stage 1 respond/ignore supervision"),
        ("local corpus must be provided separately", "no real tool calls"),
        0.8,
    ),
    "hermes_fc": profile(
        "function_calling_to_planner",
        ("planner",),
        "silver",
        ("general", "web", "knowledge"),
        FUNCTION_CALLING_STRENGTHS,
        FUNCTION_CALLING_WEAKNESSES,
        0.7,
    ),
    "hermes_fc_thinking": profile(
        "function_calling_to_planner",
        ("planner",),
        "silver",
        ("general", "web", "knowledge"),
        ("tool names and arguments plus reasoning traces",),
        FUNCTION_CALLING_WEAKNESSES,
        0.7,
    ),
    "glaive_fc": profile(
        "function_calling_to_planner",
        ("planner",),
        "silver",
        ("general", "web", "knowledge"),
        FUNCTION_CALLING_STRENGTHS,
        FUNCTION_CALLING_WEAKNESSES,
        0.65,
    ),
    "glaive_fc_reasoning": profile(
        "function_calling_to_planner",
        ("planner",),
        "silver",
        ("general", "web", "knowledge"),
        ("tool-call supervision with reasoning text",),
        FUNCTION_CALLING_WEAKNESSES,
        0.65,
    ),
    "sharegpt_tool_calls": profile(
        "function_calling_to_planner",
        ("planner",),
        "bronze",
        ("general",),
        ("broad natural-language requests",),
        ("tool schemas are inconsistent", "limited multi-step structure"),
        0.45,
    ),
    "functions_53k": profile(
        "function_calling_to_planner",
        ("planner",),
        "bronze",
        ("general",),
        ("large set of function-call examples",),
        ("synthetic and mostly single-turn", "weak trajectory/evaluator signal"),
        0.4,
    ),
    "bitagent": profile(
        "function_calling_to_planner",
        ("planner",),
        "silver",
        ("general",),
        FUNCTION_CALLING_STRENGTHS,
        FUNCTION_CALLING_WEAKNESSES,
        0.6,
    ),
    "toolhop": profile(
        "multi_hop_tools_to_planner",
        ("planner", "sub_planner"),
        "silver",
        ("knowledge", "web"),
        ("multi-hop tool-use structure", "useful for queued tool-call training"),
        ("still lacks central evaluator events", "tool result fidelity varies"),
        0.7,
    ),
    "openclaw_operator": profile(
        "operator_trace_to_planner",
        ("planner", "sub_planner"),
        "silver",
        ("browser", "code", "files"),
        ("operator-style action traces", "good for chained planning"),
        ("tool schemas require review", "environment assumptions are source-specific"),
        0.7,
    ),
    "mobile_actions": profile(
        "mobile_actions_to_planner",
        ("planner", "sub_planner"),
        "silver",
        ("browser", "device_control"),
        ("realistic mobile action traces",),
        ("not all actions exist in Eliza", "requires context remapping"),
        0.6,
    ),
    "nemotron_rl_tool_use": profile(
        "agentic_tool_trace_to_planner",
        ("planner", "sub_planner"),
        "silver",
        ("general", "web", "knowledge"),
        ("agentic conversational tool-use traces",),
        ("evaluator decisions are not native Eliza evaluator labels",),
        0.7,
    ),
    "qwen36_trajectory": profile(
        "agentic_tool_trace_to_planner",
        ("planner", "trajectory"),
        "silver",
        ("general", "web", "knowledge"),
        ("trajectory-like function-calling data",),
        ("may use model-specific tool-call conventions",),
        0.7,
    ),
    "hermes_reasoning_tool_use": profile(
        "agentic_tool_trace_to_planner",
        ("planner",),
        "silver",
        ("general", "web", "knowledge"),
        ("reasoning plus tool-use examples",),
        ("reasoning must be compressed into planner thought",),
        0.55,
    ),
    "dolci_instruct": profile(
        "function_calling_to_planner",
        ("planner",),
        "silver",
        ("general",),
        ("well-formed tool-use instruction data",),
        FUNCTION_CALLING_WEAKNESSES,
        0.6,
    ),
    "nemotron_coding_reasoning": profile(
        "coding_tool_trace_to_planner",
        ("planner", "sub_planner"),
        "silver",
        ("code", "terminal", "files"),
        ("coding-focused tool reasoning",),
        ("can overfit code/terminal contexts", "requires tool-name normalization"),
        0.6,
    ),
    "hf_coding_tools_traces": profile(
        "coding_tool_trace_to_planner",
        ("planner", "sub_planner"),
        "silver",
        ("code", "terminal", "files"),
        ("realistic coding-tool traces",),
        ("may contain provider-specific execution artifacts",),
        0.65,
    ),
    "hermes_traces": profile(
        "agent_trace_to_planner",
        ("planner", "trajectory"),
        "silver",
        ("general", "web", "knowledge"),
        ("agent-trace style multi-step data",),
        ("mixed schemas across Hermes-family sources", "tool result/evaluator labels are weak"),
        0.5,
    ),
    "hermes_omniforge": profile(
        "agent_trace_to_planner",
        ("planner", "trajectory"),
        "silver",
        ("general", "web", "knowledge"),
        ("large agent-trace corpus",),
        ("large source requires caps", "mixed schema quality"),
        0.5,
    ),
    "aureth": profile(
        "agent_trace_to_planner",
        ("planner", "trajectory"),
        "silver",
        ("general", "web", "knowledge"),
        ("broad synthetic agent traces",),
        ("synthetic distribution", "tool results are not always execution-grounded"),
        0.45,
    ),
    "hermes_3": profile(
        "agent_trace_to_planner",
        ("planner",),
        "bronze",
        ("general",),
        ("broad instruction-following coverage",),
        ("less aligned to v5 native tool loop", "requires strong caps"),
        0.25,
    ),
    "mcp_flow": profile(
        "mcp_specs_to_planner",
        ("planner", "sub_planner"),
        "silver",
        ("connectors", "automation"),
        ("MCP tool/spec coverage", "good schema material for native tools"),
        ("often spec-heavy rather than trajectory-heavy", "needs runtime context mapping"),
        0.65,
    ),
    "mcp_messages": profile(
        "mcp_messages_to_planner",
        ("planner", "sub_planner"),
        "silver",
        ("connectors", "automation"),
        ("MCP tool-call examples",),
        ("server/tool names need normalization", "no central evaluator labels"),
        0.6,
    ),
    "mcp_routing": profile(
        "mcp_routing_to_planner",
        ("planner",),
        "bronze",
        ("connectors",),
        ("useful server/tool routing labels",),
        ("old routing-only shape is not the v5 planner loop",),
        0.25,
    ),
    "gemma_text": profile(
        "text_tool_trace_to_planner",
        ("planner",),
        "bronze",
        ("connectors", "automation"),
        ("salvageable text-encoded tool calls",),
        ("tool calls require parser heuristics", "schemas are weak"),
        0.3,
    ),
    "agent_trove": profile(
        "agent_trove_to_planner",
        ("planner", "sub_planner", "trajectory"),
        "gold",
        ("code", "terminal", "files", "web"),
        ("large agent trajectory corpus", "strong chained planning signal"),
        ("tool names and environments are not Eliza-native", "must cap to avoid code-heavy skew"),
        0.9,
    ),
    "terminal_corpus": profile(
        "terminal_trace_to_planner",
        ("planner", "sub_planner"),
        "silver",
        ("terminal", "code", "files"),
        ("strong shell-command supervision",),
        ("terminal-only distribution can dominate", "requires role/context gates"),
        0.7,
    ),
    "open_paws_llama": profile(
        "llama_tool_trace_to_planner",
        ("planner",),
        "bronze",
        ("general", "web", "knowledge"),
        ("open tool-use examples",),
        ("llama-format parsing can be lossy",),
        0.35,
    ),
    "chatml_text": profile(
        "chatml_to_planner",
        ("planner",),
        "bronze",
        ("general",),
        ("common chat format",),
        ("tool semantics must be inferred from text",),
        0.25,
    ),
    "noesis_text": profile(
        "noesis_text_to_planner",
        ("planner",),
        "bronze",
        ("general",),
        ("some reasoning/planning coverage",),
        ("tool call extraction is heuristic",),
        0.25,
    ),
    "reasoning_cot": profile(
        "reasoning_to_reply_quarantine",
        ("planner",),
        "quarantine",
        ("general",),
        ("can provide answer-quality warmup if explicitly enabled",),
        ("out of runtime distribution", "no native tools, actions, or evaluator labels"),
        0.0,
        include=False,
    ),
    "dialogue_raw": profile(
        "dialogue_to_message_handler",
        ("message_handler", "planner"),
        "bronze",
        ("general", "messaging"),
        ("dialogue/routing variety",),
        ("response routing is inferred", "no native tool schemas"),
        0.35,
    ),
    "harmful_behaviors": profile(
        "abliteration_quarantine",
        ("evaluator",),
        "quarantine",
        ("security",),
        ("useful for separate refusal/abliteration calibration",),
        ("must not enter main SFT mix",),
        0.0,
        include=False,
    ),
    "harmless_alpaca": profile(
        "abliteration_quarantine",
        ("planner",),
        "quarantine",
        ("general",),
        ("useful harmless side for separate calibration",),
        ("must not enter main SFT mix",),
        0.0,
        include=False,
    ),
    "n8n_workflow": profile(
        "n8n_workflow_to_automation_tool",
        ("planner", "sub_planner"),
        "quarantine",
        ("automation", "connectors"),
        ("valuable workflow JSON for a dedicated automation tool",),
        ("not a normal chat-loop output", "should become a tool result or separate fine-tune"),
        0.0,
        include=False,
    ),
}


def stable_hash(*parts: Any, length: int = 24) -> str:
    h = hashlib.sha256()
    for part in parts:
        h.update(json.dumps(part, sort_keys=True, ensure_ascii=False, default=str).encode("utf-8", "replace"))
        h.update(b"\x00")
    return h.hexdigest()[:length]


def load_registry(path: Path = DATASETS_FILE) -> list[dict[str, Any]]:
    payload = yaml.safe_load(path.read_text(encoding="utf-8"))
    return list(payload.get("datasets") or [])


def dir_size_bytes(path: Path) -> int:
    if not path.exists():
        return 0
    total = 0
    for p in path.rglob("*"):
        if p.is_file():
            try:
                total += p.stat().st_size
            except OSError:
                pass
    return total


def line_count(path: Path) -> int:
    if not path.exists():
        return 0
    n = 0
    with path.open("rb") as f:
        for _ in f:
            n += 1
    return n


def raw_status(entry: dict[str, Any]) -> str:
    slug = entry["slug"]
    if entry.get("local_path"):
        src = (ROOT / entry["local_path"]).resolve()
        if not src.exists():
            return "local_missing"
    d = RAW_DIR / slug
    if (d / ".done").exists():
        return "downloaded"
    if d.exists() and any(d.iterdir()):
        return "partial"
    return "not_downloaded"


def source_profile(entry: dict[str, Any]) -> TransformProfile:
    normalizer = entry.get("normalizer") or ""
    prof = TRANSFORM_PROFILES.get(normalizer)
    if prof:
        return prof
    return profile(
        "unknown_quarantine",
        ("planner",),
        "quarantine",
        ("general",),
        ("unclassified source may still contain usable examples",),
        (f"no native transform profile registered for normalizer {normalizer!r}",),
        0.0,
        include=False,
    )


def source_matrix(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for entry in entries:
        prof = source_profile(entry)
        slug = entry["slug"]
        norm_path = NORMALIZED_DIR / f"{slug}.jsonl"
        status = raw_status(entry)
        weaknesses = list(prof.weaknesses)
        if status == "local_missing":
            weaknesses.append("configured local_path is missing on this machine")
        elif status in {"not_downloaded", "partial"}:
            weaknesses.append(f"raw data status: {status}")
        if float(entry.get("weight", 1.0)) == 0:
            weaknesses.append("registry weight is 0; exclude from default SFT unless explicitly enabled")
        row = {
            "slug": slug,
            "repo_id": entry.get("repo_id"),
            "local_path": entry.get("local_path"),
            "normalizer": entry.get("normalizer"),
            "priority": entry.get("priority", "core"),
            "license": entry.get("license", "unknown"),
            "registry_weight": float(entry.get("weight", 1.0)),
            "estimated_size_gb": float(entry.get("est_size_gb", 0.0) or 0.0),
            "raw_status": status,
            "raw_size_gb": round(dir_size_bytes(RAW_DIR / slug) / (1024**3), 4),
            "normalized_records": line_count(norm_path),
            "transform": prof.transform,
            "target_stages": list(prof.target_stages),
            "contexts": list(prof.contexts),
            "quality_rating": prof.rating,
            "recommended_weight": prof.recommended_weight,
            "default_include": prof.default_include and status != "local_missing",
            "strengths": list(prof.strengths),
            "weaknesses": weaknesses,
        }
        rows.append(row)
    return rows


def write_matrix(rows: list[dict[str, Any]]) -> None:
    NATIVE_DIR.mkdir(parents=True, exist_ok=True)
    SOURCE_MATRIX_JSON.write_text(
        json.dumps({"schema": "eliza.native_tool_calling.source_matrix.v1", "sources": rows}, indent=2),
        encoding="utf-8",
    )

    headers = [
        "slug",
        "priority",
        "raw",
        "normalizer",
        "transform",
        "stages",
        "rating",
        "weight",
        "strengths",
        "weaknesses",
    ]
    lines = [
        "# Native tool-calling source matrix",
        "",
        "Generated by `scripts/prepare_native_tool_calling_data.py --write-matrix`.",
        "",
        "| " + " | ".join(headers) + " |",
        "| " + " | ".join("---" for _ in headers) + " |",
    ]
    for row in rows:
        values = [
            row["slug"],
            row["priority"],
            row["raw_status"],
            row["normalizer"] or "",
            row["transform"],
            ", ".join(row["target_stages"]),
            row["quality_rating"],
            str(row["recommended_weight"]),
            "; ".join(row["strengths"])[:180],
            "; ".join(row["weaknesses"])[:240],
        ]
        safe = [str(v).replace("|", "\\|").replace("\n", " ") for v in values]
        lines.append("| " + " | ".join(safe) + " |")
    SOURCE_MATRIX_MD.write_text("\n".join(lines) + "\n", encoding="utf-8")
    log.info("wrote %s and %s", SOURCE_MATRIX_JSON, SOURCE_MATRIX_MD)


def _message_role(role: str) -> str:
    role = (role or "user").lower()
    if role in {"assistant", "user", "system", "tool"}:
        return role
    if role in {"tool_output", "function", "observation"}:
        return "tool"
    if role in {"developer"}:
        return "developer"
    return "user"


def messages_from_eliza(record: dict[str, Any]) -> list[dict[str, str]]:
    messages: list[dict[str, str]] = []
    md = record.get("metadata") or {}
    system_prompt = md.get("system_prompt")
    if isinstance(system_prompt, str) and system_prompt.strip():
        messages.append({"role": "system", "content": system_prompt.strip()})
    for item in record.get("memoryEntries") or []:
        if not isinstance(item, dict):
            continue
        content = item.get("content")
        if not isinstance(content, str):
            continue
        messages.append({"role": _message_role(str(item.get("role") or "user")), "content": content})
    cm = record.get("currentMessage") or {}
    content = cm.get("content")
    if isinstance(content, str) and content.strip():
        messages.append({"role": "user", "content": content})
    return messages


def normalize_json_schema(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        if raw.get("type") == "object":
            return raw
        if "properties" in raw:
            return {"type": "object", **raw}
    if isinstance(raw, list):
        props: dict[str, Any] = {}
        required: list[str] = []
        for p in raw:
            if not isinstance(p, dict):
                continue
            name = p.get("name")
            if not isinstance(name, str) or not name:
                continue
            props[name] = {
                "type": p.get("type") if isinstance(p.get("type"), str) else "string",
                "description": p.get("description") if isinstance(p.get("description"), str) else "",
            }
            if p.get("required"):
                required.append(name)
        return {
            "type": "object",
            "properties": props,
            "required": required,
            "additionalProperties": True,
        }
    return {"type": "object", "properties": {}, "additionalProperties": True}


def tool_definition(name: str, description: str = "", parameters: Any = None) -> dict[str, Any]:
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": description or "",
            "parameters": normalize_json_schema(parameters),
        },
    }


def tools_from_eliza(record: dict[str, Any], calls: list[dict[str, Any]] | None = None) -> list[dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for terminal in ("REPLY", "IGNORE", "STOP"):
        if terminal == "REPLY":
            params = {
                "type": "object",
                "properties": {"text": {"type": "string"}},
                "required": ["text"],
                "additionalProperties": False,
            }
        else:
            params = {
                "type": "object",
                "properties": {"reason": {"type": "string"}},
                "additionalProperties": False,
            }
        out[terminal] = tool_definition(terminal, f"Terminal {terminal.lower()} decision.", params)

    md = record.get("metadata") or {}
    for spec in md.get("toolSpecs") or []:
        if not isinstance(spec, dict):
            continue
        name = spec.get("name")
        if isinstance(name, str) and name.strip():
            out[name] = tool_definition(name, spec.get("description") or "", spec.get("parameters"))

    for action in record.get("availableActions") or []:
        if isinstance(action, str):
            name = action
            desc = ""
            params = None
        elif isinstance(action, dict):
            name = action.get("name")
            desc = action.get("description") or ""
            params = action.get("parameters")
        else:
            continue
        if not isinstance(name, str) or not name.strip():
            continue
        if name in {"RESPOND"}:
            continue
        if name == "TASK_CALL":
            continue
        out.setdefault(name, tool_definition(name, desc, params))

    for call in calls or []:
        name = call.get("name")
        if isinstance(name, str) and name and name not in out:
            out[name] = tool_definition(name)

    return [out[k] for k in sorted(out)]


def decode_expected(raw: str, _decoder: Any | None = None) -> tuple[Any, str, str | None]:
    text = (raw or "").strip()
    if not text:
        return {}, "inferred", "empty expectedResponse"
    if text.startswith("{") or text.startswith("["):
        try:
            return json.loads(text), "native_direct", None
        except json.JSONDecodeError:
            return {"text": text}, "inferred", "JSON decode failed"
    return {"text": text}, "legacy_non_json", "non-JSON legacy expectedResponse"


def ensure_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def action_entries(actions: Any) -> list[dict[str, Any]]:
    if isinstance(actions, list):
        return [a for a in actions if isinstance(a, dict)]
    if isinstance(actions, dict):
        if not actions:
            return []
        return [actions]
    if isinstance(actions, str):
        entries = []
        for name in next(csv.reader([actions])):
            name = name.strip()
            if name:
                entries.append({"name": name, "params": {}})
        return entries
    return []


def tool_calls_from_decoded(decoded: Any, record: dict[str, Any], record_id: str) -> list[dict[str, Any]]:
    obj = ensure_dict(decoded)
    calls: list[dict[str, Any]] = []

    if isinstance(obj.get("tool_calls"), list):
        for idx, call in enumerate(obj["tool_calls"]):
            if not isinstance(call, dict):
                continue
            name = call.get("name")
            args = call.get("arguments") or call.get("args") or {}
            if isinstance(name, str) and name:
                if name == "SHELL_COMMAND":
                    name = "SHELL"
                calls.append({
                    "id": f"call_{stable_hash(record_id, idx, name, length=16)}",
                    "name": name,
                    "args": args if isinstance(args, dict) else {"value": args},
                    "status": "queued",
                })

    for idx, action in enumerate(action_entries(obj.get("actions"))):
        name = action.get("name")
        if not isinstance(name, str) or not name:
            continue
        if name == "SHELL_COMMAND":
            name = "SHELL"
        params = action.get("params") if isinstance(action.get("params"), dict) else {}
        if name == "TASK_CALL":
            tool_name = params.get("tool") or params.get("name") or params.get("action")
            args = params.get("arguments") or params.get("args") or params.get("params") or {}
            if isinstance(tool_name, str) and tool_name:
                name = tool_name
                params = args if isinstance(args, dict) else {"value": args}
        elif name == "REPLY":
            text = params.get("text") or obj.get("text") or ""
            params = {"text": text} if text else {}
        elif name in {"IGNORE", "STOP"}:
            params = {"reason": obj.get("thought") or obj.get("reasoning") or ""}
        calls.append({
            "id": f"call_{stable_hash(record_id, idx, name, params, length=16)}",
            "name": name,
            "args": params,
            "status": "queued",
        })

    if not calls and isinstance(obj.get("command"), str) and obj.get("command"):
        calls.append({
            "id": f"call_{stable_hash(record_id, 'shell', obj.get('command'), length=16)}",
            "name": "SHELL",
            "args": {
                "command": obj.get("command"),
                "cwd": obj.get("cwd") or "",
                "explanation": obj.get("explanation") or "",
            },
            "status": "queued",
        })

    if not calls:
        text = obj.get("text") if isinstance(obj.get("text"), str) else record.get("expectedResponse")
        if isinstance(text, str) and text.strip():
            calls.append({
                "id": f"call_{stable_hash(record_id, 'reply', text[:200], length=16)}",
                "name": "REPLY",
                "args": {"text": text.strip()},
                "status": "queued",
            })
    return calls


def contexts_from_decoded(decoded: Any, prof: TransformProfile) -> list[str]:
    obj = ensure_dict(decoded)
    contexts: list[str] = []
    primary = obj.get("primaryContext")
    if isinstance(primary, str) and primary.strip():
        contexts.append(primary.strip())
    secondary = obj.get("secondaryContexts")
    if isinstance(secondary, list):
        contexts.extend(str(v).strip() for v in secondary if str(v).strip())
    elif isinstance(secondary, str):
        contexts.extend(s.strip() for s in secondary.split(",") if s.strip())
    if not contexts:
        contexts.extend(prof.contexts)
    seen: set[str] = set()
    out: list[str] = []
    for c in contexts:
        if c not in seen:
            seen.add(c)
            out.append(c)
    return out


def split_from_record(record: dict[str, Any]) -> str:
    md = record.get("metadata") or {}
    split = str(md.get("split") or "train")
    return "validation" if split == "val" else split


def source_info(
    record: dict[str, Any],
    entry: dict[str, Any],
    conversion: str,
) -> dict[str, Any]:
    md = record.get("metadata") or {}
    original = md.get("original_id") or md.get("id") or md.get("conversation_id")
    return {
        "dataset": entry["slug"],
        "normalizer": entry.get("normalizer") or "",
        "license": str(md.get("license") or entry.get("license") or "unknown"),
        "split": split_from_record(record),
        "originalId": str(original) if original is not None else stable_hash(record.get("roomName"), record.get("currentMessage")),
        "conversion": conversion,
    }


def quality_info(
    prof: TransformProfile,
    *,
    extra_weaknesses: Iterable[str] = (),
    force_review: bool = False,
) -> dict[str, Any]:
    weaknesses = list(prof.weaknesses)
    weaknesses.extend(w for w in extra_weaknesses if w)
    rating = prof.rating
    if any("decode failed" in w.lower() for w in weaknesses):
        rating = "quarantine"
    return {
        "rating": rating,
        "strengths": list(prof.strengths),
        "weaknesses": weaknesses,
        "recommendedWeight": 0.0 if rating == "quarantine" else prof.recommended_weight,
        "requiresReview": force_review or rating in {"bronze", "quarantine"},
    }


def message_handler_output(decoded: Any, record: dict[str, Any], prof: TransformProfile) -> dict[str, Any]:
    obj = ensure_dict(decoded)
    action = obj.get("action") if isinstance(obj.get("action"), str) else "RESPOND"
    if action not in {"RESPOND", "IGNORE", "STOP"}:
        action = "RESPOND"
    contexts = contexts_from_decoded(obj, prof)
    reply = obj.get("reply") or obj.get("text")
    simple = bool(obj.get("simple")) if isinstance(obj.get("simple"), bool) else not contexts
    thought = obj.get("thought") or obj.get("reasoning") or ""
    result = {
        "action": action,
        "simple": simple,
        "contexts": contexts,
        "thought": str(thought),
    }
    if isinstance(reply, str) and reply.strip() and not contexts:
        result["reply"] = reply.strip()
    return {"messageHandler": result}


def planner_output(decoded: Any, record: dict[str, Any], record_id: str) -> dict[str, Any]:
    obj = ensure_dict(decoded)
    calls = tool_calls_from_decoded(obj, record, record_id)
    text = obj.get("text") if isinstance(obj.get("text"), str) else ""
    finish = "tool_calls" if calls else "stop"
    return {
        "planner": {
            "text": text,
            "toolCalls": calls,
            "finishReason": finish,
        }
    }


def evaluator_output(decoded: Any, record: dict[str, Any]) -> dict[str, Any]:
    obj = ensure_dict(decoded)
    thought = obj.get("thought") or obj.get("reasoning") or obj.get("task_completion_reason") or ""
    success_raw = obj.get("success")
    if not isinstance(success_raw, bool):
        if isinstance(obj.get("task_completed"), bool):
            success_raw = obj["task_completed"]
        elif isinstance(obj.get("quality_score"), (int, float)):
            success_raw = obj["quality_score"] >= 70
        else:
            success_raw = True
    decision = obj.get("decision")
    if decision not in {"FINISH", "NEXT_RECOMMENDED", "CONTINUE"}:
        decision = "FINISH" if success_raw else "CONTINUE"
    result: dict[str, Any] = {
        "success": bool(success_raw),
        "decision": decision,
        "thought": str(thought),
    }
    message = obj.get("messageToUser") or obj.get("text") or obj.get("response")
    if isinstance(message, str) and message.strip():
        result["messageToUser"] = message.strip()
    return {"evaluation": result}


def infer_stage(task_type: str | None, prof: TransformProfile) -> str:
    phase = classify_phase(task_type)
    if phase == "1":
        return "message_handler"
    if phase == "3":
        return "sub_planner"
    if phase == "4":
        return "evaluator"
    if "trajectory" in prof.target_stages and task_type == "agent_trace":
        return "planner"
    return "planner"


def native_record_from_eliza(
    record: dict[str, Any],
    entry: dict[str, Any],
    decoder: Any | None,
) -> tuple[dict[str, Any] | None, str | None]:
    prof = source_profile(entry)
    md = record.get("metadata") or {}
    task_type = md.get("task_type")
    decoded, conversion, decode_warning = decode_expected(str(record.get("expectedResponse") or ""), decoder)
    stage = infer_stage(task_type, prof)
    if conversion == "legacy_non_json" and stage != "planner":
        return None, "legacy non-JSON expectedResponse skipped; regenerate normalized rows as JSON"
    if conversion == "legacy_non_json" and task_type not in {"reply", "claude_distill"}:
        return None, "legacy non-JSON structured expectedResponse skipped; regenerate normalized rows as JSON"
    record_id = stable_hash(entry["slug"], md.get("original_id"), record.get("roomName"), record.get("currentMessage"), record.get("expectedResponse"))
    contexts = contexts_from_decoded(decoded, prof)
    messages = messages_from_eliza(record)

    if stage == "message_handler":
        output = message_handler_output(decoded, record, prof)
        calls: list[dict[str, Any]] = []
    elif stage == "evaluator":
        output = evaluator_output(decoded, record)
        calls = []
    else:
        output = planner_output(decoded, record, record_id)
        calls = output["planner"]["toolCalls"]

    if stage == "sub_planner":
        parent_name = str(task_type or "ACTION").upper()
        input_obj = {
            "legacyTaskType": task_type,
            "parentToolCall": {
                "id": f"call_parent_{stable_hash(record_id, parent_name, length=10)}",
                "name": parent_name,
                "args": {},
            },
            "allowedToolNames": sorted({c["name"] for c in calls} | TERMINAL_TOOLS),
        }
    else:
        input_obj = {
            "legacyTaskType": task_type,
            "contextObject": {},
            "plannedQueue": [],
            "events": [],
        }

    extra_weaknesses = []
    if decode_warning:
        extra_weaknesses.append(decode_warning)
    if conversion != "native_direct":
        extra_weaknesses.append("converted through legacy compatibility path")
    if classify_phase(task_type) == PHASE_OOB:
        extra_weaknesses.append("legacy task_type is out of runtime phase mapping")

    native = {
        "schema": SCHEMA_VERSION,
        "id": record_id,
        "stage": stage,
        "source": source_info(record, entry, conversion),
        "messages": messages,
        "contexts": contexts,
        "tools": tools_from_eliza(record, calls),
        "input": input_obj,
        "output": output,
        "quality": quality_info(prof, extra_weaknesses=extra_weaknesses),
    }
    ok, why = validate_native_record(native)
    if not ok:
        return None, why
    return native, None


def validate_native_record(rec: dict[str, Any]) -> tuple[bool, str]:
    if rec.get("schema") != SCHEMA_VERSION:
        return False, "bad schema"
    stage = rec.get("stage")
    if stage not in {"message_handler", "planner", "sub_planner", "evaluator", "trajectory"}:
        return False, "bad stage"
    source = rec.get("source")
    if not isinstance(source, dict) or not source.get("dataset") or not source.get("split"):
        return False, "missing source"
    quality = rec.get("quality")
    if not isinstance(quality, dict) or quality.get("rating") not in {"gold", "silver", "bronze", "quarantine"}:
        return False, "missing quality"
    if stage != "trajectory" and not rec.get("messages"):
        return False, "missing messages"
    output = rec.get("output")
    if not isinstance(output, dict):
        return False, "missing output"
    if stage == "message_handler":
        mh = output.get("messageHandler")
        if not isinstance(mh, dict):
            return False, "missing messageHandler output"
        if mh.get("action") not in {"RESPOND", "IGNORE", "STOP"}:
            return False, "bad messageHandler action"
        if not isinstance(mh.get("contexts"), list):
            return False, "bad messageHandler contexts"
    elif stage in {"planner", "sub_planner"}:
        planner = output.get("planner")
        if not isinstance(planner, dict):
            return False, "missing planner output"
        calls = planner.get("toolCalls")
        if not isinstance(calls, list):
            return False, "bad planner toolCalls"
        for call in calls:
            if not isinstance(call, dict) or not call.get("name") or not isinstance(call.get("args"), dict):
                return False, "bad planner toolCall"
    elif stage == "evaluator":
        ev = output.get("evaluation")
        if not isinstance(ev, dict):
            return False, "missing evaluation output"
        if ev.get("decision") not in {"FINISH", "NEXT_RECOMMENDED", "CONTINUE"}:
            return False, "bad evaluator decision"
    elif stage == "trajectory":
        traj = output.get("trajectory")
        if not isinstance(traj, dict) or traj.get("contextObjectVersion") != 5:
            return False, "bad trajectory output"
    return True, ""


def stream_jsonl(path: Path):
    with path.open("r", encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue


def transform_normalized(
    entries: list[dict[str, Any]],
    *,
    only: set[str],
    max_records_per_source: int | None,
    include_quarantine: bool,
) -> dict[str, Any]:
    NATIVE_RECORDS_DIR.mkdir(parents=True, exist_ok=True)
    NATIVE_ERRORS_DIR.mkdir(parents=True, exist_ok=True)
    decoder = None
    manifest: dict[str, Any] = {"schema": "eliza.native_tool_calling.transform_manifest.v1", "sources": []}
    totals = {"in": 0, "out": 0, "errors": 0, "skipped": 0}

    try:
        for entry in entries:
            slug = entry["slug"]
            if only and slug not in only:
                continue
            prof = source_profile(entry)
            if prof.rating == "quarantine" and not include_quarantine:
                totals["skipped"] += 1
                manifest["sources"].append({
                    "slug": slug,
                    "status": "skipped_quarantine",
                    "transform": prof.transform,
                })
                continue
            src = NORMALIZED_DIR / f"{slug}.jsonl"
            if not src.exists():
                manifest["sources"].append({"slug": slug, "status": "missing_normalized"})
                continue
            dst = NATIVE_RECORDS_DIR / f"{slug}.jsonl"
            err_path = NATIVE_ERRORS_DIR / f"{slug}.errors.jsonl"
            n_in = n_out = n_err = 0
            with dst.open("w", encoding="utf-8") as out, err_path.open("w", encoding="utf-8") as err:
                for rec in stream_jsonl(src):
                    n_in += 1
                    native, why = native_record_from_eliza(rec, entry, decoder)
                    if native is None:
                        n_err += 1
                        err.write(json.dumps({"reason": why, "record": rec}, ensure_ascii=False) + "\n")
                    else:
                        out.write(json.dumps(native, ensure_ascii=False, separators=(",", ":")) + "\n")
                        n_out += 1
                    if max_records_per_source and n_in >= max_records_per_source:
                        break
            totals["in"] += n_in
            totals["out"] += n_out
            totals["errors"] += n_err
            manifest["sources"].append({
                "slug": slug,
                "status": "ok",
                "in": n_in,
                "out": n_out,
                "errors": n_err,
                "transform": prof.transform,
            })
            log.info("native %-35s in=%d out=%d errors=%d", slug, n_in, n_out, n_err)
    finally:
        if decoder is not None:
            decoder.close()

    manifest["totals"] = totals
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    log.info("wrote native transform manifest %s", MANIFEST_PATH)
    return manifest


def validate_native_dir(paths: list[Path]) -> int:
    total = errors = 0
    for path in paths:
        for rec in stream_jsonl(path):
            total += 1
            ok, why = validate_native_record(rec)
            if not ok:
                errors += 1
                if errors <= 20:
                    log.error("%s: %s", path, why)
    log.info("validated %d native records, errors=%d", total, errors)
    return 0 if errors == 0 else 1


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--registry", type=Path, default=DATASETS_FILE)
    ap.add_argument("--write-matrix", action="store_true", help="write data/native/source_matrix outputs")
    ap.add_argument("--transform-normalized", action="store_true", help="convert data/normalized/*.jsonl to data/native/records")
    ap.add_argument("--validate-native", action="store_true", help="validate data/native/records/*.jsonl")
    ap.add_argument("--only", type=str, default="", help="comma-separated source slugs")
    ap.add_argument("--max-records-per-source", type=int, default=None)
    ap.add_argument("--include-quarantine", action="store_true", help="include quarantine-rated sources in transform output")
    args = ap.parse_args()

    entries = load_registry(args.registry)
    only = {s.strip() for s in args.only.split(",") if s.strip()}
    if only:
        entries = [e for e in entries if e["slug"] in only]
    if not entries:
        log.warning("no registry entries selected")
        return 0

    did_work = False
    if args.write_matrix or not (args.transform_normalized or args.validate_native):
        write_matrix(source_matrix(entries))
        did_work = True
    if args.transform_normalized:
        transform_normalized(
            entries,
            only=only,
            max_records_per_source=args.max_records_per_source,
            include_quarantine=args.include_quarantine,
        )
        did_work = True
    if args.validate_native:
        paths = sorted(NATIVE_RECORDS_DIR.glob("*.jsonl"))
        if only:
            paths = [p for p in paths if p.stem in only]
        return validate_native_dir(paths)
    return 0 if did_work else 0


if __name__ == "__main__":
    raise SystemExit(main())
