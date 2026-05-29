"""Terminal-Bench agent backed by the smithers harness.

Mirror of :mod:`hermes_adapter.terminal_bench`, swapping
:class:`HermesClient` for the API-compatible :class:`SmithersClient`.
Both clients share the same ``send_message(text, context) -> MessageResponse``,
``reset(task_id, benchmark)`` and ``wait_until_ready(timeout)`` contract, so
the per-turn decision loop is identical. The docker ``TerminalEnvironment`` +
``run_test`` checks remain owned by the upstream ``elizaos_terminal_bench``
runner — this adapter only owns the agent's decision loop.
"""

from __future__ import annotations

import json
import logging
import re
from datetime import datetime
from typing import TYPE_CHECKING, Optional

from smithers_adapter.client import SmithersClient

if TYPE_CHECKING:
    from elizaos_terminal_bench.environment import TerminalEnvironment
    from elizaos_terminal_bench.types import (
        TerminalBenchResult,
        TerminalTask,
    )


def _terminal_types():
    from elizaos_terminal_bench.types import (
        TerminalBenchResult,
        TerminalSession,
        TerminalTask,
    )

    return TerminalBenchResult, TerminalSession, TerminalTask


logger = logging.getLogger(__name__)

_COMMAND_RE = re.compile(r"<command>(.*?)</command>", re.DOTALL | re.IGNORECASE)
_BASH_FENCE_RE = re.compile(r"```(?:bash|sh)?\s*\n(.*?)```", re.DOTALL | re.IGNORECASE)


_SHELL_TOOL_NAMES = {
    "bash",
    "shell",
    "run_shell",
    "run_shell_command",
    "execute_shell",
    "exec",
}


def _extract_command_from_text(text: str) -> Optional[str]:
    if not text:
        return None
    match = _COMMAND_RE.search(text)
    if match:
        return match.group(1).strip()
    match = _BASH_FENCE_RE.search(text)
    if match:
        return match.group(1).strip()
    return None


def _extract_command_from_tool_calls(params: dict) -> Optional[str]:
    """Pull a shell command out of OpenAI-style tool_calls."""
    raw_calls = params.get("tool_calls") if isinstance(params, dict) else None
    if not isinstance(raw_calls, list):
        return None
    for entry in raw_calls:
        if not isinstance(entry, dict):
            continue
        name = str(entry.get("name") or "").strip().lower()
        if name not in _SHELL_TOOL_NAMES:
            continue
        args = entry.get("arguments")
        if isinstance(args, str):
            try:
                parsed = json.loads(args)
            except json.JSONDecodeError:
                if args.strip():
                    return args.strip()
                continue
            args = parsed
        if isinstance(args, dict):
            for key in ("command", "cmd", "script", "shell_command"):
                value = args.get(key)
                if isinstance(value, str) and value.strip():
                    return value.strip()
    return None


def _signals_complete(text: str, params: dict) -> bool:
    if isinstance(params.get("complete"), bool) and params["complete"]:
        return True
    if not text:
        return False
    upper = text.upper()
    return "TASK_COMPLETE" in upper or "TASK COMPLETE" in upper


_BASH_TOOL_SPEC = {
    "type": "function",
    "function": {
        "name": "bash",
        "description": (
            "Execute a single shell command inside the Terminal-Bench Docker "
            "container. Returns the command's stdout, stderr, and exit code."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "description": "The shell command to execute.",
                },
            },
            "required": ["command"],
        },
    },
}


