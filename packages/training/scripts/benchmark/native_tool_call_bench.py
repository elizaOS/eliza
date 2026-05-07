"""Benchmark native Eliza trajectory rows for tool-call structure.

The input is `eliza_native_v1` JSONL. For each row, the benchmark renders the
request side with the tokenizer chat template, generates from a base or tuned
Qwen checkpoint, and compares the decoded output to the native response side.

Primary score:
  - tool_call_structure: expected native tool names and argument keys appear
  - json_structure: non-tool JSON tasks keep the expected decision/action shape
"""

from __future__ import annotations

import argparse
import json
import logging
import re
import sys
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

from format_for_training import format_record  # noqa: E402
from lib.attn import select_attn_impl  # noqa: E402

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("native-bench")

TOOL_BLOCK_RE = re.compile(r"<tool_call>\s*([\s\S]*?)\s*</tool_call>", re.I)
JSON_FENCE_RE = re.compile(r"^```(?:json)?\s*([\s\S]*?)\s*```$", re.I)


@dataclass
class BucketResult:
    name: str
    n: int = 0
    structure_ok: int = 0
    content_ok: int = 0
    parse_errors: int = 0
    field_match: dict[str, int] = field(default_factory=lambda: defaultdict(int))
    field_total: dict[str, int] = field(default_factory=lambda: defaultdict(int))
    failures: list[dict[str, Any]] = field(default_factory=list)

    def record(
        self,
        *,
        ok_structure: bool,
        ok_content: bool,
        parse_error: bool,
        fields: dict[str, bool],
        failed: dict[str, Any] | None,
    ) -> None:
        self.n += 1
        self.structure_ok += int(ok_structure)
        self.content_ok += int(ok_content)
        self.parse_errors += int(parse_error)
        for key, ok in fields.items():
            self.field_total[key] += 1
            self.field_match[key] += int(ok)
        if failed and len(self.failures) < 8:
            self.failures.append(failed)

    def to_dict(self) -> dict[str, Any]:
        def pct(num: int, denom: int) -> float:
            return round(100.0 * num / denom, 2) if denom else 0.0

        return {
            "bucket": self.name,
            "n": self.n,
            "structure_ok": self.structure_ok,
            "structure_pct": pct(self.structure_ok, self.n),
            "content_ok": self.content_ok,
            "content_pct": pct(self.content_ok, self.n),
            "parse_errors": self.parse_errors,
            "field_match_pct": {
                key: pct(self.field_match[key], total)
                for key, total in self.field_total.items()
            },
            "failures": self.failures,
        }


def _clean_json_text(text: str) -> str:
    stripped = text.strip()
    match = JSON_FENCE_RE.match(stripped)
    if match:
        return match.group(1).strip()
    return stripped


def _parse_json_object(text: str) -> dict[str, Any] | None:
    cleaned = _clean_json_text(text)
    if not cleaned.startswith("{"):
        start = cleaned.find("{")
        end = cleaned.rfind("}")
        if start < 0 or end <= start:
            return None
        cleaned = cleaned[start:end + 1]
    try:
        value = json.loads(cleaned)
    except json.JSONDecodeError:
        return None
    return value if isinstance(value, dict) else None


def _call_name(call: dict[str, Any]) -> str:
    function = call.get("function") if isinstance(call.get("function"), dict) else {}
    value = call.get("toolName") or call.get("name") or function.get("name")
    return value if isinstance(value, str) else ""


def _call_args(call: dict[str, Any]) -> dict[str, Any]:
    function = call.get("function") if isinstance(call.get("function"), dict) else {}
    args = (
        call.get("input")
        if "input" in call
        else call.get("args")
        if "args" in call
        else call.get("arguments")
        if "arguments" in call
        else function.get("arguments")
    )
    if isinstance(args, str):
        try:
            parsed = json.loads(args)
        except json.JSONDecodeError:
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return args if isinstance(args, dict) else {}


