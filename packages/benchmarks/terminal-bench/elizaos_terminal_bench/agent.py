"""
Terminal-Bench Agent Implementation

An agent specialized for solving Terminal-Bench tasks using ElizaOS runtime.
"""

import asyncio
import logging
import shlex
import time
from datetime import datetime
from typing import TYPE_CHECKING, Optional

from elizaos_terminal_bench.environment import TerminalEnvironment
from elizaos_terminal_bench.types import (
    CommandStatus,
    TerminalBenchResult,
    TerminalCommand,
    TerminalSession,
    TerminalTask,
)

if TYPE_CHECKING:
    from elizaos.runtime import AgentRuntime

logger = logging.getLogger(__name__)


SYSTEM_PROMPT = """You are an expert terminal/shell operator. Your task is to complete the given task using terminal commands in a Linux environment.

## Available Actions

You can execute terminal commands by responding with:
ACTION: EXECUTE
COMMAND: <your shell command>

You can also read files:
ACTION: READ_FILE
PATH: <path to file>

Or list directories:
ACTION: LIST_DIR
PATH: <path to directory>

Or write files:
ACTION: WRITE_FILE
PATH: <path to file>
CONTENT: |
<file content here>

When you believe the task is complete, respond with:
ACTION: TASK_COMPLETE

## Guidelines

1. Think step-by-step about what commands to run
2. Start by understanding the current environment state (ls, pwd, etc.)
3. Use appropriate error handling when needed
4. Verify your work after making changes
5. Be efficient - minimize unnecessary commands
6. For complex tasks, break them into smaller steps
7. When asked for a numeric/text output, output ONLY the requested value (no extra words)
8. Return exactly ONE ACTION block per response (no multiple ACTION blocks).

## Important Notes

- You are in an isolated Linux container
- Working directory is /workspace
- Common tools are available: bash, python3, gcc, make, git, etc.
- Network access may be restricted depending on the task
- Files you create persist only for this task

Think carefully and solve the task systematically."""