class SmithersTerminalAgent:
    """Terminal-Bench agent that routes its decision loop through smithers.

    Same ``solve_task(task) -> TerminalBenchResult`` interface as
    :class:`hermes_adapter.terminal_bench.HermesTerminalAgent` so the upstream
    runner can swap in this implementation by harness.
    """

    def __init__(
        self,
        environment: "TerminalEnvironment",
        max_iterations: int = 20,
        model_name: str | None = None,
        client: Optional[SmithersClient] = None,
        verbose: bool = False,
    ) -> None:
        self._environment = environment
        self._max_iterations = max_iterations
        self._model_name = model_name or "smithers-agent"
        self._client = client or SmithersClient()
        self._verbose = verbose
        self._initialized = False
        self._last_session = None
        # Stateless per send_message — every turn carries the full conversation
        # in context["messages"]. ``_history`` accumulates the OpenAI-shape
        # transcript for this task.
        self._history: list[dict[str, object]] = []

    async def _initialize(self) -> None:
        if self._initialized:
            return
        self._client.wait_until_ready(timeout=120)
        self._initialized = True

    def _reset_history(self, instruction: str) -> None:
        system = (
            "You are an AI agent solving a Terminal-Bench task in a Docker "
            "container. Prefer the `bash` tool to execute shell commands. "
            "If native tool calls are unavailable, respond with the next shell "
            "command wrapped in <command>...</command> tags. When you believe "
            "the task is complete, respond with TASK_COMPLETE."
        )
        self._history = [
            {"role": "system", "content": system},
            {"role": "user", "content": f"Task: {instruction}"},
        ]

    def _record_assistant(self, text: str, command: Optional[str]) -> None:
        entry: dict[str, object] = {"role": "assistant", "content": text or ""}
        if command:
            entry["tool_calls"] = [
                {
                    "id": f"call_{len(self._history)}",
                    "type": "function",
                    "function": {
                        "name": "bash",
                        "arguments": json.dumps({"command": command}),
                    },
                }
            ]
            if not text:
                entry["content"] = None
        self._history.append(entry)

    def _record_tool_result(self, command: str, feedback: str) -> None:
        call_id = f"call_{len(self._history) - 1}"
        self._history.append(
            {
                "role": "tool",
                "tool_call_id": call_id,
                "name": "bash",
                "content": feedback,
            }
        )

    def _record_user_followup(self, feedback: str) -> None:
        self._history.append({"role": "user", "content": feedback})

    async def solve_task(self, task: "TerminalTask") -> "TerminalBenchResult":
        await self._initialize()

        TerminalBenchResult, TerminalSession, _ = _terminal_types()

        session = TerminalSession(
            session_id=(
                f"smithers_terminal_{task.task_id}_"
                f"{datetime.now().strftime('%Y%m%d_%H%M%S')}"
            ),
            task=task,
            commands=[],
            working_directory="/workspace",
            environment_vars={},
            start_time=datetime.now(),
        )
        self._last_session = session

        try:
            self._client.reset(task_id=task.task_id, benchmark="terminal_bench")
        except Exception as exc:  # noqa: BLE001 — reset is best-effort
            logger.debug("smithers reset failed (continuing): %s", exc)

        self._reset_history(task.instruction)

        task_complete = False
        test_success = False
        test_output = ""
        test_exit_code = 1
        error_message: Optional[str] = None

        try:
            for iteration in range(self._max_iterations):
                context: dict[str, object] = {
                    "benchmark": "terminal_bench",
                    "task_id": task.task_id,
                    "session_id": session.session_id,
                    "category": task.category.value,
                    "difficulty": task.difficulty.value,
                    "instruction": task.instruction,
                    "iteration": iteration,
                    "messages": list(self._history),
                    "tools": [_BASH_TOOL_SPEC],
                    "tool_choice": "auto",
                    "_stateless": True,
                }

                last_user = ""
                for msg in reversed(self._history):
                    if msg.get("role") == "user":
                        last_user = str(msg.get("content") or "")
                        break

                response = self._client.send_message(text=last_user, context=context)
                text = response.text or ""
                session.model_responses.append(text)

                if _signals_complete(text, response.params):
                    self._record_assistant(text, None)
                    test_success, test_output, test_exit_code = (
                        await self._environment.run_test(task.test_script)
                    )
                    if test_success:
                        task_complete = True
                        break
                    self._record_user_followup(
                        f"Task verification FAILED (exit code {test_exit_code}).\n"
                        f"Test output:\n{test_output}\n\n"
                        f"Please fix the issue and try again."
                    )
                    continue

                command = _extract_command_from_tool_calls(response.params)
                if not command:
                    command = _extract_command_from_text(text)

                if not command:
                    self._record_assistant(text, None)
                    self._record_user_followup(
                        "No command was provided. Use the `bash` tool with a JSON "
                        "`command` argument, or wrap the next shell command in "
                        "<command>...</command>."
                    )
                    continue

                self._record_assistant(text, command)
                session.tool_calls.append(
                    {
                        "type": "command",
                        "name": "terminal.execute",
                        "params": {"command": command},
                        "command": command,
                    }
                )
                cmd_result = await self._environment.execute(command)
                session.commands.append(cmd_result)
                feedback = (
                    f"$ {command}\n"
                    f"exit={cmd_result.exit_code}\n"
                    f"stdout={cmd_result.stdout[:2000]}\n"
                    f"stderr={cmd_result.stderr[:1000]}"
                )
                self._record_tool_result(command, feedback)

            if not task_complete:
                test_success, test_output, test_exit_code = (
                    await self._environment.run_test(task.test_script)
                )

        except Exception as exc:  # noqa: BLE001 — surface to result
            error_message = str(exc)
            logger.error(
                "[smithers-terminal] Task %s failed: %s", task.task_id, exc
            )

        session.end_time = datetime.now()
        session.final_test_output = test_output
        session.final_test_exit_code = test_exit_code
        total_execution_time = sum(c.execution_time_ms for c in session.commands)

        return TerminalBenchResult(
            task_id=task.task_id,
            success=test_success,
            commands_executed=len(session.commands),
            total_execution_time_ms=total_execution_time,
            test_output=test_output,
            test_exit_code=test_exit_code,
            error_message=error_message,
            tokens_used=0,
            session=session,
            category=task.category,
            difficulty=task.difficulty,
        )

    async def cleanup(self) -> None:
        self._initialized = False
        self._history = []


def build_terminal_bench_agent_fn(
    *,
    environment: "TerminalEnvironment",
    client: SmithersClient | None = None,
    max_iterations: int = 20,
    model_name: str | None = None,
    verbose: bool = False,
) -> SmithersTerminalAgent:
    """Factory matching the ``build_<bench>_agent_fn`` shape of the hermes adapter."""
    return SmithersTerminalAgent(
        environment=environment,
        max_iterations=max_iterations,
        model_name=model_name,
        client=client,
        verbose=verbose,
    )


__all__ = [
    "SmithersTerminalAgent",
    "build_terminal_bench_agent_fn",
]