def normalize_tool_calls(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    calls: list[dict[str, Any]] = []
    for raw in value:
        if isinstance(raw, dict) and _call_name(raw):
            calls.append({"name": _call_name(raw), "arguments": _call_args(raw)})
    return calls


def extract_tool_calls_from_text(text: str) -> list[dict[str, Any]]:
    calls: list[dict[str, Any]] = []
    for block in TOOL_BLOCK_RE.findall(text):
        parsed = _parse_json_object(block)
        if parsed:
            calls.extend(normalize_tool_calls([parsed]))
    if calls:
        return calls

    parsed = _parse_json_object(text)
    if not parsed:
        return []
    for key in ("toolCalls", "tool_calls"):
        if isinstance(parsed.get(key), list):
            return normalize_tool_calls(parsed[key])
    if _call_name(parsed):
        return normalize_tool_calls([parsed])
    return []


def response_text(record: dict[str, Any]) -> str:
    response = record.get("response") if isinstance(record.get("response"), dict) else {}
    text = response.get("text")
    return text if isinstance(text, str) else ""


def expected_tool_calls(record: dict[str, Any]) -> list[dict[str, Any]]:
    response = record.get("response") if isinstance(record.get("response"), dict) else {}
    return normalize_tool_calls(response.get("toolCalls"))


def classify(record: dict[str, Any]) -> str:
    metadata = record.get("metadata") if isinstance(record.get("metadata"), dict) else {}
    task_type = metadata.get("task_type") or record.get("purpose") or "response"
    normalized = str(task_type).replace("-", "_").lower()
    if expected_tool_calls(record):
        return "tool_call"
    if normalized in {"should_respond", "context_routing"}:
        return "routing_json"
    if normalized in {"action_planner", "planner"}:
        return "planner_json"
    return "response"


def load_records(path: Path, max_per_bucket: int) -> dict[str, list[dict[str, Any]]]:
    buckets: dict[str, list[dict[str, Any]]] = defaultdict(list)
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            if record.get("format") != "eliza_native_v1":
                continue
            bucket = classify(record)
            if len(buckets[bucket]) < max_per_bucket:
                buckets[bucket].append(record)
    return buckets


def render_prompt(record: dict[str, Any], tokenizer: Any) -> tuple[str, dict[str, Any]]:
    formatted = format_record(record)
    if not formatted:
        return "", {}
    messages = list(formatted["messages"])
    if messages and messages[-1].get("role") == "assistant":
        messages = messages[:-1]
    kwargs = {
        "conversation": messages,
        "tokenize": False,
        "add_generation_prompt": True,
    }
    if formatted.get("tools") is not None:
        kwargs["tools"] = formatted["tools"]
    try:
        prompt = tokenizer.apply_chat_template(**kwargs)
    except TypeError:
        kwargs.pop("tools", None)
        prompt = tokenizer.apply_chat_template(**kwargs)
    return prompt, formatted


def score_tool_calls(
    predicted_text: str,
    expected_calls: list[dict[str, Any]],
) -> tuple[bool, bool, bool, dict[str, bool]]:
    predicted_calls = extract_tool_calls_from_text(predicted_text)
    parse_error = not predicted_calls
    predicted_names = [call["name"] for call in predicted_calls]
    expected_names = [call["name"] for call in expected_calls]
    expected_arg_keys = [
        sorted(call.get("arguments", {}).keys()) for call in expected_calls
    ]
    predicted_arg_keys = [
        sorted(call.get("arguments", {}).keys()) for call in predicted_calls
    ]
    fields = {
        "tool_count": len(predicted_calls) == len(expected_calls),
        "tool_names": predicted_names == expected_names,
        "argument_keys": predicted_arg_keys == expected_arg_keys,
    }
    return bool(predicted_calls), all(fields.values()), parse_error, fields


def score_json(
    predicted_text: str,
    expected_text: str,
) -> tuple[bool, bool, bool, dict[str, bool]]:
    predicted = _parse_json_object(predicted_text)
    expected = _parse_json_object(expected_text)
    if expected is None:
        ok = bool(predicted_text.strip())
        return ok, ok, False, {"nonempty": ok}
    if predicted is None:
        return False, False, True, {"json_parse": False}

    pred_handler = predicted.get("messageHandler")
    exp_handler = expected.get("messageHandler")
    if isinstance(pred_handler, dict) or isinstance(exp_handler, dict):
        pred_handler_dict = pred_handler if isinstance(pred_handler, dict) else {}
        exp_handler_dict = exp_handler if isinstance(exp_handler, dict) else {}
        pred_action = str(pred_handler_dict.get("action", "")).upper()
        exp_action = str(exp_handler_dict.get("action", "")).upper()
        pred_contexts = pred_handler_dict.get("contexts")
        exp_contexts = exp_handler_dict.get("contexts")
        fields = {
            "json_parse": True,
            "action": pred_action == exp_action,
            "contexts": isinstance(pred_contexts, list)
            and isinstance(exp_contexts, list)
            and pred_contexts == exp_contexts,
        }
        return True, fields["action"] and fields["contexts"], False, fields

    expected_keys = set(expected.keys())
    predicted_keys = set(predicted.keys())
    fields = {
        "json_parse": True,
        "top_level_keys": expected_keys.issubset(predicted_keys),
    }
    return True, fields["top_level_keys"], False, fields


def generate(model: Any, tokenizer: Any, prompt: str, *, max_new_tokens: int) -> str:
    import torch

    inputs = tokenizer(prompt, return_tensors="pt").to(model.device)
    with torch.no_grad():
        output = model.generate(
            **inputs,
            max_new_tokens=max_new_tokens,
            do_sample=False,
            pad_token_id=tokenizer.eos_token_id,
        )
    generated = output[0][inputs["input_ids"].shape[-1]:]
    return tokenizer.decode(generated, skip_special_tokens=False)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--test-file", required=True)
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--max-per-bucket", type=int, default=200)
    parser.add_argument("--max-new-tokens", type=int, default=512)
    args = parser.parse_args()

    buckets = load_records(Path(args.test_file), args.max_per_bucket)
    if not buckets:
        raise SystemExit(f"no eliza_native_v1 records found in {args.test_file}")

    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer

    device = "cuda" if torch.cuda.is_available() else "cpu"
    tokenizer = AutoTokenizer.from_pretrained(args.model, trust_remote_code=True)
    if tokenizer.pad_token_id is None:
        tokenizer.pad_token = tokenizer.eos_token
    model_kwargs: dict[str, Any] = {
        "torch_dtype": torch.bfloat16 if device == "cuda" else torch.float32,
        "trust_remote_code": True,
        "low_cpu_mem_usage": True,
        "attn_implementation": select_attn_impl(device),
    }
    if device == "cuda":
        model_kwargs["device_map"] = "auto"
    model = AutoModelForCausalLM.from_pretrained(args.model, **model_kwargs)
    if device == "cpu":
        model.to(device)
    model.eval()

    results: dict[str, BucketResult] = {
        bucket: BucketResult(bucket) for bucket in buckets
    }
    for bucket, records in buckets.items():
        log.info("bucket=%s n=%d", bucket, len(records))
        for record in records:
            prompt, _formatted = render_prompt(record, tokenizer)
            if not prompt:
                continue
            predicted = generate(
                model,
                tokenizer,
                prompt,
                max_new_tokens=args.max_new_tokens,
            )
            expected_calls = expected_tool_calls(record)
            if expected_calls:
                ok_structure, ok_content, parse_error, fields = score_tool_calls(
                    predicted,
                    expected_calls,
                )
            else:
                ok_structure, ok_content, parse_error, fields = score_json(
                    predicted,
                    response_text(record),
                )
            results[bucket].record(
                ok_structure=ok_structure,
                ok_content=ok_content,
                parse_error=parse_error,
                fields=fields,
                failed=None
                if ok_content
                else {
                    "trajectoryId": record.get("trajectoryId"),
                    "callId": record.get("callId"),
                    "expected": record.get("response"),
                    "predicted": predicted[:2000],
                },
            )

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    summary = {
        "model": args.model,
        "test_file": args.test_file,
        "buckets": {key: result.to_dict() for key, result in results.items()},
    }
    (out_dir / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
