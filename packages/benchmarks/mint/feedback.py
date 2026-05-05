"""Feedback generation for the MINT benchmark."""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from benchmarks.mint.types import MINTTask


@runtime_checkable
class ModelRuntime(Protocol):
    async def use_model(
        self,
        model_type: object,
        params: dict[str, object] | None = None,
        **kwargs: object,
    ) -> object:
        ...


class FeedbackGenerator:
    """Generate feedback between MINT turns.

    The default path is deterministic and local so smoke tests and orchestrator
    runs do not require provider credentials. If a compatible runtime is passed
    with ``use_llm=True``, callers may use an LLM-backed feedback path.
    """

    def __init__(
        self,
        runtime: object | None = None,
        use_llm: bool = False,
        feedback_model: str = "gpt-4",
    ) -> None:
        self.runtime = runtime if isinstance(runtime, ModelRuntime) else None
        self.use_llm = bool(use_llm and self.runtime is not None)
        self.feedback_model = feedback_model

    async def generate(
        self,
        task: MINTTask,
        predicted: str,
        turn_num: int,
    ) -> str:
        """Return concise feedback for an incorrect or missing answer."""
        if self.use_llm and self.runtime is not None:
            prompt = (
                "Give one short hint for this benchmark task without revealing "
                f"the answer.\nTask: {task.initial_prompt}\nAttempt: {predicted}"
            )
            try:
                response = await self.runtime.use_model(
                    self.feedback_model,
                    {"prompt": prompt, "temperature": 0.0},
                )
                text = getattr(response, "text", None) or str(response)
                if text.strip():
                    return text.strip()
            except Exception:
                pass

        metric = task.evaluation_metric
        if metric == "numeric":
            return "Check the arithmetic carefully and provide only the final number."
        if metric == "code_output":
            return "Run or reason through the code path and provide the exact output."
        if metric == "partial_match":
            return "Compare the requested format with your answer and include the key expected parts."
        return "Re-read the question and answer in the requested final format."
