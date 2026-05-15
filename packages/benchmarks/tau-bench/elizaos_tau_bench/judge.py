"""LLM-based judge that evaluates whether an agent's responses satisfy a task's ``outputs``.

Upstream tau-bench checks ``task.outputs`` with a literal substring match against
the agent's RESPOND actions (see ``upstream/envs/base.py::calculate_reward``).
That is brittle — a correct answer phrased differently scores 0. Following the
direction of Sierra's "LLM-as-judge" experiments, this module asks a small LLM
(default ``gpt-4o-mini``) to decide whether each required output is present in
the agent's transcript.

The judge is only consulted when ``task.outputs`` is non-empty; otherwise the
upstream data-hash check is sufficient.
"""

from __future__ import annotations

import json
import logging
import os
import re
from dataclasses import dataclass
from typing import Any, Optional

logger = logging.getLogger(__name__)


@dataclass
class JudgeResult:
    satisfied: bool
    explanation: str
    per_output: dict[str, bool]


_SYSTEM_PROMPT = (
    "You are a strict grader for the tau-bench customer-service benchmark. "
    "Given a task's required outputs and an agent's final messages, decide for "
    "each required output whether it is communicated to the customer (case- and "
    "phrasing-insensitive, but the actual value must be present)."
)


def _build_prompt(outputs: list[str], agent_messages: list[str]) -> str:
    bullets = "\n".join(f"- {o}" for o in outputs)
    transcript = "\n---\n".join(agent_messages) if agent_messages else "(no agent messages)"
    return f"""Required outputs (each must be communicated to the customer):
{bullets}

Agent messages to the customer (most recent last):
{transcript}

Reply with a single JSON object: {{"per_output": {{"<output>": true|false, ...}}, "explanation": "..."}}. No prose outside the JSON.
"""


def _fallback_substring_check(outputs: list[str], agent_messages: list[str]) -> JudgeResult:
    """Upstream-style substring check, used when no judge LLM is available."""
    haystack = " ".join(m.lower().replace(",", "") for m in agent_messages)
    per: dict[str, bool] = {}
    for o in outputs:
        per[o] = o.lower() in haystack
    return JudgeResult(
        satisfied=all(per.values()),
        explanation="Substring fallback (no LLM judge)",
        per_output=per,
    )


def _parse_json_object(text: str) -> Optional[dict[str, Any]]:
    text = text.strip()
    # Strip code fences if any
    fence = re.match(r"^```(?:json)?\s*(.*?)```$", text, re.DOTALL)
    if fence:
        text = fence.group(1).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}", text, re.DOTALL)
        if m:
            try:
                return json.loads(m.group(0))
            except json.JSONDecodeError:
                return None
        return None


def judge_outputs_satisfied(
    outputs: list[str],
    agent_messages: list[str],
    model: str = "gpt-4o-mini",
    provider: str = "openai",
    use_llm: bool = True,
) -> JudgeResult:
    """Return whether each required output is satisfied in the agent's messages."""
    if not outputs:
        return JudgeResult(satisfied=True, explanation="No outputs required", per_output={})

    if not use_llm:
        return _fallback_substring_check(outputs, agent_messages)

    # Check API key availability — fall back if missing
    if provider == "openai" and not os.environ.get("OPENAI_API_KEY"):
        logger.warning(
            "Judge LLM requested but OPENAI_API_KEY missing; using substring fallback"
        )
        return _fallback_substring_check(outputs, agent_messages)

    try:
        from elizaos_tau_bench.model_client import completion

        res = completion(
            model=model,
            custom_llm_provider=provider,
            messages=[
                {"role": "system", "content": _SYSTEM_PROMPT},
                {"role": "user", "content": _build_prompt(outputs, agent_messages)},
            ],
            temperature=0.0,
        )
        content = res.choices[0].message.content or ""
    except Exception as e:
        logger.warning("Judge LLM call failed (%s); using substring fallback", e)
        return _fallback_substring_check(outputs, agent_messages)

    parsed = _parse_json_object(content)
    if not parsed or "per_output" not in parsed:
        logger.warning("Judge LLM returned unparseable response: %s", content[:200])
        return _fallback_substring_check(outputs, agent_messages)

    per_raw = parsed.get("per_output") or {}
    per: dict[str, bool] = {}
    for o in outputs:
        v = per_raw.get(o)
        if v is None:
            # Try case-insensitive key match
            lower_map = {str(k).lower(): vv for k, vv in per_raw.items()}
            v = lower_map.get(o.lower(), False)
        per[o] = bool(v)

    explanation = str(parsed.get("explanation", ""))
    return JudgeResult(satisfied=all(per.values()), explanation=explanation, per_output=per)


__all__ = ["JudgeResult", "judge_outputs_satisfied"]
