#!/usr/bin/env python3
"""Synthesize and evaluate Eliza-native fill-ins for sampled datasets.

This script uses sampled source rows plus the latest recorded Eliza native
trajectories to ask a fast teacher model for missing native boundary data. The
target output is still the final training format: `eliza_native_v1`, one Vercel
AI SDK model boundary per row.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import os
import re
import statistics
import sys
import time
import urllib.error
import urllib.request
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


SCRIPT_PATH = Path(__file__).resolve()
TRAINING_ROOT = SCRIPT_PATH.parents[1]
REPO_ROOT = SCRIPT_PATH.parents[3]
AUDIT_DIR = TRAINING_ROOT / "data" / "native" / "audit"
FILLINS_DIR = TRAINING_ROOT / "data" / "native" / "fillins"

DEFAULT_MODEL = "gpt-oss-120b"
DEFAULT_BASE_URL = "https://api.cerebras.ai/v1"
ALLOWED_TASK_TYPES = {"should_respond", "action_planner", "evaluator", "response"}
NATIVE_BOUNDARIES = {"vercel_ai_sdk.generateText", "vercel_ai_sdk.streamText"}
FORBIDDEN_OUTPUT_TOKENS = (
    "gemini",
    "toon",
    "trajectory_harness_v1",
    "harness_v1",
    "eliza.native_tool_calling.v1",
    "assistant is a large language model trained by openai",
    "you are chatgpt",
)
CONTEXTS = [
    "simple",
    "general",
    "memory",
    "knowledge",
    "web",
    "browser",
    "code",
    "files",
    "terminal",
    "email",
    "calendar",
    "contacts",
    "tasks",
    "health",
    "screen_time",
    "subscriptions",
    "finance",
    "payments",
    "wallet",
    "crypto",
    "messaging",
    "social_posting",
    "media",
    "automation",
    "connectors",
    "settings",
    "secrets",
    "admin",
    "agent_internal",
]
STOPWORDS = {
    "about",
    "above",
    "after",
    "again",
    "assistant",
    "before",
    "being",
    "could",
    "every",
    "final",
    "first",
    "format",
    "given",
    "human",
    "large",
    "message",
    "model",
    "original",
    "please",
    "question",
    "response",
    "should",
    "source",
    "system",
    "their",
    "there",
    "these",
    "thing",
    "tools",
    "trained",
    "using",
    "value",
    "where",
    "which",
    "would",
}

MESSAGE_HANDLER_TOOL = {
    "type": "function",
    "name": "MESSAGE_HANDLER_PLAN",
    "description": (
        "Return the Stage 1 routing plan for the current message. This tool is "
        "internal; do not use plain text for this stage."
    ),
    "parameters": {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "plan": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "contexts": {"type": "array", "items": {"type": "string"}},
                    "reply": {"type": "string"},
                },
                "required": ["contexts"],
            },
            "thought": {"type": "string"},
        },
        "required": ["plan", "thought"],
    },
    "strict": True,
}


def load_dotenv(path: Path) -> None:
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export ") :].strip()
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if not key or key in os.environ:
            continue
        if (value.startswith('"') and value.endswith('"')) or (
            value.startswith("'") and value.endswith("'")
        ):
            value = value[1:-1]
        os.environ[key] = value


def json_dump(value: Any, *, max_chars: int | None = None) -> str:
    text = json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2)
    if max_chars is not None and len(text) > max_chars:
        return text[: max_chars - 32] + "\n...<truncated>"
    return text


def compact_value(value: Any, *, string_limit: int = 1400, depth: int = 5) -> Any:
    if depth <= 0:
        return "...<truncated>"
    if isinstance(value, str):
        if len(value) > string_limit:
            return value[: string_limit - 16] + "...<truncated>"
        return value
    if isinstance(value, list):
        items = [compact_value(item, string_limit=string_limit, depth=depth - 1) for item in value[:8]]
        if len(value) > 8:
            items.append(f"...<{len(value) - 8} more>")
        return items
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for index, (key, item) in enumerate(value.items()):
            if index >= 20:
                out["..."] = f"<{len(value) - index} more keys>"
                break
            out[str(key)] = compact_value(item, string_limit=string_limit, depth=depth - 1)
        return out
    return value


def stable_id(*parts: Any, length: int = 10) -> str:
    h = hashlib.sha256()
    for part in parts:
        h.update(json.dumps(part, ensure_ascii=False, sort_keys=True, default=str).encode("utf-8"))
        h.update(b"\0")
    return h.hexdigest()[:length]


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    if not path.exists():
        return rows
    with path.open("r", encoding="utf-8") as f:
        for line_no, line in enumerate(f, start=1):
            line = line.strip()
            if not line:
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError as exc:
                raise SystemExit(f"invalid JSONL in {path}:{line_no}: {exc}") from exc
            if isinstance(value, dict):
                rows.append(value)
    return rows


def write_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")))
            f.write("\n")


def load_templates(path: Path) -> tuple[dict[str, dict[str, Any]], dict[str, Any]]:
    if not path.exists():
        return {}, {}
    data = json.loads(path.read_text(encoding="utf-8"))
    dataset_info = {
        item["dataset"]: item
        for item in data.get("datasets", [])
        if isinstance(item, dict) and isinstance(item.get("dataset"), str)
    }
    return dataset_info, data.get("templates", {})


def extract_reference_rows(path: Path) -> dict[str, dict[str, Any]]:
    examples: dict[str, dict[str, Any]] = {}
    for row in read_jsonl(path):
        metadata = row.get("metadata") if isinstance(row.get("metadata"), dict) else {}
        task_type = metadata.get("task_type") or infer_task_from_row(row)
        if task_type in examples:
            continue
        request = row.get("request") if isinstance(row.get("request"), dict) else {}
        response = row.get("response") if isinstance(row.get("response"), dict) else {}
        example = {
            "task_type": task_type,
            "purpose": row.get("purpose"),
            "stepType": row.get("stepType"),
            "request_keys": sorted(request.keys()),
            "response_keys": sorted(response.keys()),
            "request": compact_value(request, string_limit=900, depth=4),
            "response": compact_value(response, string_limit=900, depth=4),
        }
        examples[str(task_type)] = example
    return examples


def infer_task_from_row(row: dict[str, Any]) -> str:
    metadata = row.get("metadata") if isinstance(row.get("metadata"), dict) else {}
    task = metadata.get("task_type") or metadata.get("taskType")
    if isinstance(task, str) and task:
        return "response" if task == "reply" else task
    text = " ".join(
        str(row.get(key) or "")
        for key in ("purpose", "stepType", "modelType", "actionType")
    ).lower()
    if "message" in text or "response_handler" in text:
        return "should_respond"
    if "planner" in text or "action" in text:
        return "action_planner"
    if "eval" in text:
        return "evaluator"
    return "response"


def expected_task_types(sample: dict[str, Any], dataset_info: dict[str, Any]) -> list[str]:
    best = str(dataset_info.get("bestObservedStage") or "").lower()
    features = set(sample.get("features") or [])
    out: list[str] = []
    if best in {"message_handler", "messagehandler", "should_respond"}:
        out.append("should_respond")
    if best in {"planner", "action_planner"}:
        out.append("action_planner")
    if best in {"evaluator", "evaluation"}:
        out.append("evaluator")
    if "context_labels" in features or "chat_messages" in features or "current_user_message" in features:
        out.append("should_respond")
    if "tool_calls" in features or "tool_schemas" in features or "arguments_json" in features:
        out.append("action_planner")
    if "tool_results" in features or "evaluator_decision" in features or "success_label" in features:
        out.append("evaluator")
    if not out:
        out.append("should_respond")
    deduped: list[str] = []
    for item in out:
        if item not in deduped:
            deduped.append(item)
    return deduped[:3]


def build_dataset_prompt_template(
    dataset: str,
    sample: dict[str, Any],
    dataset_info: dict[str, Any],
    templates: dict[str, Any],
) -> str:
    template_ids = dataset_info.get("templateIds") or []
    selected_templates = {
        template_id: templates.get(template_id)
        for template_id in template_ids
        if template_id in templates
    }
    missing = dataset_info.get("missingCriticalSignals") or []
    coverage = dataset_info.get("nativeComponentCoverage") or {}
    expected = expected_task_types(sample, dataset_info)
    return "\n".join(
        [
            f"Dataset: {dataset}",
            f"Quality band from audit: {dataset_info.get('qualityRating', 'unknown')}",
            f"Recommended frame: {dataset_info.get('recommendedFrame', 'infer from sample')}",
            f"Expected task rows: {', '.join(expected)}",
            f"Missing signals to fill: {', '.join(missing) if missing else 'none'}",
            f"Native coverage: {json.dumps(coverage, ensure_ascii=False, sort_keys=True)}",
            "Synthesis templates:",
            json_dump(selected_templates, max_chars=2200),
        ]
    )


def build_generation_prompt(
    *,
    sample: dict[str, Any],
    dataset_info: dict[str, Any],
    templates: dict[str, Any],
    reference_rows: dict[str, Any],
    iteration: int,
    previous: dict[str, Any] | None,
    previous_eval: dict[str, Any] | None,
) -> str:
    dataset = str(sample.get("dataset"))
    expected = expected_task_types(sample, dataset_info)
    dataset_template = build_dataset_prompt_template(dataset, sample, dataset_info, templates)
    source_preview = compact_value(sample.get("preview"), string_limit=1800, depth=5)
    source_payload = {
        "dataset": dataset,
        "sampleIndex": sample.get("sampleIndex"),
        "rowIndex": sample.get("rowIndex"),
        "normalizer": sample.get("normalizer"),
        "path": sample.get("path"),
        "features": sample.get("features"),
        "nativeBoundaryComponents": sample.get("nativeBoundaryComponents"),
        "stageSimilarity": sample.get("stageSimilarity"),
        "preview": source_preview,
    }
    repair_block = ""
    if previous is not None or previous_eval is not None:
        repair_block = "\n".join(
            [
                "\nPrevious attempt needs repair.",
                "Checker result:",
                json_dump(previous_eval or {}, max_chars=3000),
                "Previous output:",
                json_dump(compact_value(previous or {}, string_limit=900, depth=5), max_chars=4500),
            ]
        )
    return f"""You are filling missing training data for Eliza's final native model-boundary format.

