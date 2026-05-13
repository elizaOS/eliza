"""Terminal-Bench agent backed by the OpenClaw CLI.

Mirrors :class:`eliza_adapter.terminal_bench.ElizaBridgeTerminalAgent` but
routes per-turn decision-making through :class:`OpenClawClient` rather
than the elizaOS TypeScript benchmark HTTP server.

OpenClaw runs as a separate process and is fully stateless across
spawns, so the adapter threads the conversation history into the prompt
explicitly each turn. The eliza bridge keeps history server-side via the
``task_id`` session; here the prompt grows linearly with iteration count.

OpenClaw's CLI does not reliably honor OpenAI ``tools=`` / ``tool_choice``,
so the primary command-extraction path is the ``<command>...</command>``
XML the prompt instructs the model to emit. Tool-call parsing is kept as
a fallback for builds that do surface OpenAI-shape ``tool_calls``.

The docker ``TerminalEnvironment`` + ``run_test`` checks remain owned by
the upstream ``elizaos_terminal_bench`` runner.
"""

from __future__ import annotations

import json
import logging
import re
from datetime import datetime
from typing import TYPE_CHECKING, Optional

from openclaw_adapter.client import OpenClawClient

if TYPE_CHECKING:
    from elizaos_terminal_bench.environment import TerminalEnvironment
    from elizaos_terminal_bench.types import (
        TerminalBenchResult,
        TerminalSession,
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
    m = _COMMAND_RE.search(text)
    if m:
        return m.group(1).strip()
    m = _BASH_FENCE_RE.search(text)
    if m:
        return m.group(1).strip()
    return None


def _extract_command_from_tool_calls(params: dict) -> Optional[str]:
    """Best-effort: pull a shell command out of OpenAI-shape tool_calls."""
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


def _render_history(history: list[dict[str, str]]) -> str:
    """Render the conversation history into a single prompt-side transcript."""
    lines: list[str] = []
    for turn in history:
        role = turn.get("role", "user")
        content = turn.get("content", "")
        if not content:
            continue
        lines.append(f"[{role.upper()}]\n{content}")
    return "\n\n".join(lines)


_SYSTEM_PROMPT = (
    "You are an AI agent solving a Terminal-Bench task in a Docker container. "
    "Respond with the next shell command wrapped in <command>...</command> "
    "tags. When you believe the task is complete, respond with TASK_COMPLETE. "
    "Do not emit tool_calls — use the XML command tag exclusively."
)


class OpenClawTerminalAgent:
    """Terminal-Bench agent that routes its decision loop through OpenClaw CLI.

    Same ``solve_task(task) -> TerminalBenchResult`` interface as the
    eliza adapter so the upstream runner can swap in this implementation
    by harness.
    """

    def __init__(
        self,
        environment: "TerminalEnvironment",
        max_iterations: int = 20,
        model_name: str | None = None,
        client: Optional[OpenClawClient] = None,
        verbose: bool = False,
    ) -> None:
        self._environment = environment
        self._max_iterations = max_iterations
        self._model_name = model_name or "openclaw"
        self._client = client or OpenClawClient()
        self._verbose = verbose
        # OpenClaw is stateless per send_message — every turn embeds the
        # full conversation in the user-side prompt.
        self._history: list[dict[str, str]] = []

    async def _initialize(self) -> None:
        # OpenClawClient does not require warm-up beyond CLI availability;
        # the spawn-on-call cost is paid per send_message.
        return None

    def _reset_history(self, instruction: str) -> None:
        self._history = [
            {"role": "user", "content": f"Task: {instruction}"},
        ]

    def _record(self, role: str, content: str) -> None:
        self._history.append({"role": role, "content": content})

    async def solve_task(self, task: "TerminalTask") -> "TerminalBenchResult":
        await self._initialize()

        TerminalBenchResult, TerminalSession, _ = _terminal_types()

        session = TerminalSession(
            session_id=(
                f"openclaw_terminal_{task.task_id}_"
                f"{datetime.now().strftime('%Y%m%d_%H%M%S')}"
            ),
            task=task,
            commands=[],
            working_directory="/workspace",
            environment_vars={},
            start_time=datetime.now(),
        )

        try:
            self._client.reset(task_id=task.task_id, benchmark="terminal_bench")
        except Exception as exc:  # noqa: BLE001 — best-effort
            logger.debug("openclaw reset failed (continuing): %s", exc)

        self._reset_history(task.instruction)

        task_complete = False
        test_success = False
        test_output = ""
        test_exit_code = 1
        error_message: Optional[str] = None

        try:
            for iteration in range(self._max_iterations):
                transcript = _render_history(self._history)
                prompt = (
                    f"{transcript}\n\n[ASSISTANT]\n"
                    "Provide the next <command>...</command> or respond "
                    "with TASK_COMPLETE if you are done."
                )

                context: dict[str, object] = {
                    "benchmark": "terminal_bench",
                    "task_id": task.task_id,
                    "session_id": session.session_id,
                    "category": task.category.value,
                    "difficulty": task.difficulty.value,
                    "iteration": iteration,
                    "system_prompt": _SYSTEM_PROMPT,
                    "_stateless": True,
                }

                response = self._client.send_message(text=prompt, context=context)
                text = response.text or ""

                if _signals_complete(text, response.params):
                    self._record("assistant", text)
                    test_success, test_output, test_exit_code = (
                        await self._environment.run_test(task.test_script)
                    )
                    if test_success:
                        task_complete = True
                        break
                    self._record(
                        "user",
                        f"Task verification FAILED (exit code {test_exit_code}).\n"
                        f"Test output:\n{test_output}\n\n"
                        f"Please fix the issue and try again.",
                    )
                    continue

                # Primary: <command> XML. Fallback: tool_calls if any.
                command = _extract_command_from_text(text)
                if not command:
                    command = _extract_command_from_tool_calls(response.params)

                if not command:
                    self._record("assistant", text)
                    self._record(
                        "user",
                        "No command was provided. Please wrap the next shell "
                        "command in <command>...</command>.",
                    )
                    continue

                self._record("assistant", text)
                cmd_result = await self._environment.execute(command)
                session.commands.append(cmd_result)
                feedback = (
                    f"$ {command}\n"
                    f"exit={cmd_result.exit_code}\n"
                    f"stdout={cmd_result.stdout[:2000]}\n"
                    f"stderr={cmd_result.stderr[:1000]}"
                )
                self._record("user", f"Previous command result:\n{feedback}")

            if not task_complete:
                test_success, test_output, test_exit_code = (
                    await self._environment.run_test(task.test_script)
                )

        except Exception as exc:  # noqa: BLE001
            error_message = str(exc)
            logger.error(
                "[openclaw-terminal] Task %s failed: %s", task.task_id, exc
            )

        session.end_time = datetime.now()
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
        self._history = []


def build_terminal_bench_agent_fn(
    *,
    environment: "TerminalEnvironment",
    client: OpenClawClient | None = None,
    max_iterations: int = 20,
    model_name: str | None = None,
    verbose: bool = False,
) -> OpenClawTerminalAgent:
    """Factory matching the ``build_<bench>_agent_fn`` shape of the BFCL adapter.

    Returns an :class:`OpenClawTerminalAgent` bound to the supplied
    ``TerminalEnvironment``. The runner is responsible for `.start(task)` /
    `.stop()` lifecycle on that environment.
    """
    return OpenClawTerminalAgent(
        environment=environment,
        max_iterations=max_iterations,
        model_name=model_name,
        client=client,
        verbose=verbose,
    )


__all__ = [
    "OpenClawTerminalAgent",
    "build_terminal_bench_agent_fn",
]
