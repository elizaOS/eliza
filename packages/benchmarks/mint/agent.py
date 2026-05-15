"""Local MINT benchmark agent implementation.

Records per-turn proposed answers so the metrics layer can compute the
canonical MINT Turn-1 / Turn-3 / Turn-5 success rates. The ground-truth
mock is disabled by default and must be explicitly opted into.
"""

from __future__ import annotations

import operator
import re
import time
from typing import Any, Awaitable, Callable, Protocol, runtime_checkable

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
    """Solve MINT tasks via a runtime if available, otherwise local heuristics."""

    def __init__(
        self,
        runtime: object | None = None,
        tool_executor: PythonExecutor | None = None,
        feedback_generator: FeedbackGenerator | None = None,
        temperature: float = 0.0,
        trajectory_logger_service: object | None = None,
        trajectory_ids_sink: list[str] | None = None,
        allow_ground_truth_mock: bool = False,
    ) -> None:
        self.runtime = runtime if isinstance(runtime, ModelRuntime) else None
        self.tool_executor = tool_executor or PythonExecutor()
        self.feedback_generator = feedback_generator or FeedbackGenerator()
        self.temperature = max(0.0, min(1.0, temperature))
        self.trajectory_logger_service = trajectory_logger_service
        self.trajectory_ids_sink = trajectory_ids_sink
        # Off by default — used to be True in some call sites which made the
        # agent score directly from labels. Callers must opt in explicitly.
        self.allow_ground_truth_mock = bool(allow_ground_truth_mock)

    def reset_session(self) -> None:
        """Per-task reset. The local agent is stateless."""

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
            assistant_turn = Turn(
                turn_type=TurnType.ASSISTANT,
                content=response_text,
                turn_number=turn_num + 1,
                timestamp_ms=time.time() * 1000,
            )
            trajectory.turns.append(assistant_turn)

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
                    # Failure — record "no answer this turn" and retry.
                    trajectory.per_turn_answers.append(None)
                    trajectory.per_turn_success.append(False)
                    current_prompt = (
                        f"{task.initial_prompt}\n\n"
                        f"Your previous code failed with:\n{result.error or 'unknown error'}\n"
                        "Try again and end with: Final answer: <answer>."
                    )
                    continue

            answer = self._extract_answer(response_text, task)
            trajectory.per_turn_answers.append(answer)
            assistant_turn.proposed_solution = answer is not None
            success = self._check_answer(answer or "", task) if answer else False
            trajectory.per_turn_success.append(success)
            trajectory.final_answer = answer
            trajectory.success = success
            if success:
                break

            if enable_feedback and turn_num < max_turns - 1:
                feedback = await self.feedback_generator.generate(
                    task, answer or "", turn_num
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
                    f"{task.initial_prompt}\n\n"
                    f"Previous answer: {answer or '<none>'}\n"
                    f"Feedback: {feedback}\n"
                    "Try again and end with: Final answer: <answer>."
                )
            else:
                break

        trajectory.end_time_ms = time.time() * 1000
        return trajectory

    async def _generate_response(
        self, task: MINTTask, prompt: str | None = None
    ) -> str:
        if self.runtime is not None:
            response = await self.runtime.use_model(
                "text",
                {
                    "prompt": self._build_system_prompt(task)
                    + "\n\n"
                    + (prompt or task.initial_prompt),
                    "temperature": self.temperature,
                },
            )
            return getattr(response, "text", None) or str(response)

        answer = self._local_answer(task)
        return f"Final answer: {answer}" if answer else "I cannot determine the answer."

    def _build_system_prompt(self, task: MINTTask) -> str:
        return (
            "You are solving a MINT benchmark task. Think carefully, use "
            "tools only when useful, and end with 'Final answer: <answer>'. "
            f"Evaluation metric: {task.evaluation_metric}."
        )

    def _extract_code(self, text: str) -> str | None:
        match = re.search(
            r"```(?:python)?\s*(.*?)```", text, flags=re.IGNORECASE | re.DOTALL
        )
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
            task=task,
        )
        return success

    def _local_answer(self, task: MINTTask) -> str | None:
        prompt = task.initial_prompt
        arithmetic = self._answer_simple_arithmetic(prompt)
        if arithmetic is not None:
            return arithmetic

        if self.allow_ground_truth_mock:
            # Opt-in only. Useful for smoke tests that exercise the full
            # multi-turn protocol without paying for a real provider.
            return task.ground_truth

        return None

    def _answer_simple_arithmetic(self, prompt: str) -> str | None:
        match = re.search(
            r"(-?\d+(?:\.\d+)?)\s*([+\-*/])\s*(-?\d+(?:\.\d+)?)", prompt
        )
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


AgentFn = Callable[
    [list[dict[str, Any]], list[dict[str, Any]]],
    Awaitable[dict[str, Any]],
]