class TerminalAgent:
    """ElizaOS agent for Terminal-Bench tasks."""

    def __init__(
        self,
        runtime: Optional["AgentRuntime"] = None,
        environment: Optional[TerminalEnvironment] = None,
        max_iterations: int = 20,
        model_name: str = "gpt-5-mini",
        temperature: float = 0.0,
        verbose: bool = False,
    ):
        """
        Initialize the Terminal Agent.

        Args:
            runtime: ElizaOS runtime for LLM access (optional for standalone use)
            environment: Terminal environment (created if not provided)
            max_iterations: Maximum agent iterations per task
            model_name: Model to use for generation
            temperature: Temperature for generation
            verbose: Enable verbose logging
        """
        self.runtime = runtime
        self.environment = environment
        self.max_iterations = max_iterations
        self.model_name = model_name
        self.temperature = temperature
        self.verbose = verbose

        self._session: Optional[TerminalSession] = None
        self._conversation_history: list[dict[str, str]] = []

    async def solve_task(self, task: TerminalTask) -> TerminalBenchResult:
        """
        Attempt to solve a Terminal-Bench task.

        Args:
            task: The task to solve

        Returns:
            TerminalBenchResult with the outcome
        """
        start_time = time.time()
        tokens_used = 0

        # Initialize session
        self._session = TerminalSession(
            session_id=f"session_{task.task_id}_{datetime.now().strftime('%Y%m%d_%H%M%S')}",
            task=task,
            commands=[],
            working_directory="/workspace",
            environment_vars={},
            start_time=datetime.now(),
        )

        # Create environment if not provided
        own_environment = self.environment is None
        if own_environment:
            self.environment = TerminalEnvironment(
                image=task.docker_image,
                timeout_seconds=task.timeout_seconds,
                network_mode="bridge" if task.network_enabled else "none",
            )

        try:
            # Start environment
            await self.environment.start(task)

            # Initialize conversation
            self._conversation_history = [
                {"role": "system", "content": SYSTEM_PROMPT},
                {
                    "role": "user",
                    "content": self._build_task_prompt(task),
                },
            ]

            # Agent loop
            task_complete = False
            error_message: Optional[str] = None
            test_success = False
            test_output = ""
            test_exit_code = 1
            test_ran = False

            for iteration in range(self.max_iterations):
                if self.verbose:
                    logger.info(f"Iteration {iteration + 1}/{self.max_iterations}")

                try:
                    # Get agent response
                    response, response_tokens = await self._get_llm_response()
                    tokens_used += response_tokens

                    if self.verbose:
                        logger.debug(f"Agent response: {response[:200]}...")

                    # Parse and execute action
                    action_result, signaled_complete = await self._parse_and_execute_action(
                        response
                    )

                    # Add response and result to history
                    self._conversation_history.append(
                        {
                            "role": "assistant",
                            "content": response,
                        }
                    )
                    if action_result:
                        self._conversation_history.append(
                            {
                                "role": "user",
                                "content": action_result,
                            }
                        )

                    if signaled_complete:
                        # Verify completion immediately; if tests fail, keep iterating.
                        test_success, test_output, test_exit_code = (
                            await self.environment.run_test(task.test_script)
                        )
                        test_ran = True

                        if test_success:
                            task_complete = True
                            break

                        self._conversation_history.append(
                            {
                                "role": "user",
                                "content": (
                                    f"Test failed (exit code {test_exit_code}). Output:\n"
                                    f"{test_output}"
                                ),
                            }
                        )

                except asyncio.TimeoutError:
                    error_message = "Agent iteration timed out"
                    logger.warning(error_message)
                    break
                except Exception as e:
                    error_message = str(e)
                    logger.error(f"Error in agent loop: {e}")
                    break

            # Run test script to verify completion (if not already run).
            if not test_ran:
                test_success, test_output, test_exit_code = await self.environment.run_test(
                    task.test_script
                )

            self._session.end_time = datetime.now()
            self._session.total_tokens = tokens_used

            # Calculate metrics
            total_execution_time = sum(
                cmd.execution_time_ms for cmd in self._session.commands
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

        except Exception as e:
            logger.error(f"Failed to solve task {task.task_id}: {e}")
            return TerminalBenchResult(
                task_id=task.task_id,
                success=False,
                commands_executed=len(self._session.commands) if self._session else 0,
                total_execution_time_ms=0,
                test_output="",
                test_exit_code=-1,
                error_message=str(e),
                tokens_used=tokens_used,
                session=self._session,
                category=task.category,
                difficulty=task.difficulty,
            )

        finally:
            if own_environment and self.environment:
                await self.environment.stop()
                self.environment = None

    def _record_command(self, command: TerminalCommand) -> None:
        """Record a command in the current session (if any)."""
        if self._session is not None:
            self._session.commands.append(command)

    def _build_task_prompt(self, task: TerminalTask) -> str:
        """Build the initial task prompt."""
        prompt_parts = [
            f"## Task\n{task.instruction}",
            f"\n## Category: {task.category.value}",
            f"## Difficulty: {task.difficulty.value}",
            f"## Timeout: {task.timeout_seconds} seconds",
        ]

        if task.required_tools:
            prompt_parts.append(f"## Required Tools: {', '.join(task.required_tools)}")

        prompt_parts.append(
            "\nBegin working on this task. Start by understanding the current environment state."
        )

        return "\n".join(prompt_parts)

    async def _get_llm_response(self) -> tuple[str, int]:
        """Get response from LLM."""
        if self.runtime:
            return await self._get_response_via_runtime()
        else:
            return await self._get_response_via_api()

    async def _get_response_via_runtime(self) -> tuple[str, int]:
        """Get response using ElizaOS runtime."""
        from elizaos.types.model import GenerateTextOptions, ModelType

        # Build prompt from conversation history (compatible with runtime.generate_text)
        prompt_parts: list[str] = []
        for msg in self._conversation_history:
            role = msg["role"].upper()
            content = msg["content"]
            prompt_parts.append(f"{role}:\n{content}")

        prompt = "\n\n".join(prompt_parts)

        result = await self.runtime.generate_text(
            input_text=prompt,
            options=GenerateTextOptions(
                model_type=ModelType.TEXT_LARGE,
                temperature=self.temperature,
                max_tokens=2000,
            ),
        )

        response_text = result.text
        # Rough token estimation
        tokens = len(prompt.split()) + len(response_text.split())

        return response_text, tokens

    async def _get_response_via_api(self) -> tuple[str, int]:
        """Get response using direct OpenAI API call."""
        import os

        import httpx

        api_key = os.getenv("OPENAI_API_KEY")
        if not api_key:
            raise ValueError("OPENAI_API_KEY environment variable required")

        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.post(
                "https://api.openai.com/v1/chat/completions",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": self.model_name,
                    "messages": self._conversation_history,
                    "temperature": self.temperature,
                    "max_tokens": 2000,
                },
            )
            response.raise_for_status()
            data = response.json()

        message = data["choices"][0]["message"]["content"]
        tokens = data.get("usage", {}).get("total_tokens", 0)

        return message, tokens

    async def _parse_and_execute_action(
        self, response: str
    ) -> tuple[str, bool]:
        """
        Parse the agent's response and execute the action.

        Returns:
            Tuple of (action_result, task_complete_signal)
        """
        allowed_actions = {"EXECUTE", "READ_FILE", "LIST_DIR", "WRITE_FILE", "TASK_COMPLETE"}

        blocks = self._split_action_blocks(response, allowed_actions=allowed_actions)
        if not blocks:
            # Try to extract a command if no explicit action
            command = self._extract_command_from_response(response)
            if command:
                return await self._execute_command(command), False

            return (
                "Please specify an action (EXECUTE, READ_FILE, LIST_DIR, WRITE_FILE, or TASK_COMPLETE).",
                False,
            )

        results: list[str] = []
        for block in blocks:
            action = self._extract_action_type(block, allowed_actions=allowed_actions)
            if action is None:
                continue
            if action == "TASK_COMPLETE":
                return "\n\n".join(results).strip(), True
            if action == "EXECUTE":
                results.append(await self._handle_execute_action(block))
            elif action == "READ_FILE":
                results.append(await self._handle_read_file_action(block))
            elif action == "LIST_DIR":
                results.append(await self._handle_list_dir_action(block))
            elif action == "WRITE_FILE":
                results.append(await self._handle_write_file_action(block))

        return "\n\n".join(results).strip(), False

    def _split_action_blocks(
        self, response: str, *, allowed_actions: set[str]
    ) -> list[str]:
        """Split a response into ACTION blocks."""
        lines = response.splitlines()
        blocks: list[list[str]] = []
        current: list[str] = []

        for line in lines:
            stripped = line.strip()
            if stripped.upper().startswith("ACTION:"):
                action = stripped.split(":", 1)[1].strip().upper()
                if action in allowed_actions:
                    if current:
                        blocks.append(current)
                    current = [line]
                    continue

            if current:
                current.append(line)

        if current:
            blocks.append(current)

        return ["\n".join(b).strip() for b in blocks if any(l.strip() for l in b)]

    def _extract_action_type(
        self, block: str, *, allowed_actions: set[str]
    ) -> Optional[str]:
        """Extract the action type from an ACTION block."""
        for line in block.splitlines():
            if not line.strip().upper().startswith("ACTION:"):
                continue
            action = line.split(":", 1)[1].strip().upper()
            if action in allowed_actions:
                return action
        return None

    def _extract_command_from_response(self, response: str) -> Optional[str]:
        """Try to extract a command from the response."""
        lines = response.strip().split("\n")

        # Look for COMMAND: prefix
        for line in lines:
            if line.upper().startswith("COMMAND:"):
                return line.split(":", 1)[1].strip()

        # Look for code blocks
        if "```" in response:
            parts = response.split("```")
            for i, part in enumerate(parts):
                if i % 2 == 1:  # Inside code block
                    # Remove language identifier if present
                    code = part.strip()
                    if code.startswith(("bash", "sh", "shell")):
                        code = "\n".join(code.split("\n")[1:])
                    return code.strip()

        return None

    async def _handle_execute_action(self, response: str) -> str:
        """Handle EXECUTE action."""
        command = None

        # Extract command
        lines = response.strip().split("\n")
        for i, line in enumerate(lines):
            if line.upper().startswith("COMMAND:"):
                command = line.split(":", 1)[1].strip()
                # Check for multi-line command
                if not command and i + 1 < len(lines):
                    command = lines[i + 1].strip()
                break

        if not command:
            command = self._extract_command_from_response(response)

        if not command:
            return "Error: No command found. Please specify COMMAND: <your command>"

        return await self._execute_command(command)

    async def _execute_command(self, command: str) -> str:
        """Execute a command and return formatted result."""
        if not self.environment:
            return "Error: Terminal environment not available"

        result = await self.environment.execute(command)

        # Track command in session
        self._record_command(result)

        # Format output
        output_parts = [f"Exit code: {result.exit_code}"]

        if result.stdout:
            output_parts.append(f"stdout:\n{result.stdout}")
        if result.stderr:
            output_parts.append(f"stderr:\n{result.stderr}")

        if result.status == CommandStatus.TIMEOUT:
            output_parts.append("(Command timed out)")
        elif result.status == CommandStatus.ERROR:
            output_parts.append("(Execution error)")

        return "\n".join(output_parts)

    async def _handle_read_file_action(self, response: str) -> str:
        """Handle READ_FILE action."""
        path = None

        lines = response.strip().split("\n")
        for line in lines:
            if line.upper().startswith("PATH:"):
                path = line.split(":", 1)[1].strip()
                break

        if not path:
            return "Error: No path specified. Please specify PATH: <file path>"

        try:
            # Use execute() so file reads are included in session logs.
            if not self.environment:
                return "Error: Terminal environment not available"

            cmd = await self.environment.execute(f"cat {shlex.quote(path)}")
            self._record_command(cmd)
            if cmd.exit_code != 0:
                return f"Error reading file: {cmd.stderr}"
            return f"File content ({path}):\n{cmd.stdout}"
        except Exception as e:
            return f"Error reading file: {e}"

    async def _handle_list_dir_action(self, response: str) -> str:
        """Handle LIST_DIR action."""
        path = "."

        lines = response.strip().split("\n")
        for line in lines:
            if line.upper().startswith("PATH:"):
                path = line.split(":", 1)[1].strip() or "."
                break

        try:
            # Use execute() so directory listings are included in session logs.
            if not self.environment:
                return "Error: Terminal environment not available"

            cmd = await self.environment.execute(f"ls -la {shlex.quote(path)}")
            self._record_command(cmd)
            if cmd.exit_code != 0:
                return f"Error listing directory: {cmd.stderr}"

            entries = cmd.stdout.strip().split("\n") if cmd.stdout.strip() else []
            return f"Directory listing ({path}):\n" + "\n".join(entries)
        except Exception as e:
            return f"Error listing directory: {e}"

    async def _handle_write_file_action(self, response: str) -> str:
        """Handle WRITE_FILE action."""
        path = None
        content = None

        lines = response.strip().split("\n")
        in_content = False
        content_lines: list[str] = []

        for line in lines:
            if in_content:
                content_lines.append(line)
            elif line.upper().startswith("PATH:"):
                path = line.split(":", 1)[1].strip()
            elif line.upper().startswith("CONTENT:"):
                in_content = True
                remainder = line.split(":", 1)[1].strip()
                if remainder and remainder != "|":
                    content_lines.append(remainder)

        if content_lines:
            content = "\n".join(content_lines)

        if not path:
            return "Error: No path specified. Please specify PATH: <file path>"
        if not content:
            return "Error: No content specified. Please specify CONTENT: <file content>"

        try:
            # Use execute() so file writes are included in session logs.
            if not self.environment:
                return "Error: Terminal environment not available"

            heredoc = f"cat << 'ELIZAEOF' > {shlex.quote(path)}\n{content}\nELIZAEOF"
            cmd = await self.environment.execute(heredoc)
            self._record_command(cmd)
            if cmd.exit_code == 0:
                return f"Successfully wrote to {path}"
            return f"Failed to write to {path}: {cmd.stderr}"
        except Exception as e:
            return f"Error writing file: {e}"

    async def close(self) -> None:
        """Clean up resources."""
        if self.environment:
            await self.environment.stop()
            self.environment = None
