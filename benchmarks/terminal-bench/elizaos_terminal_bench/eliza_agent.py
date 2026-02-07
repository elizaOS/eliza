"""
Canonical ElizaOS Agent for Terminal-Bench.

This agent uses the full ElizaOS runtime with message_service.handle_message(),
actions, providers, and evaluators - NO BYPASS.
"""

from __future__ import annotations

import asyncio
import logging
import os
import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from elizaos import AgentRuntime
from elizaos.types import Plugin
from elizaos.types.agent import Character
from elizaos.types.memory import Memory
from elizaos.types.model import ModelType
from elizaos.types.primitives import Content, as_uuid, string_to_uuid

from .environment import TerminalEnvironment
from .plugin import terminal_bench_plugin
from .types import (
    TerminalBenchResult,
    TerminalCommand,
    TerminalSession,
    TerminalTask,
)

if TYPE_CHECKING:
    pass

logger = logging.getLogger(__name__)

TERMINAL_BENCH_MESSAGE_HANDLER_TEMPLATE = """<task>Generate dialog and actions for the character {{agentName}}.</task>

<providers>
{{providers}}
</providers>

<instructions>
You are operating inside a sandboxed Linux container. The working directory is /workspace.

You MUST use the terminal actions to do real work. Do not merely describe what you would do.

Available terminal actions (require parameters):
- EXECUTE (required param: command)
- WRITE_FILE (required params: path, content)
- TOUCH (required param: path)
- READ_FILE (required param: path)
- LIST_DIR (optional param: path)
- TASK_COMPLETE (optional param: summary)

CRITICAL PARAM RULES:
- If you choose EXECUTE, you MUST include <params><EXECUTE><command>...</command></EXECUTE></params>.
- If you choose WRITE_FILE, you MUST include BOTH <path> and <content> under <params><WRITE_FILE>...</WRITE_FILE></params>.
- If you choose TOUCH, you MUST include <params><TOUCH><path>...</path></TOUCH></params>.
- Do NOT escape newlines in file content (do NOT write \"\\n\" sequences). Put real newlines inside <content>.
- Prefer absolute paths under /workspace (e.g. /workspace/project/src/__init__.py).

ACTION ORDERING:
- Use REPLY first to acknowledge briefly.
- Then use the terminal actions needed to complete the task.
- Use TASK_COMPLETE only after you believe the task is done.

</instructions>

<output>
Respond using XML format like this:
<response>
  <thought>Short plan</thought>
  <actions>REPLY,EXECUTE,WRITE_FILE</actions>
  <providers>TASK_CONTEXT,TERMINAL_STATE</providers>
  <text>Brief acknowledgement</text>
  <params>
    <EXECUTE>
      <command>mkdir -p /workspace/project/src /workspace/project/tests</command>
    </EXECUTE>
    <WRITE_FILE>
      <path>/workspace/project/src/__init__.py</path>
      <content>
      </content>
    </WRITE_FILE>
  </params>
</response>
</output>"""


def _get_openai_plugin() -> Plugin:
    """Get the OpenAI plugin for model handlers."""
    try:
        from elizaos_plugin_openai import get_openai_plugin

        return get_openai_plugin()
    except ImportError:
        raise RuntimeError(
            "elizaos_plugin_openai not found. Please install it:\n"
            "  pip install elizaos-plugin-openai\n"
            "Or set PYTHONPATH to include the plugin directory."
        )


