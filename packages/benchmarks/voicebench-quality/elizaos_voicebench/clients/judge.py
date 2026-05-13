"""LLM judge client.

Defaults to Cerebras ``gpt-oss-120b`` — the same model used by
LifeOpsBench's simulated user / judge. We reuse the existing
:class:`eliza_lifeops_bench.clients.cerebras.CerebrasClient` to keep one
canonical Cerebras call site in the repo (retry policy, pricing,
rate-limit handling are all centralized there).

    The judge is invoked at most once per open-ended sample and requires a
    real Cerebras call for scored benchmark output.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Protocol

log = logging.getLogger("elizaos_voicebench.clients.judge")

_JUDGE_SYSTEM = (
    "You are an impartial grader. Score the candidate response on a 1-5 "
    "integer scale against the reference. Respond with ONLY a single JSON "
    'object: {"score": <int 1-5>, "rationale": "<one-sentence reason>"}.'
)

_JUDGE_USER_TEMPLATE = (
    "PROMPT: {prompt}\n\n"
    "REFERENCE: {reference}\n\n"
    "CANDIDATE: {candidate}\n\n"
    "Score the candidate 1 (irrelevant / wrong) to 5 (matches reference)."
)

_SCORE_RE = re.compile(r'"score"\s*:\s*([0-9]+)')


class Judge(Protocol):
    async def score(self, *, prompt: str, reference: str, candidate: str) -> tuple[float, str]:
        """Return (score in [0, 1], rationale)."""


class CerebrasJudge:
    """Real LLM judge backed by Cerebras gpt-oss-120b."""

    def __init__(
        self,
        *,
        model: str | None = None,
        api_key: str | None = None,
        base_url: str | None = None,
    ) -> None:
        from eliza_lifeops_bench.clients.cerebras import CerebrasClient  # noqa: WPS433

        self._client = CerebrasClient(model=model, api_key=api_key, base_url=base_url)
        self.model = self._client.model_name

    async def score(
        self, *, prompt: str, reference: str, candidate: str
    ) -> tuple[float, str]:
        from eliza_lifeops_bench.clients.base import ClientCall  # noqa: WPS433

        messages = [
            {"role": "system", "content": _JUDGE_SYSTEM},
            {
                "role": "user",
                "content": _JUDGE_USER_TEMPLATE.format(
                    prompt=prompt, reference=reference, candidate=candidate
                ),
            },
        ]
        call = ClientCall(
            messages=messages,
            tools=None,
            temperature=0.0,
            reasoning_effort="low",
            max_tokens=128,
        )
        resp = await self._client.complete(call)
        raw = (resp.content or "").strip()
        try:
            payload = json.loads(raw)
            raw_score = int(payload["score"])
            rationale = str(payload.get("rationale") or "")
        except (json.JSONDecodeError, KeyError, TypeError, ValueError):
            match = _SCORE_RE.search(raw)
            if not match:
                raise RuntimeError(f"Judge returned unparseable response: {raw!r}")
            raw_score = int(match.group(1))
            rationale = raw[:200]
        clamped = max(1, min(5, raw_score))
        # Normalize 1..5 to 0..1; score=1 maps to 0.0, score=5 maps to 1.0.
        return (clamped - 1) / 4.0, rationale


def build_judge(*, mock: bool, model: str | None) -> Judge:
    if mock:
        raise RuntimeError("Stub judge is disabled for benchmark runs")
    return CerebrasJudge(model=model)
