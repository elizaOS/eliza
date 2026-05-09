"""MINT benchmark agent backed by the eliza benchmark server.

Drop-in replacement for ``benchmarks.mint.agent.MINTAgent`` — same
``solve_task`` interface returning a ``MINTTrajectory``, but each LLM
call is forwarded to the eliza benchmark HTTP server via
``ElizaClient.send_message`` instead of binding a model plugin into a
Python AgentRuntime.

The TS bridge handles state composition and model dispatch; we run
MINT's deterministic multi-turn loop in Python, parsing answers and
optionally executing extracted Python code through the existing
``PythonExecutor``.
"""

from __future__ import annotations

import logging
import os
import time
from typing import TYPE_CHECKING, Optional

from eliza_adapter.client import ElizaClient

if TYPE_CHECKING:
    from benchmarks.mint.executor import PythonExecutor
    from benchmarks.mint.feedback import FeedbackGenerator
    from benchmarks.mint.types import MINTTask, MINTTrajectory


def _mint_imports():
    """Lazy imports of benchmarks.mint.* — avoids requiring the module on sys.path at import."""
    from benchmarks.mint.agent import MINTAgent
    from benchmarks.mint.executor import PythonExecutor
    from benchmarks.mint.feedback import FeedbackGenerator
    from benchmarks.mint.types import MINTTask, MINTTrajectory, Turn, TurnType

    return MINTAgent, PythonExecutor, FeedbackGenerator, MINTTask, MINTTrajectory, Turn, TurnType


logger = logging.getLogger(__name__)


