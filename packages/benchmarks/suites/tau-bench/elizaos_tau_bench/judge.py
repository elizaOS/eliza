"""LLM-based judge that evaluates whether an agent's responses satisfy a task's ``outputs``.

Upstream tau-bench checks ``task.outputs`` with a literal substring match against
the agent's RESPOND actions (see ``upstream/envs/base.py::calculate_reward``).
That is brittle — a correct answer phrased differently scores 0. Following the
direction of Sierra's "LLM-as-judge" experiments, this module asks a small LLM
(default ``gpt-4o-mini``) to decide whether each required output is present in
the agent's transcript.

The judge is only consulted when ``task.outputs`` is non-empty; otherwise the
upstream data-hash check is sufficient.

A judge that cannot produce an LLM verdict must never silently substitute the
substring heuristic: a broken judge fabricating healthy-looking scores is a
"not loaded reads as zero" failure. LLM-judge failures raise
``JudgeUnavailableError`` unless the operator explicitly opted into the
heuristic degrade, in which case the result is marked ``degraded`` and the
runner records that in report.json.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from typing import Any, Optional

logger = logging.getLogger(__name__)


class JudgeUnavailableError(RuntimeError):
    """The LLM judge was requested but could not produce a verdict.

    Raised so a broken judge fails the run instead of silently degrading to
    the substring heuristic and publishing fabricated scores.
    """


@dataclass
class JudgeResult:
    satisfied: bool
    explanation: str
    per_output: dict[str, bool]
    # How the verdict was produced: "llm", "substring", or "none-required".
    mode: str = "llm"
    # True only when the opt-in heuristic replaced a *failed* LLM judge; an
    # explicitly configured substring judge (use_llm=False) is not degraded.
    degraded: bool = False


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
    """Upstream-style substring check, used only when explicitly configured."""
    haystack = " ".join(m.lower().replace(",", "") for m in agent_messages)
    per: dict[str, bool] = {}
    for o in outputs:
        per[o] = o.lower() in haystack
    return JudgeResult(
        satisfied=all(per.values()),
        explanation="Substring check (LLM judge disabled by config)",
        per_output=per,
        mode="substring",
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
    allow_heuristic_fallback: bool = False,
) -> JudgeResult:
    """Return whether each required output is satisfied in the agent's messages.

    With ``use_llm=True`` (the default), an LLM-judge failure raises
    ``JudgeUnavailableError`` unless ``allow_heuristic_fallback`` is set, in
    which case the substring heuristic is used and the result is explicitly
    marked ``degraded=True`` so the report never looks healthy by accident.
    """
    if not outputs:
        return JudgeResult(
            satisfied=True, explanation="No outputs required", per_output={}, mode="none-required"
        )

    if not use_llm:
        return _fallback_substring_check(outputs, agent_messages)

    def _degrade_or_raise(reason: str, cause: Exception | None) -> JudgeResult:
        if not allow_heuristic_fallback:
            raise JudgeUnavailableError(reason) from cause
        # error-policy:J4 operator explicitly opted into the heuristic degrade
        # (--judge-allow-heuristic-fallback); the verdict is marked
        # degraded=True and surfaced per-trial in report.json, never healthy.
        logger.warning("Judge degraded to substring heuristic: %s", reason)
        fallback = _fallback_substring_check(outputs, agent_messages)
        fallback.degraded = True
        fallback.explanation = f"DEGRADED substring fallback — {reason}"
        return fallback

    try:
        import elizaos_tau_bench.model_client as model_client

        res = model_client.completion(
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
        # error-policy:J2 translate any judge-backend failure (missing key,
        # unreachable proxy, provider error) into the typed judge error — or
        # the opt-in degraded verdict — with the original failure as cause.
        return _degrade_or_raise(
            f"judge LLM call failed (provider={provider}, model={model}): {e}", e
        )

    parsed = _parse_json_object(content)
    if not parsed or "per_output" not in parsed:
        return _degrade_or_raise(
            f"judge LLM returned unparseable response: {content[:200]!r}", None
        )

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
    return JudgeResult(
        satisfied=all(per.values()), explanation=explanation, per_output=per, mode="llm"
    )


__all__ = ["JudgeResult", "JudgeUnavailableError", "judge_outputs_satisfied"]