Return only one valid JSON object. No Markdown, no comments, no prose outside JSON.

Final target:
- Output candidate rows in `eliza_native_v1` only.
- Each candidate row is one Vercel AI SDK model boundary: request messages/prompt/tools/toolChoice in, response text/toolCalls/finishReason out.
- Boundary must be `vercel_ai_sdk.generateText` unless the sample explicitly requires streamText.
- Tool calling must use native function/tool-call structures compatible with OpenAI, Anthropic, and Cerebras through the Vercel AI SDK. Use `request.tools` entries with `type`, `name`, `description`, and `parameters`; use `response.toolCalls` entries with `id`, `name`, and `args`.
- Eliza only. Do not mention or emit Gemini, TOON, trajectory_harness_v1, harness_v1, or any alternate trajectory format.
- Do not synthesize provider token counts, providerMetadata, cacheStats, request ids, latency, or cost. Leave those fields absent unless they are directly present in the source sample.
- Preserve source facts. Clearly mark inferred fields in metadata and `fillins`.
- If a source row is weak or unrelated, create the minimal Eliza-native boundary that teaches the missing behavior without pretending it was observed.

Comparable latest Eliza rows have these task types:
1. should_respond/messageHandler: request has system+user messages, toolChoice `required`, MESSAGE_HANDLER_PLAN tool, and response.toolCalls with selected contexts and optional reply.
2. action_planner/planner: request has selected contexts and available tools, toolChoice `auto` or `required`, and response.toolCalls with function name and JSON args.
3. evaluator/evaluation: request has prior plan/tool results and response.text is a compact JSON decision such as FINISH, CONTINUE, or NEXT_RECOMMENDED.

Eliza runtime scaffolding requirements:
- Do not copy generic source boilerplate such as "Assistant is a large language model trained by OpenAI" into a native row.
- The system/user messages must be reframed as Eliza runtime prompts while preserving the source user's task and any observed tool facts.
- messageHandler rows must include `context_registry_digest` and `message_handler_stage`.
- planner rows must include `context_registry_digest`, `selected_contexts`, and tool descriptions.
- evaluator rows must include the prior plan/tool result context and an evaluation task.

Available Eliza contexts:
{", ".join(CONTEXTS)}

Canonical MESSAGE_HANDLER_PLAN tool:
{json_dump(MESSAGE_HANDLER_TOOL, max_chars=2500)}

Real Eliza reference snippets:
{json_dump(reference_rows, max_chars=3600)}

Dataset-specific prompt template:
{dataset_template}

Source sample:
{json_dump(source_payload, max_chars=4600)}

Expected task rows for this sample: {", ".join(expected)}.

Required output schema:
{{
  "format": "eliza_native_fillin_v1",
  "dataset": "{dataset}",
  "sampleIndex": {json.dumps(sample.get("sampleIndex"))},
  "iteration": {iteration},
  "sourceUse": "short description of how the source sample was used",
  "fillins": {{
    "contexts": {{"value": ["context"], "source": "source|inferred|not_applicable", "reason": "short"}},
    "tools": {{"value": [], "source": "source|inferred|not_applicable", "reason": "short"}},
    "toolCalls": {{"value": [], "source": "source|inferred|not_applicable", "reason": "short"}},
    "toolResults": {{"value": [], "source": "source|inferred|not_applicable", "reason": "short"}},
    "evaluator": {{"value": null, "source": "source|inferred|not_applicable", "reason": "short"}}
  }},
  "nativeRows": [
    {{
      "format": "eliza_native_v1",
      "schemaVersion": 1,
      "boundary": "vercel_ai_sdk.generateText",
      "source": "synthetic_dataset_fillin",
      "model": "gpt-oss-120b",
      "provider": "cerebras",
      "purpose": "messageHandler|planner|evaluation",
      "stepType": "messageHandler|planner|evaluation",
      "metadata": {{
        "task_type": "should_respond|action_planner|evaluator",
        "source_dataset": "{dataset}",
        "source_sample_index": {json.dumps(sample.get("sampleIndex"))},
        "source_row_index": {json.dumps(sample.get("rowIndex"))},
        "synthetic": true,
        "synthesis_model": "cerebras/gpt-oss-120b",
        "inferred_fields": ["field names"]
      }},
      "request": {{"messages": [{{"role": "system", "content": "..."}}, {{"role": "user", "content": "..."}}], "prompt": "...", "tools": [], "toolChoice": "auto|required"}},
      "response": {{"text": "...", "toolCalls": []}}
    }}
  ],
  "quality": {{
    "score": 0.0,
    "comparableToLatestEliza": true,
    "rationale": "short",
    "weaknesses": [],
    "needsSynthesis": []
  }}
}}

