"""Tests for Terminal-Bench environment."""

import pytest
from datetime import datetime

from elizaos_terminal_bench.environment import (
    MockTerminalEnvironment,
    TerminalEnvironment,
    TerminalEnvironmentError,
)
from elizaos_terminal_bench.types import (
    CommandStatus,
    TaskCategory,
    TaskDifficulty,
    TerminalTask,
)


class TestMockTerminalEnvironment:
    """Test MockTerminalEnvironment class."""

    @pytest.mark.asyncio
    async def test_start_stop(self) -> None:
        """Test starting and stopping mock environment."""
        env = MockTerminalEnvironment()

        await env.start()
        assert env._started is True

        await env.stop()
        assert env._started is False

    @pytest.mark.asyncio
    async def test_execute_command(self) -> None:
        """Test executing a command."""
        env = MockTerminalEnvironment()
        await env.start()

        result = await env.execute("ls -la")

        assert result.command == "ls -la"
        assert result.exit_code == 0
        assert result.status == CommandStatus.SUCCESS

        await env.stop()

    @pytest.mark.asyncio
    async def test_mock_response(self) -> None:
        """Test setting mock responses."""
        env = MockTerminalEnvironment()
        env.set_mock_response("echo", "hello world", "", 0)
        await env.start()

        result = await env.execute("echo 'test'")

        assert result.stdout == "hello world"
        assert result.exit_code == 0

        await env.stop()

    @pytest.mark.asyncio
    async def test_mock_error_response(self) -> None:
        """Test mock error response."""
        env = MockTerminalEnvironment()
        env.set_mock_response("fail_cmd", "", "error message", 1)
        await env.start()

        result = await env.execute("fail_cmd")

        assert result.stderr == "error message"
        assert result.exit_code == 1
        assert result.status == CommandStatus.FAILED

        await env.stop()

    @pytest.mark.asyncio
    async def test_run_test(self) -> None:
        """Test running a test script."""
        env = MockTerminalEnvironment()
        await env.start()

        success, output, exit_code = await env.run_test("exit 0")

        assert success is True
        assert exit_code == 0

        await env.stop()

    @pytest.mark.asyncio
    async def test_context_manager(self) -> None:
        """Test using environment as context manager."""
        async with MockTerminalEnvironment() as env:
            assert env._started is True
            result = await env.execute("pwd")
            assert result.exit_code == 0

        assert env._started is False


class TestTerminalEnvironmentNoDocker:
    """Test TerminalEnvironment initialization without Docker."""

    def test_initialization(self) -> None:
        """Test environment initialization parameters."""
        env = TerminalEnvironment(
            image="python:3.11",
            memory_limit="4g",
            cpu_limit=2.0,
            network_mode="bridge",
            working_dir="/app",
            timeout_seconds=600,
        )

        assert env.image == "python:3.11"
        assert env.memory_limit == "4g"
        assert env.cpu_limit == 2.0
        assert env.network_mode == "bridge"
        assert env.working_dir == "/app"
        assert env.timeout_seconds == 600

    def test_is_started_false_initially(self) -> None:
        """Test that environment is not started initially."""
        env = TerminalEnvironment()
        assert env.is_started is False


@pytest.mark.docker
class TestTerminalEnvironmentDocker:
    """Test TerminalEnvironment with Docker (integration tests)."""

    @pytest.mark.asyncio
    async def test_start_and_stop(self) -> None:
        """Test starting and stopping Docker environment."""
        env = TerminalEnvironment(
            image="ubuntu:22.04",
            timeout_seconds=30,
        )

        try:
            await env.start()
            assert env.is_started is True
        finally:
            await env.stop()
            assert env.is_started is False

    @pytest.mark.asyncio
    async def test_execute_simple_command(self) -> None:
        """Test executing a simple command in Docker."""
        env = TerminalEnvironment(timeout_seconds=30)

        try:
            await env.start()

            result = await env.execute("echo 'hello world'")

            assert result.exit_code == 0
            assert "hello world" in result.stdout

        finally:
            await env.stop()

    @pytest.mark.asyncio
    async def test_execute_with_working_directory(self) -> None:
        """Test command execution in specific directory."""
        env = TerminalEnvironment(working_dir="/tmp")

        try:
            await env.start()

            result = await env.execute("pwd")

            assert "/tmp" in result.stdout or "/workspace" in result.stdout

        finally:
            await env.stop()

    @pytest.mark.asyncio
    async def test_file_operations(self) -> None:
        """Test file read/write operations."""
        env = TerminalEnvironment()

        try:
            await env.start()

            # Write file
            success = await env.write_file("/workspace/test.txt", "hello content")
            assert success is True

            # Read file
            content = await env.get_file_content("/workspace/test.txt")
            assert "hello content" in content

            # Check file exists
            exists = await env.file_exists("/workspace/test.txt")
            assert exists is True

        finally:
            await env.stop()

    @pytest.mark.asyncio
    async def test_directory_operations(self) -> None:
        """Test directory operations."""
        env = TerminalEnvironment()

        try:
            await env.start()

            # Create directory
            result = await env.execute("mkdir -p /workspace/test_dir")
            assert result.exit_code == 0

            # Check directory exists
            exists = await env.directory_exists("/workspace/test_dir")
            assert exists is True

            # List directory
            entries = await env.list_directory("/workspace")
            assert len(entries) > 0

        finally:
            await env.stop()

    @pytest.mark.asyncio
    async def test_run_test_script(self) -> None:
        """Test running a test script."""
        env = TerminalEnvironment()

        try:
            await env.start()

            # Create a file
            await env.execute("echo 'test content' > /workspace/result.txt")

            # Test script that checks for file
            test_script = """#!/bin/bash
if [ -f /workspace/result.txt ]; then
    exit 0
else
    exit 1
fi
"""
            success, output, exit_code = await env.run_test(test_script)

            assert success is True
            assert exit_code == 0

        finally:
            await env.stop()

    @pytest.mark.asyncio
    async def test_task_with_setup_script(self) -> None:
        """Test environment with task setup script."""
        task = TerminalTask(
            task_id="test_task",
            instruction="Test",
            category=TaskCategory.SCRIPTING,
            difficulty=TaskDifficulty.EASY,
            test_script="exit 0",
            reference_solution="",
            setup_script="touch /workspace/setup_marker",
        )

        env = TerminalEnvironment()

        try:
            await env.start(task)

            # Check setup script ran
            exists = await env.file_exists("/workspace/setup_marker")
            assert exists is True

        finally:
            await env.stop()

    @pytest.mark.asyncio
    async def test_cleanup_workspace(self) -> None:
        """Test workspace cleanup."""
        env = TerminalEnvironment()

        try:
            await env.start()

            # Create some files
            await env.execute("touch /workspace/file1.txt /workspace/file2.txt")

            # Verify files exist
            entries_before = await env.list_directory("/workspace")
            assert len([e for e in entries_before if "file" in e]) > 0

            # Cleanup
            await env.cleanup_workspace()

            # Verify files are gone
            entries_after = await env.list_directory("/workspace")
            assert all("file" not in e for e in entries_after)

        finally:
            await env.stop()
