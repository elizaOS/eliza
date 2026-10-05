"""Optional LLM-judge augmentation for app-eval scoring (#9475).

app-eval's deterministic keyword/structure scorer is intentional — it gives
reproducible, key-free scores (see AGENTS.md). The issue asked for an LLM judge;
rather than REPLACE the deterministic scorer (which would make scores flaky and
credential-bound), this adds an OPT-IN judge that AUGMENTS it: when
``APP_EVAL_LLM_JUDGE=1`` and a judge endpoint is configured, the final score is a
blend of the deterministic score and an LLM judge's 0–10 rating. With the env
unset (the default), scoring is byte-for-byte the deterministic path.

The judge HTTP call is isolated in ``default_judge_call`` (stdlib urllib, no new
deps); the prompt building, score parsing, and blending are pure and unit-tested
with an injected fake call — no network or key needed in tests.
"""

from __future__ import annotations

import json
import os
import re
import urllib.request
from typing import Any, Callable

# A judge call takes a prompt and returns the model's raw text response.
JudgeCall = Callable[[str], str]

_DEFAULT_WEIGHT = 0.5


def judge_enabled() -> bool:
    """True when the opt-in LLM judge is requested via env."""
    return os.environ.get("APP_EVAL_LLM_JUDGE", "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


def judge_weight() -> float:
    """Blend weight for the judge score (0..1); env-overridable. Default 0.5."""
    raw = os.environ.get("APP_EVAL_LLM_JUDGE_WEIGHT", "").strip()
    if not raw:
        return _DEFAULT_WEIGHT
    try:
        return max(0.0, min(1.0, float(raw)))
    except ValueError:
        return _DEFAULT_WEIGHT


def build_judge_prompt(task_def: dict[str, Any], response_text: str) -> str:
    """Build the judge prompt. Pure."""
    task_id = task_def.get("id", "unknown")
    prompt = task_def.get("prompt") or task_def.get("description") or ""
    criteria = task_def.get("evaluation", {}).get("criteria", [])
    criteria_text = (
        "\n".join(f"- {c.get('name', '?')} (weight {c.get('weight', 1)})" for c in criteria)
        if criteria
        else "- overall task quality"
    )
    max_score = _max_score(task_def)
    return (
        "You are a strict, fair judge scoring an AI agent's answer to a task.\n"
        f"Task id: {task_id}\n"
        f"Task:\n{prompt}\n\n"
        f"Scoring criteria:\n{criteria_text}\n\n"
        f"Agent answer:\n{response_text}\n\n"
        f"Rate the answer from 0 to {max_score}. Respond with exactly one line:\n"
        f"SCORE: <number>/{max_score}\n"
        "Then one short sentence of justification."
    )


def parse_judge_score(text: str, max_score: float) -> float | None:
    """Extract the judge's numeric score from its response. Pure.

    Accepts ``SCORE: 7/10``, ``SCORE: 7``, ``7 / 10``, or a bare leading number.
    Returns the score clamped to ``[0, max_score]``, or ``None`` if unparseable.
    """
    if not text:
        return None
    m = re.search(r"SCORE:\s*([0-9]+(?:\.[0-9]+)?)\s*(?:/\s*([0-9]+(?:\.[0-9]+)?))?", text, re.IGNORECASE)
    if not m:
        m = re.search(r"\b([0-9]+(?:\.[0-9]+)?)\s*/\s*([0-9]+(?:\.[0-9]+)?)\b", text)
    if not m:
        m = re.search(r"^\s*([0-9]+(?:\.[0-9]+)?)", text)
    if not m:
        return None
    value = float(m.group(1))
    denom = float(m.group(2)) if (m.lastindex and m.lastindex >= 2 and m.group(2)) else None
    if denom and denom > 0 and abs(denom - max_score) > 1e-9:
        # Judge used a different scale (e.g. /5) — normalize to max_score.
        value = value / denom * max_score
    return max(0.0, min(max_score, value))


def blend_scores(deterministic: float, judge: float, *, weight: float = _DEFAULT_WEIGHT) -> float:
    """Weighted blend of deterministic and judge scores. Pure.

    ``weight`` is the judge's share (0 → all deterministic, 1 → all judge).
    """
    weight = max(0.0, min(1.0, weight))
    return round((1.0 - weight) * deterministic + weight * judge, 3)


def _max_score(task_def: dict[str, Any]) -> float:
    scoring = task_def.get("evaluation", {}).get("scoring", {})
    return float(scoring.get("max_score", task_def.get("max_score", 10)))


def apply_judge(
    eval_result: dict[str, Any],
    task_def: dict[str, Any],
    response_text: str,
    *,
    call: JudgeCall | None = None,
    weight: float | None = None,
) -> dict[str, Any]:
    """Augment a deterministic eval with an LLM judge when enabled.

    No-op (returns ``eval_result`` unchanged) unless the judge is enabled AND a
    judge call is available — so the default path stays deterministic. On
    success, blends scores and annotates ``deterministic_score`` /
    ``judge_score`` / ``judged``.
    """
    if not judge_enabled():
        return eval_result
    judge_call = call or default_judge_call()
    if judge_call is None:
        return eval_result
    try:
        raw = judge_call(build_judge_prompt(task_def, response_text))
    except Exception:
        return eval_result
    max_score = _max_score(task_def)
    judge_score = parse_judge_score(raw, max_score)
    if judge_score is None:
        return eval_result
    deterministic = float(eval_result.get("score", 0) or 0)
    w = judge_weight() if weight is None else max(0.0, min(1.0, weight))
    blended = blend_scores(deterministic, judge_score, weight=w)
    out = dict(eval_result)
    out["deterministic_score"] = deterministic
    out["judge_score"] = judge_score
    out["judged"] = True
    out["score"] = blended
    out["pass"] = blended > 0
    return out


def default_judge_call() -> JudgeCall | None:
    """Production judge call over an OpenAI-compatible chat endpoint.

    Returns ``None`` when no endpoint/key is configured (so ``apply_judge``
    stays a no-op). Uses stdlib urllib — no extra dependency.
    """
    api_key = os.environ.get("APP_EVAL_JUDGE_API_KEY") or os.environ.get("OPENAI_API_KEY")
    if not api_key:
        return None
    base_url = (
        os.environ.get("APP_EVAL_JUDGE_BASE_URL")
        or os.environ.get("OPENAI_BASE_URL")
        or "https://api.openai.com/v1"
    ).rstrip("/")
    model = os.environ.get("APP_EVAL_JUDGE_MODEL", "gemma-4-31b")

    def _call(prompt: str) -> str:
        body = json.dumps(
            {
                "model": model,
                "messages": [{"role": "user", "content": prompt}],
                "temperature": 0,
            }
        ).encode("utf-8")
        req = urllib.request.Request(
            f"{base_url}/chat/completions",
            data=body,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=60) as resp:  # noqa: S310
            payload = json.loads(resp.read().decode("utf-8"))
        return payload["choices"][0]["message"]["content"]

    return _call
