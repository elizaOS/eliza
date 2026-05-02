"""Tests for Terminal-Bench agent."""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from elizaos_terminal_bench.agent import TerminalAgent, SYSTEM_PROMPT
from elizaos_terminal_bench.environment import MockTerminalEnvironment
from elizaos_terminal_bench.types import (
    TaskCategory,
    TaskDifficulty,
    TerminalTask,
)


class TestTerminalAgent:
    """Test TerminalAgent class."""

    @pytest.fixture
    def sample_task(self) -> TerminalTask:
        """Create a sample task for testing."""
        return TerminalTask(
            task_id="test_001",
            instruction="Create a file called test.txt with 'hello' content",
            category=TaskCategory.FILE_OPERATIONS,
            difficulty=TaskDifficulty.EASY,
            test_script="#!/bin/bash\ntest -f /workspace/test.txt && grep -q 'hello' /workspace/test.txt",
            reference_solution="echo 'hello' > /workspace/test.txt",
            timeout_seconds=60,
        )

    @pytest.fixture
    def mock_environment(self) -> MockTerminalEnvironment:
        """Create a mock terminal environment."""
        env = MockTerminalEnvironment()
        env.set_mock_response("ls", "test.txt\n", "", 0)
        env.set_mock_response("cat", "hello\n", "", 0)
        env.set_mock_response("echo", "", "", 0)
        return env

    def test_system_prompt_content(self) -> None:
        """Test system prompt contains necessary instructions."""
        assert "ACTION: EXECUTE" in SYSTEM_PROMPT
        assert "ACTION: READ_FILE" in SYSTEM_PROMPT
        assert "ACTION: WRITE_FILE" in SYSTEM_PROMPT
        assert "TASK_COMPLETE" in SYSTEM_PROMPT

    def test_agent_initialization(self) -> None:
        """Test agent initialization."""
        agent = TerminalAgent(
            max_iterations=10,
            model_name="gpt-4",
            temperature=0.1,
        )

        assert agent.max_iterations == 10
        assert agent.model_name == "gpt-4"
        assert agent.temperature == 0.1
        assert agent.runtime is None

    def test_agent_with_environment(self, mock_environment: MockTerminalEnvironment) -> None:
        """Test agent with custom environment."""
        agent = TerminalAgent(environment=mock_environment)

        assert agent.environment is mock_environment

    def test_build_task_prompt(self, sample_task: TerminalTask) -> None:
        """Test task prompt generation."""
        agent = TerminalAgent()
        prompt = agent._build_task_prompt(sample_task)

        assert sample_task.instruction in prompt
        assert sample_task.category.value in prompt
        assert sample_task.difficulty.value in prompt
        assert str(sample_task.timeout_seconds) in prompt

    def test_extract_command_from_code_block(self) -> None:
        """Test extracting command from code block."""
        agent = TerminalAgent()

        response = """I'll create the file.
```bash
echo 'hello' > test.txt
```
"""
        command = agent._extract_command_from_response(response)
        assert command == "echo 'hello' > test.txt"

    def test_extract_command_from_command_prefix(self) -> None:
        """Test extracting command with COMMAND: prefix."""
        agent = TerminalAgent()

        response = "COMMAND: ls -la /workspace"
        command = agent._extract_command_from_response(response)
        assert command == "ls -la /workspace"

    def test_extract_command_no_command(self) -> None:
        """Test when no command is found."""
        agent = TerminalAgent()

        response = "Let me think about this..."
        command = agent._extract_command_from_response(response)
        assert command is None


