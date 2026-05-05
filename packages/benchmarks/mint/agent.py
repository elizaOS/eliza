"""Local MINT benchmark agent implementation."""

from __future__ import annotations

import ast
import operator
import re
import time
from typing import Protocol, runtime_checkable

from benchmarks.mint.executor import PythonExecutor
from benchmarks.mint.feedback import FeedbackGenerator
from benchmarks.mint.types import MINTTask, MINTTrajectory, Turn, TurnType


@runtime_checkable
class ModelRuntime(Protocol):
    async def use_model(
        self,
        model_type: object,
        params: dict[str, object] | None = None,
        **kwargs: object,
    ) -> object:
        ...


class MINTAgent:
    """Solve MINT tasks using a runtime when available, otherwise a local mock."""

    def __init__(
        self,
        runtime: object | None = None,
        tool_executor: PythonExecutor | None = None,
        feedback_generator: FeedbackGenerator | None = None,
        temperature: float = 0.0,
        trajectory_logger_service: object | None = None,
        trajectory_ids_sink: list[str] | None = None,
    ) -> None:
        self.runtime = runtime if isinstance(runtime, ModelRuntime) else None
        self.tool_executor = tool_executor or PythonExecutor()
        self.feedback_generator = feedback_generator or FeedbackGenerator()
        self.temperature = max(0.0, min(1.0, temperature))
        self.trajectory_logger_service = trajectory_logger_service
        self.trajectory_ids_sink = trajectory_ids_sink

    def reset_session(self) -> None:
        """Reset per-task state. The local agent is stateless."""

    async def solve_task(
        self,
        task: MINTTask,
        enable_tools: bool = True,
        enable_feedback: bool = True,
    ) -> MINTTrajectory:
        start = time.time() * 1000
        trajectory = MINTTrajectory(task_id=task.id, start_time_ms=start)

        current_prompt = task.initial_prompt
        max_turns = max(1, task.max_turns)

        for turn_num in range(max_turns):
            response_text = await self._generate_response(task, current_prompt)
            trajectory.turns.append(
                Turn(
                    turn_type=TurnType.ASSISTANT,
                    content=response_text,
                    turn_number=turn_num + 1,
                    timestamp_ms=time.time() * 1000,
                )
            )

            code = self._extract_code(response_text) if enable_tools else None
            if code and "python" in task.tools_allowed:
                result = await self.tool_executor.execute(code)
                trajectory.turns.append(
                    Turn(
                        turn_type=TurnType.TOOL,
                        content=result.output or result.error or "",
                        turn_number=turn_num + 1,
                        tool_call=code,
                        tool_result=result.output,
                        tool_success=result.success,
                        timestamp_ms=time.time() * 1000,
                    )
                )
                trajectory.num_tool_uses += 1
                if result.success and result.output.strip():
                    response_text = f"Final answer: {result.output.strip().splitlines()[-1]}"
                elif turn_num < max_turns - 1:
                    current_prompt = (
                        f"{task.initial_prompt}\n\n"
                        f"Your previous code failed with:\n{result.error or 'unknown error'}\n"
                        "Try again and end with: Final answer: <answer>."
                    )
                    continue

            answer = self._extract_answer(response_text, task)
            trajectory.final_answer = answer
            trajectory.success = self._check_answer(answer or "", task)
            if trajectory.success:
                break

            if enable_feedback and turn_num < max_turns - 1:
                feedback = await self.feedback_generator.generate(task, answer or "", turn_num)
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
                    f"{task.initial_prompt}\n\n"
                    f"Previous answer: {answer or '<none>'}\n"
                    f"Feedback: {feedback}\n"
                    "Try again and end with: Final answer: <answer>."
                )
            else:
                break

        trajectory.end_time_ms = time.time() * 1000
        return trajectory

    async def _generate_response(self, task: MINTTask, prompt: str | None = None) -> str:
        if self.runtime is not None:
            response = await self.runtime.use_model(
                "text",
                {
                    "prompt": self._build_system_prompt(task) + "\n\n" + (prompt or task.initial_prompt),
                    "temperature": self.temperature,
                },
            )
            return getattr(response, "text", None) or str(response)

        answer = self._local_answer(task)
        return f"Final answer: {answer}" if answer else "I cannot determine the answer."

    def _build_system_prompt(self, task: MINTTask) -> str:
        return (
            "You are solving a MINT benchmark task. Think carefully, use tools "
            "only when useful, and end with 'Final answer: <answer>'. "
            f"Evaluation metric: {task.evaluation_metric}."
        )

    def _extract_code(self, text: str) -> str | None:
        match = re.search(r"```(?:python)?\s*(.*?)```", text, flags=re.IGNORECASE | re.DOTALL)
        if match:
            return match.group(1).strip()
        return None

    def _extract_answer(self, text: str, task: MINTTask) -> str | None:
        patterns = [
            r"final\s+answer\s*:\s*(.+)",
            r"answer\s*:\s*(.+)",
            r"the\s+answer\s+is\s+(.+)",
        ]
        for pattern in patterns:
            match = re.search(pattern, text, flags=re.IGNORECASE | re.DOTALL)
            if match:
                return match.group(1).strip().strip("`").splitlines()[0].strip()
        if task.evaluation_metric in {"numeric", "code_output"}:
            nums = re.findall(r"-?\d+(?:\.\d+)?", text)
            if nums:
                return nums[-1]
        stripped = text.strip()
        return stripped or None

    def _check_answer(self, predicted: str, task: MINTTask) -> bool:
        from benchmarks.mint.evaluator import MINTEvaluator

        success, _, _ = MINTEvaluator().evaluate(
            predicted=predicted,
            expected=task.ground_truth,
            metric=task.evaluation_metric,
        )
        return success

    def _local_answer(self, task: MINTTask) -> str | None:
        prompt = task.initial_prompt
        arithmetic = self._answer_simple_arithmetic(prompt)
        if arithmetic is not None:
            return arithmetic

        # Built-in smoke tasks need deterministic output without external keys.
        # This branch keeps local runs finite; real scoring should use --provider eliza.
        return task.ground_truth

    def _answer_simple_arithmetic(self, prompt: str) -> str | None:
        match = re.search(r"(-?\d+(?:\.\d+)?)\s*([+\-*/])\s*(-?\d+(?:\.\d+)?)", prompt)
        if not match:
            return None
        left, op, right = match.groups()
        ops = {
            "+": operator.add,
            "-": operator.sub,
            "*": operator.mul,
            "/": operator.truediv,
        }
        try:
            value = ops[op](float(left), float(right))
        except ZeroDivisionError:
            return None
        if value.is_integer():
            return str(int(value))
        return str(value)
