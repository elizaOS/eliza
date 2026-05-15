"""Eliza-only harness routing for GAIA."""

from __future__ import annotations

import json
import os
import re
import time
from dataclasses import dataclass
from typing import TYPE_CHECKING

from elizaos_gaia.providers import ModelConfig
from elizaos_gaia.types import GAIAResult

if TYPE_CHECKING:
    from elizaos_gaia.types import GAIAConfig, GAIAQuestion


@dataclass(frozen=True)
class HarnessRoute:
    harness: str
    backend: str


def normalize_harness_label(value: str | None) -> str | None:
    if value is None:
        return None
    normalized = value.strip().lower().replace("_", "-")
    aliases = {
        "eliza": "eliza",
        "eliza-bridge": "eliza",
        "eliza-ts": "eliza",
        "hermes": "hermes",
        "hermes-agent": "hermes",
        "openclaw": "openclaw",
        "open-claw": "openclaw",
    }
    return aliases.get(normalized)


def resolve_harness(
    config: "GAIAConfig | None" = None,
    *,
    explicit: str | None = None,
) -> HarnessRoute:
    requested = explicit or (config.harness if config is not None else None)
    harness = normalize_harness_label(requested) or "eliza"
    if harness != "eliza":
        raise ValueError(f"GAIA does not implement native {harness} harness routing")
    return HarnessRoute(harness="eliza", backend="eliza_ts_bridge")


def harness_env_updates(route: HarnessRoute) -> dict[str, str]:
    if route.harness != "eliza":
        raise ValueError(f"GAIA does not implement native {route.harness} harness routing")
    return {
        "BENCHMARK_HARNESS": route.harness,
        "ELIZA_BENCH_HARNESS": route.harness,
        "BENCHMARK_AGENT": route.harness,
    }


class ElizaBridgeGAIAAgent:
    def __init__(self, config: "GAIAConfig", route: HarnessRoute) -> None:
        self.config = config
        self.route = route
        self.model_config = ModelConfig.from_model_string(
            config.model_name,
            temperature=config.temperature,
            max_tokens=config.max_tokens,
            api_key=config.api_key or "",
            api_base=config.api_base or "",
        )
        self._client = None

    async def solve(self, question: "GAIAQuestion") -> GAIAResult:
        from eliza_adapter.client import ElizaClient

        if self._client is None:
            self._client = ElizaClient()
            self._client.wait_until_ready(timeout=120)

        start = time.time()
        prompt = (
            "Answer the GAIA benchmark question. Return the final answer only.\n\n"
            f"Question: {question.question}"
        )
        response = self._client.send_message(
            text=prompt,
            context={
                "benchmark": "gaia",
                "task_id": question.task_id,
                "question": question.question,
                "level": question.level.value,
                "model_name": self.config.model_name,
            },
        )
        answer = _extract_final_answer(response.text or "", response.params)
        return GAIAResult(
            task_id=question.task_id,
            level=question.level,
            question=question.question,
            predicted_answer=answer,
            expected_answer=question.final_answer,
            is_correct=False,
            latency_ms=(time.time() - start) * 1000,
            token_usage=_latest_telemetry_tokens(),
        )

    async def close(self) -> None:
        self._client = None


def create_gaia_agent(
    config: "GAIAConfig",
    *,
    route: HarnessRoute | None = None,
) -> ElizaBridgeGAIAAgent:
    resolved = route or resolve_harness(config)
    return ElizaBridgeGAIAAgent(config, resolved)


def _extract_final_answer(text: str, params: dict[str, object]) -> str:
    for key in ("FINAL_ANSWER", "ANSWER", "BENCHMARK_ACTION"):
        value = params.get(key)
        if isinstance(value, dict):
            for field in ("answer", "final_answer", "response"):
                inner = value.get(field)
                if isinstance(inner, str) and inner.strip():
                    return inner.strip()
        elif isinstance(value, str) and value.strip():
            return value.strip()

    match = re.search(r"<final_answer>([\s\S]*?)</final_answer>", text, re.IGNORECASE)
    if match:
        return match.group(1).strip()
    return text.strip()


def _latest_telemetry_tokens() -> int:
    path = os.environ.get("BENCHMARK_TELEMETRY_JSONL")
    if not path or not os.path.exists(path):
        return 0
    total = 0
    try:
        with open(path, encoding="utf-8") as handle:
            for line in handle:
                if not line.strip():
                    continue
                row = json.loads(line)
                total = int(row.get("total_tokens") or row.get("totalTokens") or total)
    except Exception:
        return total
    return total
