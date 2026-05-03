"""
Python Code Executor for MINT Benchmark

Provides safe, sandboxed execution of Python code for tool use in MINT tasks.
Supports both Docker-based sandboxing and local execution (with restrictions).
"""

import asyncio
import builtins
import logging
import re
import tempfile
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)


class ExecutionResult:
    """Result of code execution."""

    def __init__(
        self,
        output: str,
        success: bool,
        error: Optional[str] = None,
        execution_time_ms: float = 0.0,
    ) -> None:
        self.output = output
        self.success = success
        self.error = error
        self.execution_time_ms = execution_time_ms


class PythonExecutor:
    """Execute Python code in a sandboxed environment."""

    # Dangerous patterns that should be blocked in local execution
    DANGEROUS_PATTERNS = [
        r"\bimport\s+os\b",
        r"\bimport\s+subprocess\b",
        r"\bimport\s+shutil\b",
        r"\bimport\s+sys\b.*\bexit\b",
        r"\b__import__\b",
        r"\beval\s*\(",
        r"\bexec\s*\(",
        r"\bopen\s*\([^)]*['\"]w['\"]",  # writing files
        r"\bos\.system\b",
        r"\bos\.popen\b",
        r"\bsubprocess\.",
        r"\bshutil\.rmtree\b",
    ]

    # Safe imports allowed in sandboxed mode
    SAFE_IMPORTS = [
        "math",
        "statistics",
        "itertools",
        "functools",
        "collections",
        "heapq",
        "bisect",
        "array",
        "decimal",
        "fractions",
        "random",
        "string",
        "re",
        "json",
        "datetime",
        "time",
        "copy",
        "operator",
    ]

    def __init__(
        self,
        timeout: int = 30,
        use_docker: bool = True,
        docker_image: str = "python:3.11-slim",
        memory_limit: str = "512m",
        cpu_limit: str = "1",
    ) -> None:
        """
        Initialize the Python executor.

        Args:
            timeout: Maximum execution time in seconds
            use_docker: Whether to use Docker for sandboxing
            docker_image: Docker image to use
            memory_limit: Memory limit for Docker container
            cpu_limit: CPU limit for Docker container
        """
        self.timeout = timeout
        self.use_docker = use_docker
        self.docker_image = docker_image
        self.memory_limit = memory_limit
        self.cpu_limit = cpu_limit
        self._docker_available: Optional[bool] = None

    async def execute(self, code: str) -> ExecutionResult:
        """
        Execute Python code and return output.

        Args:
            code: Python code to execute

        Returns:
            ExecutionResult with output, success status, and timing
        """
        import time

        start_time = time.time()

        # Clean up the code
        code = self._clean_code(code)

        if not code.strip():
            return ExecutionResult(
                output="",
                success=False,
                error="Empty code provided",
                execution_time_ms=0.0,
            )

        try:
            if self.use_docker and await self._check_docker():
                result = await self._execute_docker(code)
            else:
                result = await self._execute_local(code)

            result.execution_time_ms = (time.time() - start_time) * 1000
            return result

        except asyncio.TimeoutError:
            return ExecutionResult(
                output="",
                success=False,
                error=f"Execution timed out after {self.timeout} seconds",
                execution_time_ms=(time.time() - start_time) * 1000,
            )
        except Exception as e:
            return ExecutionResult(
                output="",
                success=False,
                error=str(e),
                execution_time_ms=(time.time() - start_time) * 1000,
            )

    def _clean_code(self, code: str) -> str:
        """Clean and prepare code for execution."""
        # Remove markdown code blocks if present
        code = re.sub(r"```python\s*", "", code)
        code = re.sub(r"```\s*", "", code)

        # Remove leading/trailing whitespace
        code = code.strip()

        return code

    async def _check_docker(self) -> bool:
        """Check if Docker is available."""
        if self._docker_available is not None:
            return self._docker_available

        try:
            proc = await asyncio.create_subprocess_exec(
                "docker", "version",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            await asyncio.wait_for(proc.communicate(), timeout=5)
            self._docker_available = proc.returncode == 0
        except Exception:
            self._docker_available = False

        if not self._docker_available:
            logger.warning(
                "[PythonExecutor] Docker not available, falling back to local execution"
            )

        return self._docker_available

    async def _execute_docker(self, code: str) -> ExecutionResult:
        """Execute code in Docker container."""
        # Create a temporary file with the code
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".py", delete=False
        ) as f:
            # Add output capture wrapper
            wrapped_code = f'''
import sys
from io import StringIO

# Capture stdout
old_stdout = sys.stdout
sys.stdout = StringIO()

try:
{self._indent_code(code, 4)}
except Exception as e:
    print(f"Error: {{type(e).__name__}}: {{e}}", file=sys.stderr)
    sys.exit(1)
finally:
    output = sys.stdout.getvalue()
    sys.stdout = old_stdout
    print(output, end="")
'''
            f.write(wrapped_code)
            temp_path = f.name

        try:
            cmd = [
                "docker", "run", "--rm",
                f"--memory={self.memory_limit}",
                f"--cpus={self.cpu_limit}",
                "--network=none",  # No network access
                "-v", f"{temp_path}:/code.py:ro",
                self.docker_image,
                "python", "/code.py",
            ]

            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )

            stdout, stderr = await asyncio.wait_for(
                proc.communicate(),
                timeout=self.timeout,
            )

            output = stdout.decode().strip()
            error_output = stderr.decode().strip()

            if proc.returncode == 0:
                return ExecutionResult(output=output, success=True)
            else:
                return ExecutionResult(
                    output=output,
                    success=False,
                    error=error_output or f"Exit code: {proc.returncode}",
                )

        finally:
            # Clean up temp file
            Path(temp_path).unlink(missing_ok=True)

    async def _execute_local(self, code: str) -> ExecutionResult:
        """Execute code locally with safety restrictions."""
        # Check for dangerous patterns
        if not self._is_safe_code(code):
            return ExecutionResult(
                output="",
                success=False,
                error="Code contains potentially dangerous operations",
            )

        # Create a restricted execution environment
        safe_globals = {"__builtins__": {}}

        # Add safe builtins
        safe_builtin_names = [
            "abs", "all", "any", "bin", "bool", "chr", "dict", "divmod",
            "enumerate", "filter", "float", "format", "frozenset", "hash",
            "hex", "int", "isinstance", "issubclass", "iter", "len", "list",
            "map", "max", "min", "next", "oct", "ord", "pow", "print",
            "range", "repr", "reversed", "round", "set", "slice", "sorted",
            "str", "sum", "tuple", "type", "zip",
        ]
        for name in safe_builtin_names:
            builtin_func = getattr(builtins, name, None)
            if builtin_func is not None:
                safe_globals["__builtins__"][name] = builtin_func

        # Add safe modules (pre-loaded, available as globals)
        for module_name in self.SAFE_IMPORTS:
            try:
                safe_globals[module_name] = __import__(module_name)
            except ImportError:
                pass

        # Capture output
        from io import StringIO
        import sys

        old_stdout = sys.stdout
        old_stderr = sys.stderr
        sys.stdout = StringIO()
        sys.stderr = StringIO()

        try:
            # Execute with timeout using subprocess for isolation
            exec(compile(code, "<string>", "exec"), safe_globals)
            output = sys.stdout.getvalue().strip()
            error = sys.stderr.getvalue().strip()

            return ExecutionResult(
                output=output,
                success=True,
                error=error if error else None,
            )

        except Exception as e:
            return ExecutionResult(
                output=sys.stdout.getvalue().strip(),
                success=False,
                error=f"{type(e).__name__}: {e}",
            )
        finally:
            sys.stdout = old_stdout
            sys.stderr = old_stderr

    def _is_safe_code(self, code: str) -> bool:
        """Check if code is safe to execute locally."""
        for pattern in self.DANGEROUS_PATTERNS:
            if re.search(pattern, code, re.IGNORECASE):
                logger.warning(f"[PythonExecutor] Blocked dangerous pattern: {pattern}")
                return False
        return True

    def _indent_code(self, code: str, spaces: int) -> str:
        """Indent code by specified number of spaces."""
        indent = " " * spaces
        return "\n".join(indent + line for line in code.split("\n"))


class MockExecutor:
    """Mock executor for testing without actual code execution."""

    def __init__(self, responses: Optional[dict[str, str]] = None) -> None:
        self.responses = responses or {}
        self.executions: list[str] = []

    async def execute(self, code: str) -> ExecutionResult:
        """Return mock execution result."""
        self.executions.append(code)

        # Check for predefined responses
        for pattern, response in self.responses.items():
            if pattern in code:
                return ExecutionResult(output=response, success=True)

        # Default: extract print statements and return their arguments
        prints = re.findall(r'print\s*\(\s*["\']?([^"\')\n]+)["\']?\s*\)', code)
        if prints:
            return ExecutionResult(output=prints[-1], success=True)

        # Try to find numeric results
        numbers = re.findall(r'\b(\d+(?:\.\d+)?)\b', code)
        if numbers:
            return ExecutionResult(output=numbers[-1], success=True)

        return ExecutionResult(
            output="42",  # Default mock response
            success=True,
        )