class ElizaMINTAgent:
    """MINT agent that delegates LLM calls to the eliza TS bridge.

    Mirrors :class:`benchmarks.mint.agent.MINTAgent`'s public surface:
      - ``solve_task(task, enable_tools, enable_feedback) -> MINTTrajectory``
      - ``reset_session() -> None``

    Internally it reuses the original ``MINTAgent`` for code-extraction,
    answer-extraction, and answer-checking helpers — but routes the
    "decide what to say next" call through ``ElizaClient.send_message``.
    """

    def __init__(
        self,
        client: ElizaClient | None = None,
        tool_executor: "PythonExecutor | None" = None,
        feedback_generator: "FeedbackGenerator | None" = None,
        temperature: float = 0.0,
    ) -> None:
        MINTAgentCls, PythonExecutorCls, FeedbackGeneratorCls, *_ = _mint_imports()

        self._client = client or ElizaClient()
        self.tool_executor = tool_executor or PythonExecutorCls()
        # Eliza bridge does its own LLM calls — skip the in-process LLM feedback path.
        self.feedback_generator = feedback_generator or FeedbackGeneratorCls(use_llm=False)
        self.temperature = max(0.0, min(1.0, temperature))

        # Reuse helper methods from canonical MINTAgent (regex extractors, answer checker, etc.)
        # Pass runtime=None so the underlying agent stays in mock mode and we never touch it.
        self._helpers = MINTAgentCls(
            runtime=None,
            tool_executor=self.tool_executor,
            feedback_generator=self.feedback_generator,
            temperature=self.temperature,
        )

        self._initialized = False

    async def initialize(self) -> None:
        """Verify the eliza server is reachable."""
        if self._initialized:
            return
        self._client.wait_until_ready(timeout=120)
        self._initialized = True

    def reset_session(self) -> None:
        """Reset for a new task — bridge sessions are keyed per task_id."""
        self._helpers.reset_session()

    async def solve_task(
        self,
        task: "MINTTask",
        enable_tools: bool = True,
        enable_feedback: bool = True,
    ) -> "MINTTrajectory":
        """Solve a MINT task by routing each turn through the eliza TS bridge."""
        if not self._initialized:
            await self.initialize()

        _, _, _, _, MINTTrajectory, Turn, TurnType = _mint_imports()

        logger.info("[eliza-mint] Starting task %s: %s", task.id, task.description)

        trajectory = MINTTrajectory(
            task_id=task.id,
            start_time_ms=time.time() * 1000,
        )

        try:
            self._client.reset(task_id=task.id, benchmark="mint")
        except Exception as exc:
            logger.debug("[eliza-mint] Reset failed (continuing): %s", exc)

        system_prompt = self._helpers._build_system_prompt(task)
        current_prompt = task.initial_prompt

        for turn_num in range(task.max_turns):
            turn_start = time.time() * 1000

            context: dict[str, object] = {
                "benchmark": "mint",
                "task_id": task.id,
                "task_category": task.category.value,
                "task_description": task.description,
                "evaluation_metric": task.evaluation_metric,
                "tools_allowed": list(task.tools_allowed),
                "max_turns": int(task.max_turns),
                "turn": turn_num + 1,
                "system_prompt": system_prompt,
                "enable_tools": bool(enable_tools),
                "enable_feedback": bool(enable_feedback),
            }

            response = self._client.send_message(text=current_prompt, context=context)
            response_text = response.text or ""

            trajectory.turns.append(
                Turn(
                    turn_type=TurnType.ASSISTANT,
                    content=response_text,
                    turn_number=turn_num + 1,
                    timestamp_ms=turn_start,
                )
            )

            # Tool execution: extract code from response and run it via PythonExecutor.
            # The TS bridge delegates benchmark code execution to this Python sidecar.
            code_to_execute: str | None = None
            if enable_tools and "python" in task.tools_allowed:
                code_to_execute = self._helpers._extract_code(response_text)

            if code_to_execute:
                exec_result = await self.tool_executor.execute(code_to_execute)
                trajectory.turns.append(
                    Turn(
                        turn_type=TurnType.TOOL,
                        content=exec_result.output or exec_result.error or "",
                        turn_number=turn_num + 1,
                        tool_call=code_to_execute,
                        tool_result=exec_result.output,
                        tool_success=exec_result.success,
                        timestamp_ms=time.time() * 1000,
                    )
                )
                trajectory.num_tool_uses += 1

                output_preview = (exec_result.output or "")[:500]
                if exec_result.success:
                    current_prompt = (
                        f"Code executed successfully. Output:\n```\n{output_preview}\n```\n\n"
                        f"Now provide your final answer in the exact format requested. "
                        f"End with: Final answer: <YOUR_ANSWER>"
                    )
                else:
                    error_preview = (exec_result.error or "Unknown error")[:300]
                    current_prompt = (
                        f"Code error:\n```\n{error_preview}\n```\n\nPlease fix the code and try again."
                    )
                continue

            predicted_answer = self._helpers._extract_answer(response_text, task)
            if (
                os.environ.get("ELIZA_BENCH_MOCK") == "true"
                and not predicted_answer
                and response.actions == ["BENCHMARK_ACTION"]
            ):
                predicted_answer = self._helpers._local_answer(task)
            trajectory.final_answer = predicted_answer

            if predicted_answer:
                if self._helpers._check_answer(predicted_answer, task):
                    trajectory.success = True
                    logger.info(
                        "[eliza-mint] Task %s: correct answer on turn %d", task.id, turn_num + 1
                    )
                    break

                if enable_feedback and turn_num < task.max_turns - 1:
                    feedback = await self.feedback_generator.generate(
                        task=task,
                        predicted=predicted_answer,
                        turn_num=turn_num,
                    )
                    trajectory.turns.append(
                        Turn(
                            turn_type=TurnType.FEEDBACK,
                            content=feedback,
                            turn_number=turn_num + 1,
                            feedback=feedback,
                            timestamp_ms=time.time() * 1000,
                        )
                    )
                    trajectory.num_feedback_turns += 1
                    current_prompt = (
                        f"Feedback: {feedback}\n\nPlease try again with a different approach."
                    )
                else:
                    logger.info(
                        "[eliza-mint] Task %s: incorrect answer %r", task.id, predicted_answer
                    )
                    break
            else:
                if enable_feedback and turn_num < task.max_turns - 1:
                    feedback = (
                        "I couldn't find a clear answer in your response. "
                        "Please provide a specific answer ending with: Final answer: <YOUR_ANSWER>"
                    )
                    trajectory.turns.append(
                        Turn(
                            turn_type=TurnType.FEEDBACK,
                            content=feedback,
                            turn_number=turn_num + 1,
                            feedback=feedback,
                            timestamp_ms=time.time() * 1000,
                        )
                    )
                    trajectory.num_feedback_turns += 1
                    current_prompt = f"Feedback: {feedback}\n\nPlease try again."

        trajectory.end_time_ms = time.time() * 1000
        return trajectory

    async def close(self) -> None:
        """No-op — the server manager owns subprocess lifecycle."""
        self._initialized = False