class TestAgentActionParsing:
    """Test action parsing in agent."""

    @pytest.fixture
    def agent(self) -> TerminalAgent:
        """Create agent for testing."""
        return TerminalAgent()

    @pytest.mark.asyncio
    async def test_parse_execute_action(self, agent: TerminalAgent) -> None:
        """Test parsing EXECUTE action."""
        mock_env = MockTerminalEnvironment()
        await mock_env.start()
        agent.environment = mock_env
        agent._session = MagicMock()
        agent._session.commands = []

        response = """ACTION: EXECUTE
COMMAND: ls -la"""

        result, completed = await agent._parse_and_execute_action(response)

        assert completed is False
        assert "Exit code:" in result

        await mock_env.stop()

    @pytest.mark.asyncio
    async def test_parse_task_complete(self, agent: TerminalAgent) -> None:
        """Test parsing TASK_COMPLETE action."""
        response = "ACTION: TASK_COMPLETE"

        result, completed = await agent._parse_and_execute_action(response)

        assert completed is True

    @pytest.mark.asyncio
    async def test_parse_read_file_action(self, agent: TerminalAgent) -> None:
        """Test parsing READ_FILE action."""
        mock_env = MockTerminalEnvironment()
        mock_env.set_mock_response("cat", "file content", "", 0)
        await mock_env.start()
        agent.environment = mock_env

        response = """ACTION: READ_FILE
PATH: /workspace/test.txt"""

        result, completed = await agent._parse_and_execute_action(response)

        assert completed is False
        assert "file content" in result or "File content" in result

        await mock_env.stop()

    @pytest.mark.asyncio
    async def test_parse_list_dir_action(self, agent: TerminalAgent) -> None:
        """Test parsing LIST_DIR action."""
        mock_env = MockTerminalEnvironment()
        mock_env.set_mock_response("ls", "file1.txt\nfile2.txt", "", 0)
        await mock_env.start()
        agent.environment = mock_env

        response = """ACTION: LIST_DIR
PATH: /workspace"""

        result, completed = await agent._parse_and_execute_action(response)

        assert completed is False
        assert "Directory listing" in result

        await mock_env.stop()

    @pytest.mark.asyncio
    async def test_parse_multiple_action_blocks(self, agent: TerminalAgent) -> None:
        """Test parsing multiple ACTION blocks in one response."""
        from datetime import datetime

        from elizaos_terminal_bench.types import TerminalCommand

        mock_env = MagicMock()
        mock_env.execute = AsyncMock(
            side_effect=[
                TerminalCommand(
                    command="write_a",
                    stdout="",
                    stderr="",
                    exit_code=0,
                    execution_time_ms=1.0,
                    timestamp=datetime.now(),
                ),
                TerminalCommand(
                    command="write_b",
                    stdout="",
                    stderr="",
                    exit_code=0,
                    execution_time_ms=1.0,
                    timestamp=datetime.now(),
                ),
            ]
        )
        agent.environment = mock_env
        agent._session = MagicMock()
        agent._session.commands = []

        response = """ACTION: WRITE_FILE
PATH: /workspace/a.txt
CONTENT: |
hello

ACTION: WRITE_FILE
PATH: /workspace/b.txt
CONTENT: |
world
"""

        result, completed = await agent._parse_and_execute_action(response)

        assert completed is False
        assert "Successfully wrote" in result

        assert mock_env.execute.await_count == 2

        # Verify content for the first write doesn't accidentally include the second ACTION block.
        first_cmd = mock_env.execute.await_args_list[0].args[0]
        second_cmd = mock_env.execute.await_args_list[1].args[0]

        assert "/workspace/a.txt" in first_cmd
        assert "hello" in first_cmd
        assert "/workspace/b.txt" not in first_cmd
        assert "world" not in first_cmd

        assert "/workspace/b.txt" in second_cmd
        assert "world" in second_cmd


class TestAgentIntegration:
    """Integration tests for agent (requires mocking)."""

    @pytest.fixture
    def sample_task(self) -> TerminalTask:
        """Create a sample task."""
        return TerminalTask(
            task_id="integration_001",
            instruction="Echo 'hello' to stdout",
            category=TaskCategory.SCRIPTING,
            difficulty=TaskDifficulty.EASY,
            test_script="exit 0",  # Always pass for testing
            reference_solution="echo 'hello'",
            timeout_seconds=30,
        )

    @pytest.mark.asyncio
    async def test_solve_task_with_mock(self, sample_task: TerminalTask) -> None:
        """Test solving a task with mocked LLM."""
        mock_env = MockTerminalEnvironment()
        mock_env.set_mock_response("echo", "hello", "", 0)

        agent = TerminalAgent(
            environment=mock_env,
            max_iterations=3,
        )

        # Mock the LLM response
        async def mock_llm_response():
            return (
                "ACTION: EXECUTE\nCOMMAND: echo 'hello'\n\nACTION: TASK_COMPLETE",
                50,
            )

        with patch.object(agent, "_get_llm_response", mock_llm_response):
            result = await agent.solve_task(sample_task)

        # The mock environment test always passes
        assert result.task_id == sample_task.task_id
        assert result.session is not None
        assert any("echo" in cmd.command for cmd in result.session.commands)

    @pytest.mark.asyncio
    async def test_agent_cleanup(self) -> None:
        """Test agent cleanup after task."""
        mock_env = MockTerminalEnvironment()
        agent = TerminalAgent(environment=mock_env)

        await agent.close()

        assert agent.environment is None
