"""GAIA benchmark agent backed by the eliza TS benchmark server.

Drop-in replacement for ``elizaos_gaia.agent.GAIAAgent`` — exposes a
``solve`` coroutine that takes a ``GAIAQuestion`` and returns a
``GAIAResult``, but each LLM call is routed through
``ElizaClient.send_message`` instead of the Python ``elizaos`` runtime.

This module follows the same pattern as ``eliza_adapter.bfcl`` /
``eliza_adapter.realm`` / ``eliza_adapter.agentbench`` etc.: lazy import
of the host benchmark types via TYPE_CHECKING so the adapter works
regardless of which benchmark sys.path entries the runner has on
``PYTHONPATH``.
"""

from __future__ import annotations

import logging
import re
import time
from typing import TYPE_CHECKING, Optional

from eliza_adapter.client import ElizaClient

if TYPE_CHECKING:
    from elizaos_gaia.types import (
        GAIAConfig,
        GAIAQuestion,
        GAIAResult,
        StepRecord,
    )


def _gaia_types():
    """Lazy import of elizaos_gaia.types — avoids requiring the gaia package
    on sys.path at module load time so this adapter can be imported in
    contexts where only the eliza-adapter site-packages exist.
    """
    from elizaos_gaia.types import (
        GAIAConfig,
        GAIALevel,
        GAIAQuestion,
        GAIAResult,
        StepRecord,
        ToolType,
    )

    return GAIAConfig, GAIALevel, GAIAQuestion, GAIAResult, StepRecord, ToolType


logger = logging.getLogger(__name__)


_FINAL_ANSWER_RE = re.compile(r"FINAL ANSWER\s*:\s*(.+?)(?:\n|$)", re.IGNORECASE | re.DOTALL)


def _extract_final_answer(text: str) -> str:
    if not text:
        return ""
    match = _FINAL_ANSWER_RE.search(text)
    if match:
        # Strip trailing whitespace and quotes
        return match.group(1).strip().strip('"').strip("'")
    return text.strip()


class ElizaGAIAAgent:
    """GAIA agent that delegates the LLM/tool loop to the eliza TS bridge.

    The TS bridge runs an elizaOS ``AgentRuntime`` that owns its own action
    set (web search, code execution, etc.). We hand the question + tool
    metadata to the bridge and let it return a final answer; we extract the
    ``FINAL ANSWER:`` line from the response text or ``params.answer``
    field, and report it back as a ``GAIAResult``.
    """

    def __init__(
        self,
        config: "GAIAConfig",
        client: Optional[ElizaClient] = None,
    ) -> None:
        self.config = config
        self._client = client or ElizaClient()
        self._initialized = False

        # Build a duck-typed model_config object so GAIARunner can read
        # ``self.agent.model_config.provider.value`` / ``model_name`` for
        # output naming without coupling to the providers.ModelConfig
        # dataclass.
        from elizaos_gaia.providers import ModelConfig, ModelProvider

        model_name = config.model_name or "eliza-ts-bridge"
        self.model_config = ModelConfig(
            provider=ModelProvider.ELIZA,
            model_name=model_name,
        )

    async def initialize(self) -> None:
        if self._initialized:
            return
        self._client.wait_until_ready(timeout=120)
        self._initialized = True

    @property
    def model_identifier(self) -> str:
        return f"eliza_{self.model_config.model_name}".replace("/", "_").replace(":", "_")

    async def solve(self, question: "GAIAQuestion") -> "GAIAResult":
        if not self._initialized:
            await self.initialize()

        _, _, _, GAIAResult, StepRecord, _ = _gaia_types()

        start_time = time.time()
        steps: list[StepRecord] = []
        predicted_answer = ""
        error_message: Optional[str] = None

        try:
            # Reset eliza session for this question
            try:
                self._client.reset(task_id=question.task_id, benchmark="gaia")
            except Exception as exc:
                logger.debug("Eliza reset failed (continuing): %s", exc)

            prompt = (
                "You are an ElizaOS agent solving a GAIA benchmark task.\n\n"
                f"Task ID: {question.task_id}\n"
                f"Level: {question.level.value}\n"
                f"Question: {question.question}\n\n"
                "Use whatever actions are available (web search, code "
                "execution, calculator, browse, file read) to find the "
                "answer. When done, respond with:\n"
                "FINAL ANSWER: <your concise answer>\n"
            )
            if question.file_name:
                prompt += f"\nAttached file: {question.file_name}\n"

            response = self._client.send_message(
                text=prompt,
                context={
                    "benchmark": "gaia",
                    "task_id": question.task_id,
                    "level": question.level.value,
                    "question": question.question,
                    "file_name": question.file_name,
                    "file_path": str(question.file_path) if question.file_path else None,
                    "max_iterations": self.config.max_iterations,
                },
            )

            # Prefer params.answer if provided, otherwise parse from text
            if isinstance(response.params.get("answer"), str):
                predicted_answer = str(response.params["answer"]).strip()
            else:
                predicted_answer = _extract_final_answer(response.text or "")

            steps.append(
                StepRecord(
                    step_number=1,
                    action="eliza_bridge_response",
                    reasoning=response.thought or response.text,
                    timestamp_ms=time.time() * 1000,
                    duration_ms=(time.time() - start_time) * 1000,
                    success=bool(predicted_answer),
                )
            )

        except Exception as exc:
            error_message = str(exc)
            logger.error("[eliza-gaia] Question %s failed: %s", question.task_id, exc)

        latency_ms = (time.time() - start_time) * 1000

        return GAIAResult(
            task_id=question.task_id,
            level=question.level,
            question=question.question,
            predicted_answer=predicted_answer,
            expected_answer=question.final_answer,
            is_correct=False,  # Set by evaluator
            steps_taken=steps,
            tools_used=[],
            latency_ms=latency_ms,
            token_usage=0,
            error=error_message,
        )

    async def close(self) -> None:
        self._initialized = False