class AgentFnMINTAgent:
    """MINT agent wrapper for Hermes/OpenClaw-style async agent functions."""

    def __init__(
        self,
        agent_fn: AgentFn,
        tool_executor: PythonExecutor | None = None,
        feedback_generator: FeedbackGenerator | None = None,
        temperature: float = 0.0,
    ) -> None:
        self.agent_fn = agent_fn
        self.tool_executor = tool_executor or PythonExecutor()
        self.feedback_generator = feedback_generator or FeedbackGenerator(use_llm=False)
        self._helpers = MINTAgent(
            runtime=None,
            tool_executor=self.tool_executor,
            feedback_generator=self.feedback_generator,
            temperature=temperature,
        )

    def reset_session(self) -> None:
        self._helpers.reset_session()

    async def solve_task(
        self,
        task: MINTTask,
        enable_tools: bool = True,
        enable_feedback: bool = True,
    ) -> MINTTrajectory:
        start = time.time() * 1000
        trajectory = MINTTrajectory(task_id=task.id, start_time_ms=start)
        max_turns = max(1, task.max_turns)
        history: list[dict[str, Any]] = [
            {"role": "system", "content": self._helpers._build_system_prompt(task)},
            {"role": "user", "content": task.initial_prompt},
        ]
        tools = _mint_tool_schemas(task) if enable_tools else []

        for turn_num in range(max_turns):
            response = await self.agent_fn(history, tools)
            response_text = str(response.get("text") or response.get("content") or "")
            tool_calls = _normalize_agent_fn_tool_calls(response.get("tool_calls"))

            assistant_turn = Turn(
                turn_type=TurnType.ASSISTANT,
                content=response_text,
                turn_number=turn_num + 1,
                timestamp_ms=time.time() * 1000,
            )
            trajectory.turns.append(assistant_turn)
            assistant_history: dict[str, Any] = {
                "role": "assistant",
                "content": response_text,
            }
            if tool_calls:
                assistant_history["tool_calls"] = tool_calls
            history.append(assistant_history)

            code = None
            if enable_tools and "python" in task.tools_allowed:
                code = _code_from_tool_calls(tool_calls)
                if code is None:
                    code = self._helpers._extract_code(response_text)
                    if code is not None:
                        tool_calls = [_synthetic_python_tool_call(code)]
                        assistant_history["tool_calls"] = tool_calls
                        if not assistant_history["content"]:
                            assistant_history["content"] = None
            if code:
                exec_result = await self.tool_executor.execute(code)
                tool_content = exec_result.output or exec_result.error or ""
                trajectory.turns.append(
                    Turn(
                        turn_type=TurnType.TOOL,
                        content=tool_content,
                        turn_number=turn_num + 1,
                        tool_call=code,
                        tool_result=exec_result.output,
                        tool_success=exec_result.success,
                        timestamp_ms=time.time() * 1000,
                    )
                )
                trajectory.num_tool_uses += 1
                history.append(
                    {
                        "role": "tool",
                        "tool_call_id": _first_tool_call_id(tool_calls),
                        "name": "python",
                        "content": tool_content,
                    }
                )
                if turn_num < max_turns - 1:
                    trajectory.per_turn_answers.append(None)
                    trajectory.per_turn_success.append(False)
                    history.append(
                        {
                            "role": "user",
                            "content": (
                                "Tool output:\n"
                                f"{tool_content[:1000]}\n\n"
                                "Now provide the final answer. End with: "
                                "Final answer: <answer>."
                            ),
                        }
                    )
                    continue

            answer = self._helpers._extract_answer(response_text, task)
            trajectory.per_turn_answers.append(answer)
            assistant_turn.proposed_solution = answer is not None
            success = self._helpers._check_answer(answer or "", task) if answer else False
            trajectory.per_turn_success.append(success)
            trajectory.final_answer = answer
            trajectory.success = success
            if success:
                break

            if enable_feedback and turn_num < max_turns - 1:
                feedback = await self.feedback_generator.generate(
                    task=task,
                    predicted=answer or "",
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
                history.append(
                    {
                        "role": "user",
                        "content": (
                            f"Feedback: {feedback}\n\n"
                            "Try again and end with: Final answer: <answer>."
                        ),
                    }
                )
            else:
                break

        trajectory.end_time_ms = time.time() * 1000
        return trajectory


def _mint_tool_schemas(task: MINTTask) -> list[dict[str, Any]]:
    if "python" not in task.tools_allowed:
        return []
    return [
        {
            "type": "function",
            "function": {
                "name": "python",
                "description": "Execute Python code and return stdout or an error.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "code": {
                            "type": "string",
                            "description": "Python code to execute.",
                        }
                    },
                    "required": ["code"],
                },
            },
        }
    ]


def _normalize_agent_fn_tool_calls(raw: object) -> list[dict[str, Any]]:
    if not isinstance(raw, list):
        return []
    calls: list[dict[str, Any]] = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        function = entry.get("function")
        if not isinstance(function, dict):
            function = {
                "name": entry.get("name"),
                "arguments": entry.get("arguments", {}),
            }
        name = function.get("name")
        if not isinstance(name, str) or not name:
            continue
        arguments = function.get("arguments", {})
        if isinstance(arguments, str):
            import json

            try:
                arguments = json.loads(arguments)
            except json.JSONDecodeError:
                arguments = {}
        if not isinstance(arguments, dict):
            arguments = {}
        calls.append(
            {
                "id": str(entry.get("id") or f"call_{len(calls)}"),
                "type": "function",
                "function": {
                    "name": name,
                    "arguments": arguments,
                },
            }
        )
    return calls


def _code_from_tool_calls(tool_calls: list[dict[str, Any]]) -> str | None:
    for call in tool_calls:
        function = call.get("function")
        if not isinstance(function, dict):
            continue
        name = str(function.get("name") or "").lower()
        if name not in {"python", "python_repl", "execute_python", "run_python"}:
            continue
        arguments = function.get("arguments", {})
        if not isinstance(arguments, dict):
            continue
        for key in ("code", "script", "program", "input"):
            value = arguments.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
    return None


def _synthetic_python_tool_call(code: str) -> dict[str, Any]:
    return {
        "id": "call_python_text_0",
        "type": "function",
        "function": {
            "name": "python",
            "arguments": {"code": code},
        },
    }


def _first_tool_call_id(tool_calls: list[dict[str, Any]]) -> str:
    if not tool_calls:
        return "call_0"
    return str(tool_calls[0].get("id") or "call_0")
