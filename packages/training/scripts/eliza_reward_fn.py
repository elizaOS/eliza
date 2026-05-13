"""Verifiable reward function for native Eliza tool-calling GRPO.

The reward scores the model's native assistant output against JSON/function
calling ground truth:

  format_ok    (0/1)   — response is structured enough to score, or is a
                         non-empty direct reply when the target is text.
  content_ok   (0/1)   — tool names and argument values match, or JSON/text
                         response matches the expected target.
  length       (-0.2..0)— bounded short/long response penalty.
  ai_judge     (0/1)   — optional Claude judge call
                         (ELIZA_REWARD_USE_AI_JUDGE=1).

Final reward is a clamped weighted sum in [-1, 1].
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

log = logging.getLogger("eliza-reward")


DEFAULT_WEIGHTS: dict[str, float] = {
    "format": 0.4,
    "content": 0.4,
    "length": 0.1,
    "ai_judge": 0.1,
}

LENGTH_TARGET_LO = 12
LENGTH_TARGET_HI = 700
LENGTH_PENALTY_FLOOR = -0.2

AI_JUDGE_MODEL_ENV = "ELIZA_REWARD_AI_JUDGE_MODEL"
AI_JUDGE_DEFAULT_MODEL = "claude-haiku-4-5-20251001"

JSON_FENCE_RE = re.compile(r"^```(?:json)?\s*([\s\S]*?)\s*```$", re.I)
TOKEN_RE = re.compile(r"\S+")


@dataclass
class RewardComponents:
    """Per-call breakdown so verl/wandb can log individual signals."""

    format_ok: float = 0.0
    content_ok: float = 0.0
    length_score: float = 0.0
    ai_judge_score: float | None = None
    weighted_sum: float = 0.0
    final: float = 0.0
    notes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "format_ok": self.format_ok,
            "content_ok": self.content_ok,
            "length_score": self.length_score,
            "ai_judge_score": self.ai_judge_score,
            "weighted_sum": self.weighted_sum,
            "final": self.final,
            "notes": self.notes,
        }


def _as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _clean_json_text(text: str) -> str:
    stripped = (text or "").strip()
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
        cleaned = cleaned[start : end + 1]
    try:
        value = json.loads(cleaned)
    except json.JSONDecodeError:
        return None
    return value if isinstance(value, dict) else None


def _call_name(call: dict[str, Any]) -> str:
    function = _as_dict(call.get("function"))
    value = (
        call.get("name")
        or call.get("toolName")
        or call.get("tool_name")
        or call.get("tool")
        or function.get("name")
    )
    return value.strip() if isinstance(value, str) else ""


def _call_args(call: dict[str, Any]) -> dict[str, Any]:
    function = _as_dict(call.get("function"))
    raw = (
        call.get("input")
        if "input" in call
        else call.get("args")
        if "args" in call
        else call.get("arguments")
        if "arguments" in call
        else call.get("parameters")
        if "parameters" in call
        else function.get("arguments")
    )
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return raw if isinstance(raw, dict) else {}


def _normalize_tool_calls(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    calls: list[dict[str, Any]] = []
    for raw in value:
        if not isinstance(raw, dict):
            continue
        name = _call_name(raw)
        if not name:
            continue
        calls.append({"name": name, "arguments": _call_args(raw)})
    return calls


def _extract_tool_calls_from_text(text: str) -> list[dict[str, Any]]:
    parsed = _parse_json_object(text or "")
    if not parsed:
        return []
    for key in ("toolCalls", "tool_calls"):
        if isinstance(parsed.get(key), list):
            return _normalize_tool_calls(parsed[key])
    if _call_name(parsed):
        return _normalize_tool_calls([parsed])
    return []


def _deep_contains(expected: Any, actual: Any) -> bool:
    if isinstance(expected, dict):
        if not isinstance(actual, dict):
            return False
        return all(key in actual and _deep_contains(value, actual[key]) for key, value in expected.items())
    if isinstance(expected, list):
        return expected == actual
    return expected == actual or str(expected) == str(actual)


def _normalize_words(text: str) -> list[str]:
    lowered = (text or "").lower()
    cleaned = "".join(ch if ch.isalnum() else " " for ch in lowered)
    return [token for token in cleaned.split() if token]


def _text_similarity(expected: str, actual: str) -> float:
    if expected.strip() == actual.strip():
        return 1.0
    expected_tokens = _normalize_words(expected)
    actual_tokens = _normalize_words(actual)
    if not expected_tokens or not actual_tokens:
        return 0.0
    counts: dict[str, int] = {}
    for token in expected_tokens:
        counts[token] = counts.get(token, 0) + 1
    overlap = 0
    for token in actual_tokens:
        count = counts.get(token, 0)
        if count:
            overlap += 1
            counts[token] = count - 1
    precision = overlap / len(actual_tokens)
    recall = overlap / len(expected_tokens)
    return 0.0 if precision + recall == 0 else (2 * precision * recall) / (precision + recall)


def _ground_truth_target(ground_truth: dict[str, Any] | None) -> dict[str, Any]:
    if not ground_truth:
        return {}
    response = _as_dict(ground_truth.get("response"))
    calls = _normalize_tool_calls(
        ground_truth.get("expectedToolCalls")
        or ground_truth.get("expected_tool_calls")
        or response.get("toolCalls")
        or response.get("tool_calls")
    )
    expected = ground_truth.get("expected")
    if expected is None:
        expected = ground_truth.get("expectedResponse")
    parsed_expected = _parse_json_object(str(expected)) if isinstance(expected, str) else expected
    if not calls and isinstance(parsed_expected, dict):
        for key in ("toolCalls", "tool_calls"):
            if isinstance(parsed_expected.get(key), list):
                calls = _normalize_tool_calls(parsed_expected[key])
                break
    return {
        "tool_calls": calls,
        "json": parsed_expected if isinstance(parsed_expected, dict) else None,
        "text": str(response.get("text") or expected or ""),
    }


def _score_tool_calls(
    predicted_calls: list[dict[str, Any]],
    expected_calls: list[dict[str, Any]],
) -> tuple[float, float, list[str]]:
    notes: list[str] = []
    if not predicted_calls:
        return 0.0, 0.0, ["missing_native_tool_calls"]
    if len(predicted_calls) < len(expected_calls):
        notes.append("too_few_tool_calls")
    names_ok = [
        index < len(predicted_calls)
        and predicted_calls[index]["name"] == expected["name"]
        for index, expected in enumerate(expected_calls)
    ]
    args_ok = [
        index < len(predicted_calls)
        and _deep_contains(expected.get("arguments", {}), predicted_calls[index].get("arguments", {}))
        for index, expected in enumerate(expected_calls)
    ]
    content_ok = 1.0 if all(names_ok) and all(args_ok) else 0.0
    if not all(names_ok):
        notes.append("tool_name_mismatch")
    if not all(args_ok):
        notes.append("tool_argument_mismatch")
    return 1.0, content_ok, notes


def _score_json_or_text(response: str, target: dict[str, Any]) -> tuple[float, float, list[str]]:
    notes: list[str] = []
    expected_json = target.get("json")
    expected_text = str(target.get("text") or "")
    predicted_json = _parse_json_object(response)
    if isinstance(expected_json, dict):
        if not predicted_json:
            return 0.0, 0.0, ["json_parse_failed"]
        return 1.0, 1.0 if _deep_contains(expected_json, predicted_json) else 0.0, notes
    if expected_text:
        ok = bool(response.strip())
        return 1.0 if ok else 0.0, 1.0 if _text_similarity(expected_text, response) >= 0.8 else 0.0, notes
    ok = bool(response.strip()) or bool(predicted_json)
    notes.append("no_ground_truth")
    return 1.0 if ok else 0.0, 0.5, notes


def _score_verifiable(
    response: str,
    ground_truth: dict[str, Any] | None,
) -> tuple[float, float, list[str]]:
    target = _ground_truth_target(ground_truth)
    expected_calls = target.get("tool_calls") or []
    if expected_calls:
        return _score_tool_calls(_extract_tool_calls_from_text(response), expected_calls)
    return _score_json_or_text(response, target)


def _length_score(response: str) -> float:
    n = len(TOKEN_RE.findall(response or ""))
    if LENGTH_TARGET_LO <= n <= LENGTH_TARGET_HI:
        return 0.0
    if n < LENGTH_TARGET_LO:
        frac = n / max(LENGTH_TARGET_LO, 1)
        return LENGTH_PENALTY_FLOOR * (1.0 - frac)
    over = (n - LENGTH_TARGET_HI) / max(LENGTH_TARGET_HI * 3, 1)
    return max(LENGTH_PENALTY_FLOOR, LENGTH_PENALTY_FLOOR * min(over, 1.0))


AI_JUDGE_PROMPT = """You are scoring an autonomous agent's native tool-calling response.

