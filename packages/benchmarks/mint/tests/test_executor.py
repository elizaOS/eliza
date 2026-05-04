"""
Tests for MINT Python executor.
"""

import pytest

from benchmarks.mint.executor import PythonExecutor, MockExecutor, ExecutionResult


class TestPythonExecutor:
    """Tests for PythonExecutor class."""

    @pytest.fixture
    def executor(self) -> PythonExecutor:
        """Create an executor instance (no Docker for tests)."""
        return PythonExecutor(timeout=10, use_docker=False)

    @pytest.mark.asyncio
    async def test_simple_calculation(self, executor: PythonExecutor) -> None:
        """Test executing a simple calculation."""
        result = await executor.execute("print(2 + 2)")
        assert result.success is True
        assert "4" in result.output

    @pytest.mark.asyncio
    async def test_multiline_code(self, executor: PythonExecutor) -> None:
        """Test executing multiline code."""
        code = """
x = 10
y = 20
print(x + y)
"""
        result = await executor.execute(code)
        assert result.success is True
        assert "30" in result.output

    @pytest.mark.asyncio
    async def test_with_imports(self, executor: PythonExecutor) -> None:
        """Test code with safe imports (pre-loaded modules)."""
        # In local sandboxed mode, modules are pre-loaded as globals
        # This tests that math is available
        code = """
result = math.sqrt(16)
print(result)
"""
        result = await executor.execute(code)
        assert result.success is True
        assert "4" in result.output

    @pytest.mark.asyncio
    async def test_empty_code(self, executor: PythonExecutor) -> None:
        """Test executing empty code."""
        result = await executor.execute("")
        assert result.success is False
        assert "Empty code" in str(result.error)

    @pytest.mark.asyncio
    async def test_syntax_error(self, executor: PythonExecutor) -> None:
        """Test code with syntax error."""
        result = await executor.execute("print(")
        assert result.success is False
        assert result.error is not None

    @pytest.mark.asyncio
    async def test_runtime_error(self, executor: PythonExecutor) -> None:
        """Test code with runtime error."""
        result = await executor.execute("print(1/0)")
        assert result.success is False
        assert "ZeroDivision" in str(result.error) or result.error is not None

    @pytest.mark.asyncio
    async def test_markdown_code_block_cleanup(self, executor: PythonExecutor) -> None:
        """Test cleaning up markdown code blocks."""
        code = """```python
print(42)
```"""
        result = await executor.execute(code)
        assert result.success is True
        assert "42" in result.output

    @pytest.mark.asyncio
    async def test_execution_time_tracked(self, executor: PythonExecutor) -> None:
        """Test that execution time is tracked."""
        result = await executor.execute("print('hello')")
        assert result.execution_time_ms > 0

    @pytest.mark.asyncio
    async def test_list_comprehension(self, executor: PythonExecutor) -> None:
        """Test list comprehension."""
        code = """
result = [x**2 for x in range(5)]
print(sum(result))
"""
        result = await executor.execute(code)
        assert result.success is True
        assert "30" in result.output  # 0+1+4+9+16=30


class TestMockExecutor:
    """Tests for MockExecutor class."""

    @pytest.mark.asyncio
    async def test_mock_with_predefined_response(self) -> None:
        """Test mock executor with predefined responses."""
        mock = MockExecutor(responses={"sqrt": "4.0"})
        result = await mock.execute("import math; print(math.sqrt(16))")
        assert result.success is True
        assert result.output == "4.0"

    @pytest.mark.asyncio
    async def test_mock_tracks_executions(self) -> None:
        """Test mock executor tracks all executions."""
        mock = MockExecutor()
        await mock.execute("print(1)")
        await mock.execute("print(2)")
        
        assert len(mock.executions) == 2
        assert "print(1)" in mock.executions[0]

    @pytest.mark.asyncio
    async def test_mock_extracts_print_output(self) -> None:
        """Test mock executor extracts print statements."""
        mock = MockExecutor()
        result = await mock.execute("x = 10; print('hello')")
        assert result.success is True
        assert result.output == "hello"

    @pytest.mark.asyncio
    async def test_mock_default_response(self) -> None:
        """Test mock executor default response."""
        mock = MockExecutor()
        result = await mock.execute("complex_code_without_print()")
        assert result.success is True


class TestExecutionResult:
    """Tests for ExecutionResult class."""

    def test_successful_result(self) -> None:
        """Test creating a successful result."""
        result = ExecutionResult(output="42", success=True)
        assert result.output == "42"
        assert result.success is True
        assert result.error is None

    def test_failed_result(self) -> None:
        """Test creating a failed result."""
        result = ExecutionResult(
            output="",
            success=False,
            error="Division by zero",
        )
        assert result.success is False
        assert result.error == "Division by zero"

    def test_result_with_timing(self) -> None:
        """Test result with execution time."""
        result = ExecutionResult(
            output="done",
            success=True,
            execution_time_ms=123.45,
        )
        assert result.execution_time_ms == 123.45