{repair_block}
"""


def call_cerebras(
    *,
    messages: list[dict[str, str]],
    model: str,
    base_url: str,
    api_key: str,
    timeout: int,
    temperature: float,
    response_format: bool,
    rate_limit_retries: int,
    rate_limit_sleep: float,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
    }
    if response_format:
        payload["response_format"] = {"type": "json_object"}
    last: dict[str, Any] | None = None
    for attempt in range(rate_limit_retries + 1):
        request = urllib.request.Request(
            f"{base_url.rstrip('/')}/chat/completions",
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
                "Accept": "application/json",
                "User-Agent": "OpenAI/Python 1.0.0",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")
            last = {"error": {"status": exc.code, "body": body}}
            if exc.code == 429 and attempt < rate_limit_retries:
                time.sleep(rate_limit_sleep * (attempt + 1))
                continue
            return last
        except Exception as exc:  # noqa: BLE001
            last = {"error": {"type": type(exc).__name__, "message": str(exc)}}
            return last
    return last or {"error": {"type": "unknown", "message": "request failed"}}


def strip_json_text(text: str) -> str:
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text).strip()
    start = text.find("{")
    end = text.rfind("}")
    if start >= 0 and end > start:
        return text[start : end + 1]
    return text


def parse_cerebras_json(response: dict[str, Any]) -> tuple[dict[str, Any] | None, str, str | None]:
    if "error" in response:
        return None, "", json.dumps(response["error"], ensure_ascii=False)
    choice = (response.get("choices") or [{}])[0]
    message = choice.get("message") or {}
    content = message.get("content") or ""
    if not isinstance(content, str):
        return None, "", "message.content was not a string"
    stripped = strip_json_text(content)
    try:
        parsed = json.loads(stripped)
    except json.JSONDecodeError as exc:
        return None, content, f"invalid JSON: {exc}"
    if not isinstance(parsed, dict):
        return None, content, "JSON root was not an object"
    return parsed, content, None


def is_nonempty_string(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def has_request_payload(request: dict[str, Any]) -> bool:
    messages = request.get("messages")
    if isinstance(messages, list) and messages:
        for message in messages:
            if isinstance(message, dict) and is_nonempty_string(message.get("role")):
                if message.get("content") is not None or message.get("parts") is not None:
                    return True
    return is_nonempty_string(request.get("prompt"))


def has_response_payload(response: dict[str, Any]) -> bool:
    if is_nonempty_string(response.get("text")):
        return True
    tool_calls = response.get("toolCalls")
    return isinstance(tool_calls, list) and len(tool_calls) > 0


def normalize_tool_call(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    name = raw.get("name") or raw.get("toolName")
    if not is_nonempty_string(name):
        function = raw.get("function") if isinstance(raw.get("function"), dict) else {}
        name = function.get("name")
    if not is_nonempty_string(name):
        return None
    args = raw.get("args") if "args" in raw else raw.get("input") if "input" in raw else raw.get("arguments")
    if args is None:
        function = raw.get("function") if isinstance(raw.get("function"), dict) else {}
        args = function.get("arguments")
    if isinstance(args, str):
        try:
            json.loads(args)
        except json.JSONDecodeError:
            return None
    elif args is not None and not isinstance(args, dict):
        return None
    return {"name": name, "args": args if args is not None else {}}


def request_text(request: dict[str, Any]) -> str:
    parts: list[str] = []
    for key in ("system", "prompt"):
        value = request.get(key)
        if isinstance(value, str):
            parts.append(value)
    messages = request.get("messages")
    if isinstance(messages, list):
        for message in messages:
            if isinstance(message, dict):
                content = message.get("content")
                if isinstance(content, str):
                    parts.append(content)
    return "\n".join(parts).lower()


def collect_text(value: Any, out: list[str]) -> None:
    if isinstance(value, str):
        out.append(value)
    elif isinstance(value, list):
        for item in value:
            collect_text(item, out)
    elif isinstance(value, dict):
        for item in value.values():
            collect_text(item, out)


def content_tokens(value: Any) -> set[str]:
    texts: list[str] = []
    collect_text(value, texts)
    joined = "\n".join(texts).lower()
    tokens = set(re.findall(r"[a-z0-9_][a-z0-9_'-]{3,}", joined))
    return {token for token in tokens if token not in STOPWORDS and not token.startswith("truncated")}


def text_fragments(value: Any) -> list[str]:
    fragments: list[str] = []
    collect_text(value, fragments)
    return [fragment.strip() for fragment in fragments if fragment.strip()]


def sanitize_task_text(text: str) -> str:
    replacements = {
        "Gemini": "a secondary AI model",
        "gemini": "a secondary AI model",
        "TOON": "native JSON",
        "toon": "native JSON",
    }
    out = text
    for source, target in replacements.items():
        out = out.replace(source, target)
    return out


def extract_source_task(sample: dict[str, Any], row: dict[str, Any] | None = None) -> str:
    fragments = text_fragments(sample.get("preview"))
    combined = "\n".join(fragments)
    action_inputs = re.findall(r'"action_input"\s*:\s*"([^"]{6,240})"', combined)
    actions = re.findall(r'"action"\s*:\s*"([^"]{3,120})"', combined)
    for action, action_input in zip(actions, action_inputs):
        if action.lower() not in {"final answer", "final_answer"}:
            return sanitize_task_text(action_input.strip())
    if action_inputs:
        return sanitize_task_text(action_inputs[0].strip())

    preview = sample.get("preview")
    if isinstance(preview, dict) and isinstance(preview.get("messages"), list):
        for message in reversed(preview["messages"]):
            if not isinstance(message, dict):
                continue
            role = str(message.get("role") or message.get("from") or "").lower()
            content = str(message.get("content") or message.get("value") or "").strip()
            if role in {"user", "human"} and content and not content.lstrip().startswith("TOOLS"):
                return sanitize_task_text(content[:600])

    if row:
        request = row.get("request") if isinstance(row.get("request"), dict) else {}
        messages = request.get("messages")
        if isinstance(messages, list):
            for message in reversed(messages):
                if isinstance(message, dict) and message.get("role") == "user":
                    content = str(message.get("content") or "").strip()
                    if content:
                        return sanitize_task_text(content[:600])
        prompt = request.get("prompt")
        if isinstance(prompt, str) and prompt.strip():
            return sanitize_task_text(prompt.strip()[:600])

    for fragment in fragments:
        if "_read_error" not in fragment and len(fragment) > 12:
            return sanitize_task_text(fragment[:600])
    return "Handle the current user request using the selected Eliza context."


def infer_contexts(sample: dict[str, Any], parsed: dict[str, Any], row: dict[str, Any]) -> list[str]:
    fillins = parsed.get("fillins") if isinstance(parsed.get("fillins"), dict) else {}
    context_value = fillins.get("contexts") if isinstance(fillins.get("contexts"), dict) else {}
    contexts = context_value.get("value")
    if isinstance(contexts, list):
        out = [str(item) for item in contexts if str(item) in CONTEXTS]
        if out:
            return out[:4]

    response = row.get("response") if isinstance(row.get("response"), dict) else {}
    for raw_call in response.get("toolCalls") or []:
        call = normalize_tool_call(raw_call)
        if not call or call["name"] != "MESSAGE_HANDLER_PLAN":
            continue
        args = call.get("args") if isinstance(call.get("args"), dict) else {}
        plan = args.get("plan") if isinstance(args.get("plan"), dict) else {}
        raw_contexts = plan.get("contexts")
        if isinstance(raw_contexts, list):
            out = [str(item) for item in raw_contexts if str(item) in CONTEXTS]
            if out:
                return out[:4]

    text = "\n".join(text_fragments(sample.get("preview"))).lower()
    if "vector search" in text or "knowledge" in text or "document" in text:
        return ["knowledge"]
    if "browser" in text or "tab" in text:
        return ["browser"]
    if "web search" in text or "latest" in text or "current" in text:
        return ["web"]
    return ["general"]


def context_registry() -> str:
    return ",".join(CONTEXTS)


def message_handler_system() -> str:
    registry = context_registry()
    return (
        "user_role: OWNER\n\n"
        "context-registry:\n"
        f"context_registry_digest: {registry}\n\n"
        "instruction:system:\n"
        f"available_contexts: {registry}\n\n"
        "context:\n"
        "message_handler_stage:\n"
        "task: Decide the plan for this direct message."
    )


def user_stage_message(task: str) -> str:
    task = sanitize_task_text(task)
    return (
        "provider:RECENT_MESSAGES:\n"
        "provider: RECENT_MESSAGES\n"
        "# Conversation Messages\n"
        f"SourceUser: {task}\n\n"
        "# Received Message\n"
        f"SourceUser: {task}\n\n"
        "message:user:\n"
        f"{task}"
    )


def normalize_tools(tools: Any, tool_calls: list[dict[str, Any]]) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    if isinstance(tools, list):
        for raw_tool in tools:
            if not isinstance(raw_tool, dict):
                continue
            name = raw_tool.get("name") or raw_tool.get("toolName")
            if not is_nonempty_string(name):
                continue
            parameters = raw_tool.get("parameters") or raw_tool.get("inputSchema")
            if not isinstance(parameters, dict):
                parameters = {"type": "object", "additionalProperties": True, "properties": {}}
            normalized.append(
                {
                    "type": raw_tool.get("type") or "function",
                    "name": str(name),
                    "description": str(raw_tool.get("description") or f"Eliza tool {name}."),
                    "parameters": parameters,
                    **({"strict": raw_tool["strict"]} if "strict" in raw_tool else {}),
                }
            )
    known = {tool["name"] for tool in normalized}
    for call in tool_calls:
        name = str(call.get("name") or "")
        if not name or name in known:
            continue
        normalized.append(
            {
                "type": "function",
                "name": name,
                "description": f"Execute the Eliza action `{name}`.",
                "parameters": {
                    "type": "object",
                    "additionalProperties": True,
                    "properties": {},
                },
            }
        )
        known.add(name)
    return normalized


def normalize_tool_calls(raw_calls: Any) -> list[dict[str, Any]]:
    calls: list[dict[str, Any]] = []
    if not isinstance(raw_calls, list):
        return calls
    for index, raw in enumerate(raw_calls):
        call = normalize_tool_call(raw)
        if not call:
            continue
        calls.append(
            {
                "id": str((raw.get("id") or raw.get("toolCallId") or f"call_{index + 1}") if isinstance(raw, dict) else f"call_{index + 1}"),
                "name": str(call["name"]),
                "args": call.get("args") if isinstance(call.get("args"), dict) else {},
            }
        )
    return calls


def planner_system(contexts: list[str], tools: list[dict[str, Any]]) -> str:
    tool_blocks = []
    for tool in tools:
        tool_blocks.append(
            "tool:\n"
            f"tool: {tool.get('name')}\n"
            f"description: {tool.get('description', '')}"
        )
    return (
        "user_role: OWNER\n\n"
        "context-registry:\n"
        f"context_registry_digest: {context_registry()}\n\n"
        "selected-contexts:\n"
        f"selected_contexts: {','.join(contexts)}\n\n"
        + "\n\n".join(tool_blocks)
        + "\n\nplanner_stage:\n"
        "task: Choose the next native tool call or final response."
    )


def evaluator_system(contexts: list[str]) -> str:
    return (
        "user_role: OWNER\n\n"
        "context-registry:\n"
        f"context_registry_digest: {context_registry()}\n\n"
        "selected-contexts:\n"
        f"selected_contexts: {','.join(contexts)}\n\n"
        "evaluation_stage:\n"
        "task: Evaluate whether the prior plan/tool result completed the user request."
    )


def canonicalize_output(
    parsed: dict[str, Any],
    *,
    sample: dict[str, Any],
    dataset_info: dict[str, Any],
) -> dict[str, Any]:
    rows = parsed.get("nativeRows")
    if not isinstance(rows, list):
        return parsed
    expected = expected_task_types(sample, dataset_info)
    for index, row in enumerate(rows):
        if not isinstance(row, dict):
            continue
        metadata = row.get("metadata") if isinstance(row.get("metadata"), dict) else {}
        task_type = metadata.get("task_type") or infer_task_from_row(row)
        if task_type not in ALLOWED_TASK_TYPES:
            task_type = expected[min(index, len(expected) - 1)] if expected else "response"
        contexts = infer_contexts(sample, parsed, row)
        task = extract_source_task(sample, row)
        request = row.get("request") if isinstance(row.get("request"), dict) else {}
        response = row.get("response") if isinstance(row.get("response"), dict) else {}
        tool_calls = normalize_tool_calls(response.get("toolCalls"))

        row["format"] = "eliza_native_v1"
        row["schemaVersion"] = 1
        row["boundary"] = row.get("boundary") if row.get("boundary") in NATIVE_BOUNDARIES else "vercel_ai_sdk.generateText"
        row["source"] = row.get("source") or "synthetic_dataset_fillin"
        row["model"] = row.get("model") or "gpt-oss-120b"
        row["provider"] = row.get("provider") or "cerebras"
        row.pop("cacheStats", None)
        row["metadata"] = {
            **metadata,
            "task_type": "response" if task_type == "reply" else task_type,
            "source_dataset": str(sample.get("dataset")),
            "source_sample_index": sample.get("sampleIndex"),
            "source_row_index": sample.get("rowIndex"),
            "synthetic": True,
            "synthesis_model": "cerebras/gpt-oss-120b",
        }
        inferred = row["metadata"].get("inferred_fields")
        if not isinstance(inferred, list):
            inferred = []
        for field in ("contexts", "request.messages"):
            if field not in inferred:
                inferred.append(field)
        row["metadata"]["inferred_fields"] = inferred

        if task_type == "should_respond":
            row["purpose"] = "messageHandler"
            row["stepType"] = "messageHandler"
            message_handler_call = None
            for call in tool_calls:
                if call["name"] == "MESSAGE_HANDLER_PLAN":
                    message_handler_call = call
                    break
            if not message_handler_call:
                message_handler_call = {
                    "id": "call_1",
                    "name": "MESSAGE_HANDLER_PLAN",
                    "args": {
                        "thought": "Route the source request to the inferred Eliza contexts.",
                        "plan": {"contexts": contexts},
                    },
                }
            args = message_handler_call.get("args") if isinstance(message_handler_call.get("args"), dict) else {}
            plan = args.get("plan") if isinstance(args.get("plan"), dict) else {}
            plan.setdefault("contexts", contexts)
            args["plan"] = plan
            args.setdefault("thought", "Route the source request to the inferred Eliza contexts.")
            message_handler_call["args"] = args
            row["request"] = {
                "messages": [
                    {"role": "system", "content": message_handler_system()},
                    {"role": "user", "content": user_stage_message(task)},
                ],
                "prompt": "",
                "toolChoice": "required",
                "tools": [MESSAGE_HANDLER_TOOL],
            }
            row["response"] = {
                "text": json.dumps(
                    {
                        "processMessage": "RESPOND",
                        "plan": plan,
                        "action": "RESPOND",
                        "contexts": plan.get("contexts", contexts),
                        "thought": args.get("thought"),
                        **({"reply": plan.get("reply")} if plan.get("reply") else {}),
                    },
                    ensure_ascii=False,
                    separators=(",", ":"),
                ),
                "toolCalls": [message_handler_call],
            }
            continue

        if task_type == "action_planner":
            row["purpose"] = "planner"
            row["stepType"] = "planner"
            tools = normalize_tools(request.get("tools"), tool_calls)
            row["request"] = {
                "messages": [
                    {"role": "system", "content": planner_system(contexts, tools)},
                    {"role": "user", "content": user_stage_message(task)},
                ],
                "prompt": "",
                "toolChoice": request.get("toolChoice") if request.get("toolChoice") in {"auto", "required"} else "auto",
                "tools": tools,
            }
            response.pop("usage", None)
            response.pop("providerMetadata", None)
            row["response"] = {
                "text": response.get("text") if isinstance(response.get("text"), str) else "",
                "finishReason": response.get("finishReason") or ("tool-calls" if tool_calls else "stop"),
                "toolCalls": tool_calls,
            }
            continue

        if task_type == "evaluator":
            row["purpose"] = "evaluation"
            row["stepType"] = "evaluation"
            row["request"] = {
                "messages": [
                    {"role": "system", "content": evaluator_system(contexts)},
                    {"role": "user", "content": user_stage_message(task)},
                ],
                "prompt": "",
            }
            response.pop("usage", None)
            response.pop("providerMetadata", None)
            text = response.get("text") if isinstance(response.get("text"), str) else ""
            if not text.strip():
                text = json.dumps(
                    {"decision": "FINISH", "success": True, "thought": "Synthetic evaluator fill-in."},
                    ensure_ascii=False,
                    separators=(",", ":"),
                )
            row["response"] = {"text": text}
    parsed["nativeRows"] = rows
    parsed["canonicalized"] = True
    return parsed


def strip_provider_reasoning(value: Any) -> Any:
    if isinstance(value, list):
        return [strip_provider_reasoning(item) for item in value]
    if isinstance(value, dict):
        return {
            str(key): strip_provider_reasoning(item)
            for key, item in value.items()
            if key not in {"reasoning", "reasoning_content"}
        }
    return value


def evaluate_output(
    parsed: dict[str, Any] | None,
    *,
    parse_error: str | None,
    sample: dict[str, Any],
    dataset_info: dict[str, Any],
    min_score: float,
) -> dict[str, Any]:
    issues: list[str] = []
    hard_failures: list[str] = []
    components = Counter()
    dataset = str(sample.get("dataset"))

    if parsed is None:
        return {
            "score": 0.0,
            "passed": False,
            "issues": [],
            "hardFailures": [parse_error or "missing parsed output"],
            "components": {},
        }

    if parsed.get("format") != "eliza_native_fillin_v1":
        hard_failures.append("top-level format must be eliza_native_fillin_v1")
    if parsed.get("dataset") != dataset:
        issues.append("top-level dataset does not match source dataset")
    if parsed.get("sampleIndex") != sample.get("sampleIndex"):
        issues.append("top-level sampleIndex does not match source sample")

    preview = sample.get("preview")
    if isinstance(preview, dict) and "_read_error" in preview:
        hard_failures.append("source preview has a read error; fix/resample dataset before fill-in")

    fillins = parsed.get("fillins")
    if not isinstance(fillins, dict):
        issues.append("missing fillins object")
    else:
        contexts = ((fillins.get("contexts") or {}) if isinstance(fillins.get("contexts"), dict) else {}).get("value")
        if isinstance(contexts, list) and contexts:
            components["contexts"] += 1
        else:
            issues.append("fillins.contexts.value is empty")

    rows = parsed.get("nativeRows")
    if not isinstance(rows, list) or not rows:
        hard_failures.append("nativeRows must be a non-empty list")
        rows = []

    expected = set(expected_task_types(sample, dataset_info))
    present_tasks: set[str] = set()
    all_row_text = json.dumps(rows, ensure_ascii=False).lower()
    for forbidden in FORBIDDEN_OUTPUT_TOKENS:
        if forbidden in all_row_text:
            hard_failures.append(f"forbidden token present in nativeRows: {forbidden}")

    task_tokens = content_tokens(extract_source_task(sample))
    source_tokens = content_tokens(sample.get("preview"))
    output_tokens = content_tokens(rows)
    if task_tokens and len(task_tokens) >= 2:
        overlap = task_tokens & output_tokens
        if len(overlap) < 1:
            hard_failures.append("nativeRows do not preserve enough source-specific content")
    elif source_tokens and len(source_tokens) >= 8:
        overlap = source_tokens & output_tokens
        if len(overlap) < 2:
            hard_failures.append("nativeRows do not preserve enough source-specific content")

    for index, row in enumerate(rows):
        label = f"nativeRows[{index}]"
        if not isinstance(row, dict):
            hard_failures.append(f"{label} is not an object")
            continue
        if row.get("format") != "eliza_native_v1":
            hard_failures.append(f"{label}.format must be eliza_native_v1")
        if row.get("boundary") not in NATIVE_BOUNDARIES:
            hard_failures.append(f"{label}.boundary is not a Vercel AI SDK boundary")
        if row.get("schemaVersion") != 1:
            issues.append(f"{label}.schemaVersion should be 1")
        if "cacheStats" in row:
            hard_failures.append(f"{label} includes synthesized cacheStats")
        metadata = row.get("metadata")
        if not isinstance(metadata, dict):
            hard_failures.append(f"{label}.metadata is missing")
            metadata = {}
        task_type = metadata.get("task_type") or infer_task_from_row(row)
        if task_type not in ALLOWED_TASK_TYPES:
            issues.append(f"{label}.metadata.task_type is unexpected: {task_type}")
        else:
            present_tasks.add(task_type)
            components[task_type] += 1
        if metadata.get("source_dataset") != dataset:
            issues.append(f"{label}.metadata.source_dataset should be {dataset}")
        if metadata.get("source_sample_index") != sample.get("sampleIndex"):
            issues.append(f"{label}.metadata.source_sample_index should match sample")

        request = row.get("request")
        response = row.get("response")
        if not isinstance(request, dict):
            hard_failures.append(f"{label}.request is missing")
            request = {}
        if not isinstance(response, dict):
            hard_failures.append(f"{label}.response is missing")
            response = {}
        if not has_request_payload(request):
            hard_failures.append(f"{label}.request has no prompt/messages payload")
        if not has_response_payload(response):
            hard_failures.append(f"{label}.response has no text/toolCalls payload")
        if "usage" in response:
            hard_failures.append(f"{label}.response includes synthesized usage")
        if "providerMetadata" in response:
            hard_failures.append(f"{label}.response includes synthesized providerMetadata")

        req_text = request_text(request)
        tool_calls = response.get("toolCalls")
        if task_type == "should_respond":
            if "context_registry_digest" not in req_text or "message_handler_stage" not in req_text:
                hard_failures.append(f"{label} is not framed as an Eliza messageHandler row")
            calls = [normalize_tool_call(raw) for raw in tool_calls] if isinstance(tool_calls, list) else []
            call_names = {str(call["name"]) for call in calls if call}
            if "MESSAGE_HANDLER_PLAN" not in call_names:
                hard_failures.append(f"{label} should_respond row lacks MESSAGE_HANDLER_PLAN tool call")
        if task_type == "action_planner":
            if "context_registry_digest" not in req_text or "selected_contexts" not in req_text:
                hard_failures.append(f"{label} is not framed as an Eliza planner row")
            if not isinstance(tool_calls, list) or not tool_calls:
                hard_failures.append(f"{label} action_planner row lacks native toolCalls")
        if task_type == "evaluator":
            if "evaluation" not in req_text and "evaluator" not in req_text:
                hard_failures.append(f"{label} is not framed as an Eliza evaluator row")

        messages = request.get("messages")
        if isinstance(messages, list):
            for msg_index, message in enumerate(messages):
                if not isinstance(message, dict):
                    issues.append(f"{label}.request.messages[{msg_index}] is not an object")
                    continue
                if message.get("role") not in {"system", "developer", "user", "assistant", "tool"}:
                    issues.append(f"{label}.request.messages[{msg_index}] has invalid role")

        if isinstance(tool_calls, list) and tool_calls:
            components["toolCalls"] += 1
            valid_calls = [normalize_tool_call(raw) for raw in tool_calls]
            if any(call is None for call in valid_calls):
                hard_failures.append(f"{label}.response.toolCalls contains invalid function call shape")
            tools = request.get("tools")
            if not isinstance(tools, list) or not tools:
                issues.append(f"{label} has toolCalls but no request.tools")
            if response.get("finishReason") not in {None, "tool-calls", "stop"}:
                issues.append(f"{label}.response.finishReason is unusual for tool-call row")
        if is_nonempty_string(response.get("text")):
            components["text"] += 1

    missing_expected = expected - present_tasks
    if missing_expected:
        issues.append(f"missing expected task rows: {', '.join(sorted(missing_expected))}")

    features = set(sample.get("features") or [])
    if "tool_calls" in features and components["toolCalls"] == 0:
        issues.append("source has tool_calls feature but output has no native toolCalls")
    if ("tool_results" in features or "evaluator_decision" in features) and "evaluator" not in present_tasks:
        issues.append("source has tool/evaluator signal but output has no evaluator row")

    score = 1.0
    score -= min(0.75, 0.14 * len(hard_failures))
    score -= min(0.35, 0.035 * len(issues))
    if components["contexts"]:
        score += 0.03
    if components["toolCalls"]:
        score += 0.03
    if expected & present_tasks:
        score += 0.04
    score = max(0.0, min(1.0, round(score, 4)))
    return {
        "score": score,
        "passed": score >= min_score and not hard_failures,
        "issues": issues,
        "hardFailures": hard_failures,
        "components": dict(components),
        "expectedTaskTypes": sorted(expected),
        "presentTaskTypes": sorted(present_tasks),
    }


def run_one(
    *,
    sample: dict[str, Any],
    dataset_info: dict[str, Any],
    templates: dict[str, Any],
    reference_rows: dict[str, Any],
    args: argparse.Namespace,
) -> dict[str, Any]:
    previous: dict[str, Any] | None = None
    previous_eval: dict[str, Any] | None = None
    prompts: list[dict[str, Any]] = []
    attempts: list[dict[str, Any]] = []
    final: dict[str, Any] | None = None

    for iteration in range(1, args.max_iterations + 1):
        prompt = build_generation_prompt(
            sample=sample,
            dataset_info=dataset_info,
            templates=templates,
            reference_rows=reference_rows,
            iteration=iteration,
            previous=previous,
            previous_eval=previous_eval,
        )
        prompt_id = stable_id(sample.get("dataset"), sample.get("sampleIndex"), iteration, prompt)
        prompt_row = {
            "schema": "eliza.native_fillin_prompt.v1",
            "promptId": prompt_id,
            "dataset": sample.get("dataset"),
            "sampleIndex": sample.get("sampleIndex"),
            "iteration": iteration,
            "model": args.model,
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "You are a strict JSON data synthesis worker for Eliza native "
                        "trajectory training."
                    ),
                },
                {"role": "user", "content": prompt},
            ],
        }
        prompts.append(prompt_row)

        if args.dry_run:
            parsed = None
            raw_text = ""
            parse_error = "dry run; no model call"
            response = {"dryRun": True}
        else:
            messages = prompt_row["messages"]
            response = call_cerebras(
                messages=messages,
                model=args.model,
                base_url=args.cerebras_base_url,
                api_key=args.api_key,
                timeout=args.timeout,
                temperature=args.temperature,
                response_format=True,
                rate_limit_retries=args.rate_limit_retries,
                rate_limit_sleep=args.rate_limit_sleep,
            )
            if (
                "error" in response
                and isinstance(response["error"], dict)
                and response["error"].get("status") == 400
                and "response_format" in str(response["error"]).lower()
            ):
                response = call_cerebras(
                    messages=messages,
                    model=args.model,
                    base_url=args.cerebras_base_url,
                    api_key=args.api_key,
                    timeout=args.timeout,
                    temperature=args.temperature,
                    response_format=False,
                    rate_limit_retries=args.rate_limit_retries,
                    rate_limit_sleep=args.rate_limit_sleep,
                )
            if args.request_sleep > 0:
                time.sleep(args.request_sleep)
            parsed, raw_text, parse_error = parse_cerebras_json(response)
            if parsed is not None and args.canonicalize:
                parsed = canonicalize_output(parsed, sample=sample, dataset_info=dataset_info)

        evaluation = evaluate_output(
            parsed,
            parse_error=parse_error,
            sample=sample,
            dataset_info=dataset_info,
            min_score=args.min_score,
        )
        attempt = {
            "schema": "eliza.native_fillin_result.v1",
            "promptId": prompt_id,
            "dataset": sample.get("dataset"),
            "sampleIndex": sample.get("sampleIndex"),
            "rowIndex": sample.get("rowIndex"),
            "iteration": iteration,
            "model": args.model,
            "response": compact_value(strip_provider_reasoning(response), string_limit=1400, depth=5),
            "rawText": raw_text if args.keep_raw_text else compact_value(raw_text, string_limit=3000, depth=2),
            "output": parsed,
            "evaluation": evaluation,
        }
        attempts.append(attempt)
        previous = parsed
        previous_eval = evaluation
        final = attempt
        if evaluation["passed"]:
            break
        if not args.dry_run:
            time.sleep(args.retry_sleep)

    return {
        "dataset": sample.get("dataset"),
        "sampleIndex": sample.get("sampleIndex"),
        "prompts": prompts,
        "attempts": attempts,
        "final": final,
    }


def select_samples(
    samples: list[dict[str, Any]],
    *,
    dataset_order: list[str],
    samples_per_dataset: int,
    limit_datasets: int,
    dataset_filter: set[str],
    pair_filter: set[tuple[str, int]],
) -> list[dict[str, Any]]:
    by_dataset: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for sample in samples:
        dataset = str(sample.get("dataset"))
        if dataset_filter and dataset not in dataset_filter:
            continue
        sample_index = int(sample.get("sampleIndex") or 0)
        if pair_filter and (dataset, sample_index) not in pair_filter:
            continue
        by_dataset[dataset].append(sample)

    ordered = [dataset for dataset in dataset_order if dataset in by_dataset]
    ordered.extend(sorted(set(by_dataset) - set(ordered)))
    if limit_datasets > 0:
        ordered = ordered[:limit_datasets]

    selected: list[dict[str, Any]] = []
    for dataset in ordered:
        rows = sorted(by_dataset[dataset], key=lambda item: int(item.get("sampleIndex") or 0))
        selected.extend(rows[:samples_per_dataset])
    return selected


def load_failed_pairs(path: Path, *, reason_pattern: str = "") -> set[tuple[str, int]]:
    pairs: set[tuple[str, int]] = set()
    if not path.exists():
        raise SystemExit(f"failed-results path does not exist: {path}")
    compiled = re.compile(reason_pattern) if reason_pattern else None
    for row in read_jsonl(path):
        evaluation = row.get("evaluation") if isinstance(row.get("evaluation"), dict) else {}
        if evaluation.get("passed"):
            continue
        if compiled:
            reason_text = json.dumps(
                {
                    "hardFailures": evaluation.get("hardFailures") or [],
                    "issues": evaluation.get("issues") or [],
                },
                ensure_ascii=False,
            )
            if not compiled.search(reason_text):
                continue
        dataset = row.get("dataset")
        sample_index = row.get("sampleIndex")
        if isinstance(dataset, str) and isinstance(sample_index, int):
            pairs.add((dataset, sample_index))
    return pairs


def summarize_run(
    *,
    results: list[dict[str, Any]],
    dataset_info_by_name: dict[str, dict[str, Any]],
    args: argparse.Namespace,
) -> dict[str, Any]:
    final_attempts = [item["final"] for item in results if item.get("final")]
    dataset_rows: dict[str, list[dict[str, Any]]] = defaultdict(list)
    accepted_rows: list[dict[str, Any]] = []
    for attempt in final_attempts:
        dataset_rows[str(attempt["dataset"])].append(attempt)
        evaluation = attempt.get("evaluation") or {}
        output = attempt.get("output") if isinstance(attempt.get("output"), dict) else {}
        if evaluation.get("passed"):
            for row in output.get("nativeRows") or []:
                if isinstance(row, dict):
                    accepted_rows.append(row)

    scores = [
        float((attempt.get("evaluation") or {}).get("score") or 0.0)
        for attempt in final_attempts
    ]
    dataset_summary: list[dict[str, Any]] = []
    for dataset in sorted(dataset_rows):
        rows = dataset_rows[dataset]
        row_scores = [float((row.get("evaluation") or {}).get("score") or 0.0) for row in rows]
        passed = sum(1 for row in rows if (row.get("evaluation") or {}).get("passed"))
        issues = Counter()
        hard = Counter()
        for row in rows:
            evaluation = row.get("evaluation") or {}
            issues.update(evaluation.get("issues") or [])
            hard.update(evaluation.get("hardFailures") or [])
        info = dataset_info_by_name.get(dataset, {})
        dataset_summary.append(
            {
                "dataset": dataset,
                "qualityRating": info.get("qualityRating", "unknown"),
                "samples": len(rows),
                "passed": passed,
                "avgScore": round(statistics.mean(row_scores), 4) if row_scores else 0.0,
                "minScore": round(min(row_scores), 4) if row_scores else 0.0,
                "maxIterationsUsed": max(int(row.get("iteration") or 0) for row in rows),
                "templateIds": info.get("templateIds") or [],
                "topIssues": [item for item, _ in issues.most_common(3)],
                "topHardFailures": [item for item, _ in hard.most_common(3)],
            }
        )

    return {
        "schema": "eliza.native_fillin_summary.v1",
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "model": args.model,
        "samplesPerDataset": args.samples_per_dataset,
        "maxIterations": args.max_iterations,
        "minScore": args.min_score,
        "dryRun": bool(args.dry_run),
        "datasetCount": len(dataset_rows),
        "sampleCount": len(final_attempts),
        "passedSamples": sum(
            1 for attempt in final_attempts if (attempt.get("evaluation") or {}).get("passed")
        ),
        "acceptedNativeRows": len(accepted_rows),
        "avgScore": round(statistics.mean(scores), 4) if scores else 0.0,
        "minScoreObserved": round(min(scores), 4) if scores else 0.0,
        "maxScoreObserved": round(max(scores), 4) if scores else 0.0,
        "datasets": dataset_summary,
    }


def render_summary_markdown(summary: dict[str, Any]) -> str:
    lines = [
        "# Native Fill-In Synthesis Summary",
        "",
        f"- Created: {summary.get('createdAt')}",
        f"- Model: `{summary.get('model')}`",
        f"- Dry run: `{summary.get('dryRun')}`",
        f"- Datasets: {summary.get('datasetCount')}",
        f"- Samples: {summary.get('sampleCount')}",
        f"- Passed samples: {summary.get('passedSamples')}",
        f"- Accepted native rows: {summary.get('acceptedNativeRows')}",
        f"- Average score: {summary.get('avgScore')}",
        f"- Score range: {summary.get('minScoreObserved')} - {summary.get('maxScoreObserved')}",
        "",
        "| Dataset | Rating | Samples | Passed | Avg | Min | Iter | Top issue |",
        "| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |",
    ]
    for row in summary.get("datasets") or []:
        issue = "; ".join((row.get("topHardFailures") or row.get("topIssues") or [])[:1])
        lines.append(
            "| {dataset} | {rating} | {samples} | {passed} | {avg} | {min_score} | {iters} | {issue} |".format(
                dataset=row.get("dataset"),
                rating=row.get("qualityRating"),
                samples=row.get("samples"),
                passed=row.get("passed"),
                avg=row.get("avgScore"),
                min_score=row.get("minScore"),
                iters=row.get("maxIterationsUsed"),
                issue=issue.replace("|", "\\|") if issue else "",
            )
        )
    lines.append("")
    return "\n".join(lines)


def render_dataset_prompt_templates(
    *,
    selected_samples: list[dict[str, Any]],
    dataset_info_by_name: dict[str, dict[str, Any]],
    templates: dict[str, Any],
) -> str:
    by_dataset: dict[str, dict[str, Any]] = {}
    for sample in selected_samples:
        by_dataset.setdefault(str(sample.get("dataset")), sample)
    lines = [
        "# Dataset Fill-In Prompt Templates",
        "",
        "Each exact prompt sent to the teacher model is in `fillin_prompts.jsonl`. "
        "This file records the reusable dataset-level framing for future runs.",
        "",
    ]
    for dataset in sorted(by_dataset):
        sample = by_dataset[dataset]
        info = dataset_info_by_name.get(dataset, {})
        lines.extend(
            [
                f"## {dataset}",
                "",
                "```text",
                build_dataset_prompt_template(dataset, sample, info, templates),
                "```",
                "",
            ]
        )
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--samples", default=str(AUDIT_DIR / "dataset_samples.jsonl"))
    parser.add_argument("--templates", default=str(AUDIT_DIR / "native_synthesis_templates.json"))
    parser.add_argument("--real-rows", default=str(AUDIT_DIR / "real_eliza_native_rows.jsonl"))
    parser.add_argument("--output-dir", default=str(FILLINS_DIR / "latest"))
    parser.add_argument("--samples-per-dataset", type=int, default=3)
    parser.add_argument("--limit-datasets", type=int, default=0)
    parser.add_argument("--datasets", default="", help="Comma-separated dataset allowlist.")
    parser.add_argument(
        "--only-failed-from",
        default="",
        help="Optional fillin_final_results.jsonl; selects only failed dataset/sample pairs.",
    )
    parser.add_argument(
        "--only-failed-reason",
        default="",
        help="Regex filter applied to failed hardFailures/issues when --only-failed-from is set.",
    )
    parser.add_argument("--max-iterations", type=int, default=3)
    parser.add_argument("--min-score", type=float, default=0.82)
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--cerebras-base-url", default=os.environ.get("CEREBRAS_BASE_URL", DEFAULT_BASE_URL))
    parser.add_argument("--timeout", type=int, default=90)
    parser.add_argument("--temperature", type=float, default=0.2)
    parser.add_argument("--retry-sleep", type=float, default=0.25)
    parser.add_argument("--rate-limit-retries", type=int, default=3)
    parser.add_argument("--rate-limit-sleep", type=float, default=20.0)
    parser.add_argument("--request-sleep", type=float, default=0.0)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--no-canonicalize", dest="canonicalize", action="store_false")
    parser.set_defaults(canonicalize=True)
    parser.add_argument("--keep-raw-text", action="store_true")
    args = parser.parse_args()

    load_dotenv(REPO_ROOT / ".env")
    args.api_key = os.environ.get("CEREBRAS_API_KEY", "").strip()
    if not args.dry_run and not args.api_key:
        raise SystemExit("CEREBRAS_API_KEY is required; set it in the environment or repo .env")

    samples = read_jsonl(Path(args.samples))
    dataset_info_by_name, templates = load_templates(Path(args.templates))
    reference_rows = extract_reference_rows(Path(args.real_rows))
    dataset_order = [item.get("dataset") for item in json.loads(Path(args.templates).read_text(encoding="utf-8")).get("datasets", [])] if Path(args.templates).exists() else []
    dataset_order = [str(item) for item in dataset_order if item]
    dataset_filter = {item.strip() for item in args.datasets.split(",") if item.strip()}
    pair_filter = (
        load_failed_pairs(Path(args.only_failed_from), reason_pattern=args.only_failed_reason)
        if args.only_failed_from
        else set()
    )
    selected = select_samples(
        samples,
        dataset_order=dataset_order,
        samples_per_dataset=args.samples_per_dataset,
        limit_datasets=args.limit_datasets,
        dataset_filter=dataset_filter,
        pair_filter=pair_filter,
    )
    if not selected:
        raise SystemExit("no samples selected")

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    print(
        f"selected {len(selected)} samples from {len(set(str(s.get('dataset')) for s in selected))} datasets",
        flush=True,
    )

    results: list[dict[str, Any]] = []
    if args.workers <= 1 or args.dry_run:
        for index, sample in enumerate(selected, start=1):
            dataset = str(sample.get("dataset"))
            info = dataset_info_by_name.get(dataset, {})
            result = run_one(
                sample=sample,
                dataset_info=info,
                templates=templates,
                reference_rows=reference_rows,
                args=args,
            )
            results.append(result)
            final = result.get("final") or {}
            evaluation = final.get("evaluation") or {}
            print(
                f"[{index}/{len(selected)}] {dataset} sample={sample.get('sampleIndex')} "
                f"score={evaluation.get('score')} passed={evaluation.get('passed')} "
                f"iter={final.get('iteration')}",
                flush=True,
            )
    else:
        with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as executor:
            futures = []
            for sample in selected:
                dataset = str(sample.get("dataset"))
                futures.append(
                    executor.submit(
                        run_one,
                        sample=sample,
                        dataset_info=dataset_info_by_name.get(dataset, {}),
                        templates=templates,
                        reference_rows=reference_rows,
                        args=args,
                    )
                )
            for index, future in enumerate(concurrent.futures.as_completed(futures), start=1):
                result = future.result()
                results.append(result)
                final = result.get("final") or {}
                evaluation = final.get("evaluation") or {}
                print(
                    f"[{index}/{len(selected)}] {result.get('dataset')} "
                    f"sample={result.get('sampleIndex')} score={evaluation.get('score')} "
                    f"passed={evaluation.get('passed')} iter={final.get('iteration')}",
                    flush=True,
                )

    results.sort(key=lambda item: (str(item.get("dataset")), int(item.get("sampleIndex") or 0)))
    prompts = [prompt for result in results for prompt in result.get("prompts") or []]
    attempts = [attempt for result in results for attempt in result.get("attempts") or []]
    final_attempts = [result["final"] for result in results if result.get("final")]
    accepted_rows: list[dict[str, Any]] = []
    for attempt in final_attempts:
        evaluation = attempt.get("evaluation") or {}
        output = attempt.get("output") if isinstance(attempt.get("output"), dict) else {}
        if evaluation.get("passed"):
            accepted_rows.extend(row for row in output.get("nativeRows") or [] if isinstance(row, dict))

    write_jsonl(output_dir / "fillin_prompts.jsonl", prompts)
    write_jsonl(output_dir / "fillin_results.jsonl", attempts)
    write_jsonl(output_dir / "fillin_final_results.jsonl", final_attempts)
    write_jsonl(output_dir / "accepted_native_rows.jsonl", accepted_rows)

    summary = summarize_run(results=results, dataset_info_by_name=dataset_info_by_name, args=args)
    (output_dir / "fillin_summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2, sort_keys=True),
        encoding="utf-8",
    )
    (output_dir / "fillin_summary.md").write_text(render_summary_markdown(summary), encoding="utf-8")
    (output_dir / "dataset_prompt_templates.md").write_text(
        render_dataset_prompt_templates(
            selected_samples=selected,
            dataset_info_by_name=dataset_info_by_name,
            templates=templates,
        ),
        encoding="utf-8",
    )

    print(
        f"wrote {len(prompts)} prompts, {len(attempts)} attempts, {len(accepted_rows)} accepted rows to {output_dir}",
        flush=True,
    )
    return 0 if args.dry_run or summary["passedSamples"] == summary["sampleCount"] else 2


if __name__ == "__main__":
    sys.exit(main())