Prompt context:
{prompt}

Ground truth:
{expected}

Model response:
{response}

Is the model response correct given the prompt and ground truth?
Reply with exactly one token: YES or NO.
"""


def _ai_judge_score(
    prompt: str,
    response: str,
    ground_truth: dict[str, Any] | None,
) -> float | None:
    if os.environ.get("ELIZA_REWARD_USE_AI_JUDGE", "0") != "1":
        return None
    if not ground_truth:
        return None
    try:
        import anthropic
    except ImportError:
        log.warning("anthropic SDK not installed; skipping AI judge")
        return None
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        log.warning("ANTHROPIC_API_KEY unset; skipping AI judge")
        return None

    expected = ground_truth.get("expected") or ground_truth.get("expectedResponse") or ground_truth
    body = AI_JUDGE_PROMPT.format(
        prompt=(prompt or "")[:2000],
        expected=json.dumps(expected, ensure_ascii=False, default=str)[:1500],
        response=(response or "")[:2000],
    )
    client = anthropic.Anthropic(api_key=api_key)
    model = os.environ.get(AI_JUDGE_MODEL_ENV, AI_JUDGE_DEFAULT_MODEL)
    resp = client.messages.create(
        model=model,
        max_tokens=4,
        messages=[{"role": "user", "content": body}],
    )
    text = ""
    for block in resp.content:
        if getattr(block, "type", "") == "text":
            text += getattr(block, "text", "")
    verdict = text.strip().upper()
    if verdict.startswith("YES"):
        return 1.0
    if verdict.startswith("NO"):
        return 0.0
    log.warning("ai_judge unparseable verdict: %r", verdict)
    return None


def compute_reward_components(
    prompt: str,
    response: str,
    ground_truth: dict[str, Any] | None,
    *,
    weights: dict[str, float] | None = None,
) -> RewardComponents:
    w = weights or DEFAULT_WEIGHTS
    out = RewardComponents()
    out.format_ok, out.content_ok, notes = _score_verifiable(response, ground_truth)
    out.notes.extend(notes)
    out.length_score = _length_score(response)
    out.ai_judge_score = _ai_judge_score(prompt, response, ground_truth)

    weighted = (
        w.get("format", 0.0) * out.format_ok
        + w.get("content", 0.0) * out.content_ok
        + w.get("length", 0.0) * out.length_score
    )
    if out.ai_judge_score is not None:
        weighted += w.get("ai_judge", 0.0) * out.ai_judge_score
    out.weighted_sum = weighted
    out.final = max(-1.0, min(1.0, weighted))
    return out


def compute_reward(
    prompt: str,
    response: str,
    ground_truth: dict[str, Any] | None,
    *,
    weights: dict[str, float] | None = None,
) -> float:
    """Scalar reward in [-1, 1]. Importable from verl's reward-fn registry."""

    return compute_reward_components(prompt, response, ground_truth, weights=weights).final


