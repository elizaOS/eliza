"""
Code Executor Tool for GAIA Benchmark

Provides safe Python code execution in sandboxed environments.
"""

import asyncio
import logging
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger(__name__)


@dataclass
class ExecutionResult:
    """Result of code execution."""
    stdout: str
    stderr: str
    return_code: int
    success: bool
    execution_time_ms: float
    error: str | None = None


class CodeExecutor:
    """Safe code execution environment for GAIA benchmark."""

    def __init__(
        self,
        timeout_seconds: int = 30,
        max_output_length: int = 10000,
        use_docker: bool = False,
        allowed_imports: list[str] | None = None,
    ):
        """
        Initialize code executor.

        Args:
            timeout_seconds: Maximum execution time
            max_output_length: Maximum output length to capture
            use_docker: Run code in Docker container for isolation
            allowed_imports: List of allowed import modules (None = all allowed)
        """
        self.timeout_seconds = timeout_seconds
        self.max_output_length = max_output_length
        self.use_docker = use_docker
        self.allowed_imports = allowed_imports

    async def execute_python(
        self,
        code: str,
        working_dir: Path | None = None,
    ) -> ExecutionResult:
        """
        Execute Python code safely.

        Args:
            code: Python code to execute
            working_dir: Working directory for execution

        Returns:
            ExecutionResult with output
        """
        import time

        start_time = time.time()

        try:
            if self.use_docker:
                return await self._execute_in_docker(code, working_dir)
            else:
                return await self._execute_subprocess(code, working_dir)
        except TimeoutError:
            return ExecutionResult(
                stdout="",
                stderr="",
                return_code=-1,
                success=False,
                execution_time_ms=(time.time() - start_time) * 1000,
                error=f"Execution timed out after {self.timeout_seconds} seconds",
            )
        except Exception as e:
            return ExecutionResult(
                stdout="",
                stderr=str(e),
                return_code=-1,
                success=False,
                execution_time_ms=(time.time() - start_time) * 1000,
                error=str(e),
            )

    async def _execute_subprocess(
        self,
        code: str,
        working_dir: Path | None,
    ) -> ExecutionResult:
        """Execute code in a subprocess."""
        import time

        # Validate code if allowed_imports is set
        if self.allowed_imports is not None:
            validation_error = self._validate_imports(code)
            if validation_error:
                return ExecutionResult(
                    stdout="",
                    stderr=validation_error,
                    return_code=-1,
                    success=False,
                    execution_time_ms=0,
                    error=validation_error,
                )

        # Create temporary file for the code
        with tempfile.NamedTemporaryFile(
            mode="w",
            suffix=".py",
            delete=False,
            encoding="utf-8",
        ) as f:
            f.write(code)
            temp_file = f.name

        try:
            start_time = time.time()

            # Run in subprocess
            process = await asyncio.create_subprocess_exec(
                sys.executable,
                temp_file,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=working_dir,
            )

            try:
                stdout_bytes, stderr_bytes = await asyncio.wait_for(
                    process.communicate(),
                    timeout=self.timeout_seconds,
                )
            except TimeoutError:
                process.kill()
                await process.wait()
                raise

            execution_time_ms = (time.time() - start_time) * 1000

            stdout = stdout_bytes.decode("utf-8", errors="replace")
            stderr = stderr_bytes.decode("utf-8", errors="replace")

            # Truncate output if too long
            stdout = stdout[:self.max_output_length]
            stderr = stderr[:self.max_output_length]

            return ExecutionResult(
                stdout=stdout,
                stderr=stderr,
                return_code=process.returncode or 0,
                success=process.returncode == 0,
                execution_time_ms=execution_time_ms,
            )

        finally:
            # Clean up temp file
            Path(temp_file).unlink(missing_ok=True)

    async def _execute_in_docker(
        self,
        code: str,
        working_dir: Path | None,
    ) -> ExecutionResult:
        """Execute code in a Docker container for isolation."""
        import time

        # Create temporary file for the code
        with tempfile.NamedTemporaryFile(
            mode="w",
            suffix=".py",
            delete=False,
            encoding="utf-8",
        ) as f:
            f.write(code)
            temp_file = Path(f.name)

        try:
            start_time = time.time()

            # Docker command
            docker_cmd = [
                "docker",
                "run",
                "--rm",
                "--network=none",  # No network access
                "--memory=512m",  # Memory limit
                "--cpus=1",  # CPU limit
                "-v",
                f"{temp_file}:/code/script.py:ro",
            ]

            if working_dir:
                docker_cmd.extend(["-v", f"{working_dir}:/data:ro", "-w", "/data"])

            docker_cmd.extend([
                "python:3.11-slim",
                "python",
                "/code/script.py",
            ])

            process = await asyncio.create_subprocess_exec(
                *docker_cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )

            try:
                stdout_bytes, stderr_bytes = await asyncio.wait_for(
                    process.communicate(),
                    timeout=self.timeout_seconds + 10,  # Extra time for Docker overhead
                )
            except TimeoutError:
                # Kill the Docker container
                subprocess.run(
                    ["docker", "kill", "$(docker ps -q --filter ancestor=python:3.11-slim)"],
                    shell=True,
                    capture_output=True,
                )
                raise

            execution_time_ms = (time.time() - start_time) * 1000

            stdout = stdout_bytes.decode("utf-8", errors="replace")
            stderr = stderr_bytes.decode("utf-8", errors="replace")

            return ExecutionResult(
                stdout=stdout[:self.max_output_length],
                stderr=stderr[:self.max_output_length],
                return_code=process.returncode or 0,
                success=process.returncode == 0,
                execution_time_ms=execution_time_ms,
            )

        finally:
            temp_file.unlink(missing_ok=True)

    def _validate_imports(self, code: str) -> str | None:
        """Validate that code only uses allowed imports."""
        import ast

        try:
            tree = ast.parse(code)
        except SyntaxError as e:
            return f"Syntax error: {e}"

        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    module = alias.name.split(".")[0]
                    if module not in self.allowed_imports:
                        return f"Import of '{module}' is not allowed"
            elif isinstance(node, ast.ImportFrom):
                if node.module:
                    module = node.module.split(".")[0]
                    if module not in self.allowed_imports:
                        return f"Import from '{module}' is not allowed"

        return None

    async def execute_with_inputs(
        self,
        code: str,
        inputs: dict[str, str | int | float | bool | list | dict],
    ) -> ExecutionResult:
        """
        Execute code with input variables.

        Args:
            code: Python code to execute
            inputs: Dictionary of input variables

        Returns:
            ExecutionResult with output
        """
        # Create code with inputs
        import json

        input_code = "import json\n"
        for name, value in inputs.items():
            input_code += f"{name} = {json.dumps(value)}\n"

        full_code = input_code + "\n" + code

        return await self.execute_python(full_code)

    def format_result(self, result: ExecutionResult) -> str:
        """Format execution result as a string."""
        output_parts: list[str] = []

        if result.success:
            output_parts.append("Execution successful")
        else:
            output_parts.append("Execution failed")

        output_parts.append(f"Return code: {result.return_code}")
        output_parts.append(f"Execution time: {result.execution_time_ms:.1f}ms")

        if result.stdout:
            output_parts.append(f"\nOutput:\n{result.stdout}")

        if result.stderr:
            output_parts.append(f"\nErrors:\n{result.stderr}")

        if result.error:
            output_parts.append(f"\nError: {result.error}")

        return "\n".join(output_parts)