class ElizaTerminalAgent:
    """
    Canonical ElizaOS agent for Terminal-Bench that uses the full runtime.

    This agent:
    - Creates an AgentRuntime with basicCapabilities enabled
    - Registers the terminal-bench plugin with actions and providers
    - Uses message_service.handle_message() for canonical message processing
    - Actions (EXECUTE, READ_FILE, etc.) are called by the runtime
    - Providers (TASK_CONTEXT, TERMINAL_STATE) inject context
    """

    def __init__(
        self,
        environment: TerminalEnvironment | None = None,
        max_iterations: int = 20,
        model_name: str = "gpt-5-mini",
        temperature: float = 0.0,
        verbose: bool = False,
    ) -> None:
        self._environment = environment
        self._max_iterations = max_iterations
        self._model_name = model_name
        self._temperature = temperature
        self._verbose = verbose

        self._runtime: AgentRuntime | None = None
        self._session: TerminalSession | None = None
        self._current_task: TerminalTask | None = None

    @property
    def environment(self) -> TerminalEnvironment | None:
        return self._environment

    @environment.setter
    def environment(self, env: TerminalEnvironment) -> None:
        self._environment = env

    async def _initialize_runtime(self) -> AgentRuntime:
        """Initialize the full ElizaOS runtime with all plugins."""
        # Ensure the OpenAI plugin uses the requested model.
        # The python OpenAI plugin reads OPENAI_SMALL_MODEL / OPENAI_LARGE_MODEL at init time.
        os.environ.setdefault("OPENAI_SMALL_MODEL", self._model_name)
        os.environ.setdefault("OPENAI_LARGE_MODEL", self._model_name)

        # Create character for the terminal benchmark agent
        character = Character(
            name="TerminalBenchAgent",
            bio=(
                "I am a terminal benchmark agent specialized in executing shell commands, "
                "file operations, and completing terminal-based tasks efficiently."
            ),
            system=(
                "You are a terminal benchmark agent. Your goal is to complete the given task "
                "by using the available actions: EXECUTE (run shell commands), READ_FILE, "
                "WRITE_FILE, LIST_DIR, and TASK_COMPLETE.\n\n"
                "When you complete a task, use TASK_COMPLETE to signal completion.\n"
                "Be efficient - minimize the number of actions needed.\n"
                "If a command fails, analyze the error and try again with corrections."
            ),
            settings={
                "extra": {
                    "CHECK_SHOULD_RESPOND": False,  # Always respond (benchmark mode)
                    "ACTION_PLANNING": True,  # Enable multi-action execution
                },
            },
            templates={
                # Use a stricter message handler template for terminal actions.
                "messageHandlerTemplate": TERMINAL_BENCH_MESSAGE_HANDLER_TEMPLATE,
            },
        )

        # Get plugins
        openai_plugin = _get_openai_plugin()

        # Create runtime with basicCapabilities enabled (default)
        runtime = AgentRuntime(
            character=character,
            plugins=[
                openai_plugin,
                terminal_bench_plugin,
            ],
            disable_basic_capabilities=False,  # Keep REPLY, IGNORE, NONE actions
            enable_extended_capabilities=False,
            check_should_respond=False,  # Benchmark mode - always respond
            action_planning=True,  # Enable multi-action plans
            log_level="DEBUG" if self._verbose else "INFO",
        )

        # Initialize runtime (registers bootstrap + plugins)
        await runtime.initialize()

        logger.info(
            f"ElizaOS runtime initialized with {len(runtime.actions)} actions, "
            f"{len(runtime.providers)} providers"
        )

        return runtime

    async def _setup_session(self, task: TerminalTask) -> TerminalSession:
        """Create a new benchmark session."""
        session_id = f"eliza_{task.task_id}_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
        return TerminalSession(
            session_id=session_id,
            task=task,
            commands=[],
            working_directory="/workspace",
            environment_vars={},
            start_time=datetime.now(),
        )

    def _inject_task_context(self, task: TerminalTask, session: TerminalSession) -> None:
        """Inject task and environment into runtime settings for providers."""
        if self._runtime is None:
            return

        # These are read by TASK_CONTEXT and TERMINAL_STATE providers
        self._runtime.set_setting("CURRENT_TASK", task)
        self._runtime.set_setting("CURRENT_SESSION", session)
        self._runtime.set_setting("TERMINAL_ENVIRONMENT", self._environment)

        # Reset task completion signal
        self._runtime.set_setting("TASK_COMPLETE_SIGNAL", False)
        self._runtime.set_setting("TASK_COMPLETE_SUMMARY", "")

    async def solve_task(self, task: TerminalTask) -> TerminalBenchResult:
        """
        Solve a terminal benchmark task using canonical ElizaOS flow.

        This method:
        1. Initializes the ElizaOS runtime (if not done)
        2. Sets up the session and injects context
        3. Sends the task instruction as a message
        4. Lets the runtime handle message -> actions -> response
        5. Repeats until TASK_COMPLETE or max iterations
        """
        # Initialize runtime if needed
        if self._runtime is None:
            self._runtime = await self._initialize_runtime()

        self._current_task = task
        self._session = await self._setup_session(task)

        # Inject context for providers
        self._inject_task_context(task, self._session)

        tokens_used = 0
        task_complete = False
        error_message: str | None = None
        test_success = False
        test_output = ""
        test_exit_code = 1

        # Create room and user IDs for message handling
        room_id = string_to_uuid(f"terminal-bench-{task.task_id}")
        user_id = string_to_uuid("benchmark-harness")

        # Track action outputs to use as feedback in the next iteration
        action_callback_results: list[Content] = []
        last_feedback_text: str = ""

        async def action_callback(content: Content) -> list[Memory]:
            """Callback to capture action results."""
            action_callback_results.append(content)

            # Check if TASK_COMPLETE was signaled
            if content.actions and "TASK_COMPLETE" in content.actions:
                pass  # Will check via runtime setting

            return []

        for iteration in range(self._max_iterations):
            if self._verbose:
                logger.info(f"Iteration {iteration + 1}/{self._max_iterations}")

            try:
                # Construct message - first iteration gets task, subsequent get feedback
                if iteration == 0:
                    message_text = (
                        f"Please complete this terminal benchmark task:\n\n"
                        f"{task.instruction}\n\n"
                        f"Use the available actions (EXECUTE, READ_FILE, WRITE_FILE, "
                        f"LIST_DIR) to complete the task, then use TASK_COMPLETE when done."
                    )
                else:
                    message_text = (
                        last_feedback_text
                        if last_feedback_text
                        else "Continue working on the task."
                    )

                # Create message memory
                message = Memory(
                    id=as_uuid(str(uuid.uuid4())),
                    entity_id=user_id,
                    room_id=room_id,
                    content=Content(text=message_text),
                    created_at=int(datetime.now().timestamp() * 1000),
                )

                # Use the canonical message service
                result = await self._runtime.message_service.handle_message(
                    self._runtime,
                    message,
                    action_callback,
                )

                # Capture feedback from action callbacks for the next iteration
                feedback_parts: list[str] = []
                for c in action_callback_results:
                    if c.text:
                        feedback_parts.append(c.text)
                last_feedback_text = "\n\n".join(feedback_parts).strip()
                action_callback_results.clear()

                if self._verbose:
                    logger.debug(f"Message handled, did_respond={result.did_respond}")

                # Check if TASK_COMPLETE was signaled
                complete_signal = self._runtime.get_setting("TASK_COMPLETE_SIGNAL")
                if complete_signal:
                    if self._verbose:
                        logger.info("Task completion signaled by agent")

                    # Run verification test
                    if self._environment:
                        test_success, test_output, test_exit_code = (
                            await self._environment.run_test(task.test_script)
                        )

                        if test_success:
                            task_complete = True
                            break
                        else:
                            # Test failed - provide feedback and continue
                            if self._verbose:
                                logger.warning(
                                    f"Test failed after TASK_COMPLETE: {test_output}"
                                )
                            # Reset signal and inject failure feedback
                            self._runtime.set_setting("TASK_COMPLETE_SIGNAL", False)
                            action_callback_results.append(
                                Content(
                                    text=(
                                        f"Task verification FAILED (exit code {test_exit_code}).\n"
                                        f"Test output:\n{test_output}\n\n"
                                        f"Please fix the issue and try again."
                                    )
                                )
                            )
                    else:
                        # No environment to test - assume complete
                        task_complete = True
                        break

            except asyncio.TimeoutError:
                error_message = "Agent iteration timed out"
                logger.warning(error_message)
                break
            except Exception as e:
                error_message = str(e)
                logger.error(f"Error in agent loop: {e}")
                break

        # Final test if not already completed
        if not task_complete and self._environment:
            test_success, test_output, test_exit_code = await self._environment.run_test(
                task.test_script
            )

        # Build result
        self._session.end_time = datetime.now()

        total_execution_time = sum(
            c.execution_time_ms for c in self._session.commands
        )

        return TerminalBenchResult(
            task_id=task.task_id,
            success=test_success,
            commands_executed=len(self._session.commands),
            total_execution_time_ms=total_execution_time,
            test_output=test_output,
            test_exit_code=test_exit_code,
            error_message=error_message,
            tokens_used=tokens_used,
            session=self._session,
            category=task.category,
            difficulty=task.difficulty,
        )

    async def cleanup(self) -> None:
        """Clean up resources."""
        if self._runtime is not None:
            await self._runtime.stop()
            self._runtime = None