def compute_score(
    data_source: str,
    solution_str: str,
    ground_truth: Any,
    extra_info: Any = None,
) -> float:
    gt: dict[str, Any] | None
    if isinstance(ground_truth, dict):
        gt = ground_truth
    elif isinstance(ground_truth, str):
        gt = {"expected": ground_truth, "task_type": data_source or ""}
    else:
        gt = None
    prompt = str(extra_info.get("prompt") or "") if isinstance(extra_info, dict) else ""
    return compute_reward(prompt, solution_str, gt)


def _load_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--prompt-jsonl", required=True, help="JSONL of {id, prompt, ground_truth} rows.")
    ap.add_argument("--responses-jsonl", required=True, help="JSONL of {id, response} rows. Joined by id.")
    ap.add_argument("--out", required=True, help="Output JSON file with per-row + aggregate scores.")
    ap.add_argument("--weight-format", type=float, default=DEFAULT_WEIGHTS["format"])
    ap.add_argument("--weight-content", type=float, default=DEFAULT_WEIGHTS["content"])
    ap.add_argument("--weight-length", type=float, default=DEFAULT_WEIGHTS["length"])
    ap.add_argument("--weight-judge", type=float, default=DEFAULT_WEIGHTS["ai_judge"])
    args = ap.parse_args()

    weights = {
        "format": args.weight_format,
        "content": args.weight_content,
        "length": args.weight_length,
        "ai_judge": args.weight_judge,
    }
    prompts = {row["id"]: row for row in _load_jsonl(Path(args.prompt_jsonl))}
    responses = _load_jsonl(Path(args.responses_jsonl))

    rows: list[dict[str, Any]] = []
    total = 0.0
    for response_row in responses:
        rid = response_row["id"]
        prompt_row = prompts.get(rid)
        if not prompt_row:
            continue
        comps = compute_reward_components(
            prompt_row.get("prompt", ""),
            response_row.get("response", ""),
            prompt_row.get("ground_truth"),
            weights=weights,
        )
        rows.append({"id": rid, "components": comps.to_dict()})
        total += comps.final

    avg = total / len(rows) if rows else 0.0
    payload = {"weights": weights, "n": len(rows), "mean_reward": avg, "rows": rows}
    Path(args.out).write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(json.dumps({"n": len(rows), "mean_reward": round(avg, 4)}))
    return 0


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
    sys.exit(main())
