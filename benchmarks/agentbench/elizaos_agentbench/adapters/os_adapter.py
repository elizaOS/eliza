"""
Operating System environment adapter for AgentBench.

This adapter handles Linux terminal interaction tasks.
"""

import asyncio
import logging
import os
import re
import shlex
import tempfile

from elizaos_agentbench.types import (
    AgentBenchEnvironment,
    AgentRuntimeProtocol,
    AgentBenchTask,
    EnvironmentConfig,
    ObservationType,
)
from elizaos_agentbench.adapters.base import EnvironmentAdapter

logger = logging.getLogger(__name__)

# Type alias for step info
StepInfoType = dict[str, str | int | float | bool | None]


class OSEnvironmentAdapter(EnvironmentAdapter):
    """
    Adapter for Operating System (Linux terminal) environment.

    Tasks include file manipulation, command execution, and system administration.
    """

    environment = AgentBenchEnvironment.OS

    # Dangerous command regexes that should be blocked
    DANGEROUS_PATTERNS: list[str] = [
        r"(^|\s)rm\s+-rf\s+/\s*($|[;&|])",
        r"(^|\s)rm\s+-rf\s+/\*\s*($|[;&|])",
        r":\(\)\{\s*:\|\:&\s*\};:",  # fork bomb
        r"\bdd\s+if=/dev/zero\b",
        r"\bmkfs\.\w+",
        r"\bof=/dev/sd\w+\b",
        r"\bchmod\s+-R\s+777\s+/\b",
        r"\b(?:wget|curl)\b.+\|\s*bash\b",
    ]

    def __init__(
        self,
        runtime: AgentRuntimeProtocol | None = None,
        config: EnvironmentConfig | None = None,
    ) -> None:
        super().__init__(runtime, config)
        self._container_id: str | None = None
        self._temp_dir: str | None = None
        # Use default if config or docker_image is None
        self._docker_image = (config.docker_image if config and config.docker_image else "ubuntu:22.04")
        self._command_history: list[str] = []
        self._working_directory = "/"

    async def initialize(self) -> None:
        """Initialize Docker container for sandboxed execution."""
        if self._initialized:
            return

        logger.info("[OS] Initializing OS environment adapter...")

        if self.config and self.config.additional_settings.get("use_docker", True):
            try:
                # Pull Docker image
                pull_proc = await asyncio.create_subprocess_exec(
                    "docker",
                    "pull",
                    self._docker_image,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                await pull_proc.communicate()

                # Create container
                create_proc = await asyncio.create_subprocess_exec(
                    "docker",
                    "create",
                    "-i",
                    "--memory=512m",
                    "--cpus=1",
                    self._docker_image,
                    "/bin/bash",
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                stdout, _ = await create_proc.communicate()
                self._container_id = stdout.decode().strip()

                # Start container
                start_proc = await asyncio.create_subprocess_exec(
                    "docker",
                    "start",
                    self._container_id,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                await start_proc.communicate()

                logger.info(f"[OS] Docker container started: {self._container_id[:12]}")

            except Exception as e:
                logger.warning(f"[OS] Docker initialization failed, using local execution: {e}")
                self._container_id = None
        else:
            # Create temp directory for local sandboxed execution
            self._temp_dir = tempfile.mkdtemp(prefix="agentbench_os_")
            self._working_directory = self._temp_dir

        self._initialized = True
        logger.info("[OS] OS environment adapter initialized")

    async def reset(self, task: AgentBenchTask) -> ObservationType:
        """Reset environment for a new task."""
        self._command_history = []

        # Safely get working directory with type checking
        working_dir_value = task.initial_state.get("working_dir")
        requested_working_dir = (
            working_dir_value if isinstance(working_dir_value, str) and working_dir_value else "/home/user"
        )

        # Local sandbox: always operate inside our temp directory
        if self._container_id is None and self._temp_dir is not None:
            rel = requested_working_dir.lstrip(os.sep)
            self._working_directory = os.path.join(self._temp_dir, rel) if rel else self._temp_dir
            os.makedirs(self._working_directory, exist_ok=True)
        else:
            self._working_directory = requested_working_dir

        # Set up initial state from task
        if self._container_id:
            # Create working directory in container (escape path for safety)
            safe_dir = shlex.quote(self._working_directory)
            await self._execute_docker_command(f"mkdir -p {safe_dir}")

            # Set up initial files if specified
            initial_files = task.initial_state.get("files")
            if isinstance(initial_files, dict):
                for filepath, content in initial_files.items():
                    if isinstance(filepath, str) and isinstance(content, str):
                        # Properly escape content for shell
                        safe_path = shlex.quote(filepath)
                        parent_dir = os.path.dirname(filepath) or "."
                        safe_parent = shlex.quote(parent_dir)
                        escaped_content = content.replace("'", "'\\''")
                        await self._execute_docker_command(
                            f"mkdir -p {safe_parent} && echo '{escaped_content}' > {safe_path}"
                        )
        else:
            # Local sandbox file setup
            initial_files = task.initial_state.get("files")
            if isinstance(initial_files, dict):
                for filepath, content in initial_files.items():
                    if not isinstance(filepath, str) or not isinstance(content, str):
                        continue
                    # Map absolute paths into sandbox root; keep relative paths relative to working dir
                    if os.path.isabs(filepath) and self._temp_dir is not None:
                        rel = filepath.lstrip(os.sep)
                        target_path = os.path.join(self._temp_dir, rel)
                    else:
                        target_path = os.path.join(self._working_directory, filepath)
                    os.makedirs(os.path.dirname(target_path), exist_ok=True)
                    with open(target_path, "w", encoding="utf-8") as f:
                        f.write(content)

        return {
            "working_dir": self._working_directory,
            "last_output": "",
            "task_description": task.description,
            "goal": task.goal,
        }

    async def step(self, action: str) -> tuple[ObservationType, float, bool, StepInfoType]:
        """Execute a bash command and return the result."""
        # Parse the action to extract the command
        command = self._extract_command(action)

        if not command:
            return (
                {"error": "No valid command found in action"},
                -0.1,
                False,
                {"action": action},
            )

        # Check for dangerous commands BEFORE execution
        if self._is_dangerous_command(command):
            return (
                {"error": "BLOCKED: Potentially dangerous command", "command": command},
                -1.0,
                False,
                {"command": command, "blocked": True},
            )

        self._command_history.append(command)

        try:
            if self._container_id:
                output, exit_code = await self._execute_docker_command(command)
            else:
                output, exit_code = await self._execute_local_command(command)

            # Calculate reward based on exit code and output
            reward = 0.1 if exit_code == 0 else -0.05

            observation: ObservationType = {
                "command": command,
                "output": output,
                "exit_code": exit_code,
                "working_dir": self._working_directory,
            }

            # Check if done (can be customized per task)
            done = exit_code == 0 and "TASK_COMPLETE" in output

            return observation, reward, done, {"command": command, "exit_code": exit_code}

        except asyncio.TimeoutError:
            return (
                {"error": "Command timed out"},
                -0.2,
                False,
                {"command": command, "timeout": True},
            )
        except Exception as e:
            return (
                {"error": str(e)},
                -0.1,
                False,
                {"command": command, "exception": str(e)},
            )

    def _is_dangerous_command(self, command: str) -> bool:
        """Check if a command matches dangerous patterns."""
        command_lower = command.lower()

        for pattern in self.DANGEROUS_PATTERNS:
            try:
                if re.search(pattern, command_lower, re.IGNORECASE):
                    return True
            except re.error:
                continue

        # Extra safety for local sandbox: block destructive ops on absolute paths outside sandbox root.
        if self._container_id is None and self._temp_dir is not None:
            try:
                tokens = shlex.split(command)
            except ValueError:
                tokens = []
            if tokens:
                cmd = tokens[0].lower()
                if cmd in {"rm", "chmod", "chown"}:
                    for tok in tokens[1:]:
                        if tok.startswith("/") and not tok.startswith(self._temp_dir):
                            return True

        return False

    async def _execute_docker_command(self, command: str) -> tuple[str, int]:
        """Execute command in Docker container."""
        if not self._container_id:
            raise RuntimeError("Docker container not initialized")

        try:
            proc = await asyncio.create_subprocess_exec(
                "docker",
                "exec",
                "-w",
                self._working_directory,
                self._container_id,
                "bash",
                "-c",
                command,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await asyncio.wait_for(
                proc.communicate(),
                timeout=self.config.timeout_ms / 1000 if self.config else 30,
            )
            output = stdout.decode() + stderr.decode()
            return output.strip(), proc.returncode or 0
        except asyncio.TimeoutError:
            return "Execution timed out", 124

    async def _execute_local_command(self, command: str) -> tuple[str, int]:
        """Execute command locally in temp directory (fallback)."""
        try:
            proc = await asyncio.create_subprocess_shell(
                command,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=self._working_directory,
            )
            stdout, stderr = await asyncio.wait_for(
                proc.communicate(),
                timeout=self.config.timeout_ms / 1000 if self.config else 30,
            )
            output = stdout.decode() + stderr.decode()
            return output.strip(), proc.returncode or 0
        except asyncio.TimeoutError:
            return "Execution timed out", 124

    def _extract_command(self, action: str) -> str:
        """Extract bash command from action string."""
        # Try common formats
        patterns = [
            r"```bash\n(.*?)\n```",
            r"```sh\n(.*?)\n```",
            r"```\n(.*?)\n```",
            r"command:\s*(.+)",
            r"execute:\s*(.+)",
            r"run:\s*(.+)",
        ]

        for pattern in patterns:
            match = re.search(pattern, action, re.DOTALL | re.IGNORECASE)
            if match:
                return match.group(1).strip()

        # If no pattern matches, use the action as-is if it looks like a command
        action = action.strip()
        if action and not action.startswith("I ") and len(action) < 500:
            # Clean up common prefixes
            for prefix in ["Action:", "Command:", "Execute:"]:
                if action.startswith(prefix):
                    action = action[len(prefix) :].strip()
            return action

        return ""

    async def evaluate(self, task: AgentBenchTask, trajectory: list[str]) -> bool:
        """Evaluate task completion."""
        if not task.ground_truth:
            return False

        # Check if expected output/state is achieved
        expected = task.ground_truth.lower()

        # Execute verification command if specified
        if "verify_command" in task.metadata:
            output, exit_code = await self._execute_docker_command(
                task.metadata["verify_command"]
            ) if self._container_id else await self._execute_local_command(
                task.metadata["verify_command"]
            )
            return exit_code == 0 and expected in output.lower()

        # Check last command output
        if self._command_history:
            last_output = self._current_state.get("output", "")
            return expected in last_output.lower()

        return False

    async def cleanup(self) -> None:
        """Stop and remove Docker container."""
        if self._container_id:
            try:
                stop_proc = await asyncio.create_subprocess_exec(
                    "docker",
                    "rm",
                    "-f",
                    self._container_id,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                await stop_proc.communicate()
                logger.info(f"[OS] Docker container removed: {self._container_id[:12]}")
            except Exception as e:
                logger.error(f"[OS] Failed to cleanup container: {e}")
            self._container_id = None

        if self._temp_dir:
            import shutil

            try:
                shutil.rmtree(self._temp_dir, ignore_errors=True)
            except Exception as e:
                logger.error(f"[OS] Failed to cleanup temp directory: {e}")

        self._initialized = False

    def get_action_space(self) -> list[str]:
        """Get available bash commands."""
        return [
            "ls",
            "cd",
            "cat",
            "grep",
            "find",
            "mkdir",
            "touch",
            "mv",
            "cp",
            "rm",
            "echo",
            "head",
            "tail",
            "wc",
            "sort",
            "uniq",
            "awk",
            "sed",
            "chmod",
            "chown",
            "ps",
            "kill",
            "wget",
            "curl",
            "tar",
            "gzip",
            "unzip",
        ]

    def format_prompt(self, task: AgentBenchTask, observation: ObservationType) -> str:
        """Format observation into prompt for LLM."""
        working_dir = observation.get('working_dir', '/')
        last_output = observation.get('last_output') or observation.get('output') or 'No output yet'

        return f"""You are an AI assistant operating a Linux terminal. Your goal is to complete the following task.

**Task:** {task.description}
**Goal:** {task.goal}

**Current Working Directory:** {working_dir}

**Last Command Output:**
```
{last_output}
```

Please provide the next bash command to execute. Format your response as:
```bash
<your command here>
```

Think step by step about what command will help achieve the goal."""

    def parse_action(self, response: str) -> str:
        """Parse LLM response to extract bash command."""
        return self._extract_command(response)
