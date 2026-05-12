"""Terminal-Bench agent backed by the eliza TS benchmark server.

Drop-in replacement for ``elizaos_terminal_bench.eliza_agent.ElizaTerminalAgent``
when running with ``--model-provider eliza``. Each iteration sends the
task description plus the latest tool feedback to the eliza TS bridge
via ``ElizaClient.send_message`` and parses the next shell command (or
TASK_COMPLETE marker) out of the response. The Docker
``TerminalEnvironment`` execution + ``run_test`` checks remain unchanged.
"""

from __future__ import annotations

import logging
import re
import time
from datetime import datetime
from typing import TYPE_CHECKING, Optional

from eliza_adapter.client import ElizaClient

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


def _extract_command(text: str) -> Optional[str]:
    if not text:
        return None
    m = _COMMAND_RE.search(text)
    if m:
        return m.group(1).strip()
    m = _BASH_FENCE_RE.search(text)
    if m:
        return m.group(1).strip()
    return None


def _signals_complete(text: str, params: dict) -> bool:
    if isinstance(params.get("complete"), bool) and params["complete"]:
        return True
    if not text:
        return False
    upper = text.upper()
    return "TASK_COMPLETE" in upper or "TASK COMPLETE" in upper


def _command_from_params(params: dict) -> Optional[str]:
    raw = params.get("command")
    if isinstance(raw, str) and raw.strip():
        return raw.strip()
    nested = params.get("BENCHMARK_ACTION")
    if isinstance(nested, dict):
        raw = nested.get("command")
        if isinstance(raw, str) and raw.strip():
            return raw.strip()
    return None


class ElizaBridgeTerminalAgent:
    """Terminal-Bench agent that routes its decision loop through the
    elizaOS TypeScript benchmark bridge instead of building a local
    Python ``AgentRuntime``.

    Same ``solve_task`` interface as ``ElizaTerminalAgent`` so the
    runner can drop us in unchanged when ``--model-provider eliza``.
    """

    def __init__(
        self,
        environment: "TerminalEnvironment",
        max_iterations: int = 20,
        model_name: str | None = None,
        client: Optional[ElizaClient] = None,
        verbose: bool = False,
    ) -> None:
        self._environment = environment
        self._max_iterations = max_iterations
        self._model_name = model_name or "eliza-ts-bridge"
        self._client = client or ElizaClient()
        self._verbose = verbose
        self._initialized = False

    async def _initialize(self) -> None:
        if self._initialized:
            return
        self._client.wait_until_ready(timeout=120)
        self._initialized = True

    async def solve_task(self, task: "TerminalTask") -> "TerminalBenchResult":
        await self._initialize()

        TerminalBenchResult, TerminalSession, _ = _terminal_types()

        session = TerminalSession(
            session_id=f"eliza_bridge_{task.task_id}_{datetime.now().strftime('%Y%m%d_%H%M%S')}",
            task=task,
            commands=[],
            working_directory="/workspace",
            environment_vars={},
            start_time=datetime.now(),
        )

        # Reset bridge session for this task
        try:
            self._client.reset(task_id=task.task_id, benchmark="terminal-bench")
        except Exception as exc:
            logger.debug("Eliza reset failed (continuing): %s", exc)

        last_feedback = ""
        task_complete = False
        test_success = False
        test_output = ""
        test_exit_code = 1
        error_message: Optional[str] = None

        try:
            for iteration in range(self._max_iterations):
                if iteration == 0:
                    msg = (
                        "You are an AI agent solving a Terminal-Bench task in a "
                        "Docker container.\n\n"
                        f"Task: {task.instruction}\n\n"
                        "Respond with the next shell command wrapped in "
                        "<command>...</command> tags. When you believe the "
                        "task is complete, respond with TASK_COMPLETE."
                    )
                else:
                    msg = (
                        "Previous command result:\n"
                        f"{last_feedback[:4000]}\n\n"
                        "Provide the next <command>...</command> or respond "
                        "with TASK_COMPLETE if you are done."
                    )

                response = self._client.send_message(
                    text=msg,
                    context={
                        "benchmark": "terminal-bench",
                        "task_id": task.task_id,
                        "session_id": session.session_id,
                        "category": task.category.value,
                        "difficulty": task.difficulty.value,
                        "instruction": task.instruction,
                        "iteration": iteration,
                    },
                )

                if _signals_complete(response.text or "", response.params):
                    test_success, test_output, test_exit_code = await self._environment.run_test(
                        task.test_script
                    )
                    if test_success:
                        task_complete = True
                        break
                    last_feedback = (
                        f"Task verification FAILED (exit code {test_exit_code}).\n"
                        f"Test output:\n{test_output}\n\n"
                        f"Please fix the issue and try again."
                    )
                    continue

                command = _extract_command(response.text or "")
                if not command:
                    command = _command_from_params(response.params)

                if not command:
                    last_feedback = (
                        "No command was provided. Please wrap the next shell "
                        "command in <command>...</command>."
                    )
                    continue

                cmd_result = await self._environment.execute(command)
                session.commands.append(cmd_result)
                last_feedback = (
                    f"$ {command}\n"
                    f"exit={cmd_result.exit_code}\n"
                    f"stdout={cmd_result.stdout[:2000]}\n"
                    f"stderr={cmd_result.stderr[:1000]}"
                )

            if not task_complete:
                test_success, test_output, test_exit_code = await self._environment.run_test(
                    task.test_script
                )

        except Exception as exc:
            error_message = str(exc)
            logger.error(
                "[eliza-bridge-terminal] Task %s failed: %s", task.task_id, exc
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
        self._initialized = False
