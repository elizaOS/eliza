"""Feedback generation for the MINT benchmark.

Two modes:

    * ``templated``   : deterministic, no network calls. Used for offline
                        smoke tests + ablation runs.
    * ``llm``         : uses the runtime to call a language model (the paper
                        uses GPT-4). The prompt template is the same one
                        shipped with upstream MINT
                        (``upstream/mint/prompt/templates/template_feedback_agent.txt``)
                        so the resulting feedback shape matches the paper.

Pass ``use_llm=True`` and a compatible runtime to switch modes. The runtime
must satisfy the ``ModelRuntime`` protocol used elsewhere in this package
(``runtime.use_model(...)``).
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Optional, Protocol, runtime_checkable

from benchmarks.mint.types import MINTTask

logger = logging.getLogger(__name__)


_UPSTREAM_TEMPLATE_PATH = (
    Path(__file__).resolve().parent
    / "upstream"
    / "mint"
    / "prompt"
    / "templates"
    / "template_feedback_agent.txt"
)


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

    Defaults to the templated (offline) path. Pass ``use_llm=True`` together
    with a ``runtime`` to use the upstream GPT-4 prompt.
    """

    def __init__(
        self,
        runtime: object | None = None,
        use_llm: bool = False,
        feedback_model: str = "gpt-4",
        mode: Optional[str] = None,
        feedback_form: str = "textual",
        reveal_ground_truth: bool = False,
    ) -> None:
        self.runtime = runtime if isinstance(runtime, ModelRuntime) else None
        if mode is not None:
            self.mode = mode
        else:
            self.mode = "llm" if (use_llm and self.runtime is not None) else "templated"
        self.feedback_model = feedback_model
        self.feedback_form = feedback_form  # "textual" or "binary"
        self.reveal_ground_truth = bool(reveal_ground_truth)
        self._template: Optional[str] = None

    # ------------------------------------------------------------------
    @property
    def template(self) -> str:
        if self._template is None:
            try:
                self._template = _UPSTREAM_TEMPLATE_PATH.read_text(encoding="utf-8")
            except OSError as exc:
                logger.warning(
                    "[FeedbackGenerator] Upstream template missing (%s); "
                    "falling back to inline template.",
                    exc,
                )
                self._template = (
                    "You are an expert tasked with evaluating and providing "
                    "feedback on an assistant's performance.\n\n"
                    "{trajectory}\n\n{correct_solution}\n\n"
                    "Please provide concise constructive feedback without "
                    "revealing the answer.\nExpert feedback:"
                )
        return self._template

    # ------------------------------------------------------------------
    async def generate(
        self,
        task: MINTTask,
        predicted: str,
        turn_num: int,
    ) -> str:
        if self.mode == "llm" and self.runtime is not None:
            text = await self._generate_llm(task, predicted, turn_num)
            if text:
                return text
            logger.info(
                "[FeedbackGenerator] LLM feedback failed; falling back to template."
            )
        return self._templated(task)

    async def _generate_llm(
        self, task: MINTTask, predicted: str, turn_num: int
    ) -> Optional[str]:
        prompt = self._build_llm_prompt(task, predicted, turn_num)
        try:
            response = await self.runtime.use_model(
                self.feedback_model,
                {"prompt": prompt, "temperature": 0.0, "max_tokens": 1024},
            )
            text = (getattr(response, "text", None) or str(response)).strip()
            if self.feedback_form == "binary":
                # Mirror upstream OpenAIFeedbackAgent: extract GOOD/BAD from
                # the first sentence.
                first = text.split(".", 1)[0]
                if "GOOD" in first.upper():
                    return "This is GOOD."
                if "BAD" in first.upper():
                    return "This is BAD."
            return text or None
        except Exception as exc:
            logger.warning("[FeedbackGenerator] LLM feedback raised %s", exc)
            return None

    def _build_llm_prompt(
        self, task: MINTTask, predicted: str, turn_num: int
    ) -> str:
        trajectory = (
            f"Task:\n{task.initial_prompt}\n\n"
            f"Assistant attempt (turn {turn_num + 1}):\n{predicted or '<no answer>'}\n"
        )
        if self.reveal_ground_truth:
            correct = (
                "Correct solution (please DO NOT disclose the correct "
                f"solution to the assistant): {task.ground_truth}\n"
            )
        else:
            correct = (
                "Correct solution (please DO NOT disclose the correct "
                "solution to the assistant): NOT GIVEN\n"
            )
        # ``in_context_example`` and ``tool_desc`` slots are kept empty here
        # because the local agent does not yet thread the upstream in-context
        # examples through; the template still renders sensibly because both
        # slots are documented as optional.
        return self.template.format(
            in_context_example="",
            tool_desc="",
            trajectory=trajectory,
            correct_solution=correct,
        )

    def _templated(self, task: MINTTask) -> str:
        metric = task.evaluation_metric
        if metric == "numeric":
            return (
                "Check the arithmetic carefully and provide only the final "
                "number wrapped in `Final answer:`."
            )
        if metric in {"code_test", "code_output"}:
            return (
                "Run or reason through the code path, satisfy the test "
                "harness, and provide the exact output."
            )
        if metric == "multiple_choice":
            return (
                "Pick the option whose content matches the question; answer "
                "with a single letter (a/b/c/d) prefixed with `Final answer:`."
            )
        if metric == "theoremqa":
            return (
                "Identify the underlying theorem, compute the requested "
                "quantity, and reply with a number, list, or boolean only."
            )
        if metric == "partial_match":
            return (
                "Compare the expected format with your answer and include "
                "the key expected parts."
            )
        return "Re-read the question and answer in the requested final format."
