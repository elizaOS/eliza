"""Tests for Terminal-Bench type definitions."""

import pytest
from datetime import datetime

from elizaos_terminal_bench.types import (
    TaskCategory,
    TaskDifficulty,
    CommandStatus,
    TerminalTask,
    TerminalCommand,
    TerminalSession,
    TerminalBenchResult,
    TerminalBenchReport,
    TerminalBenchConfig,
    CategoryMetrics,
    DifficultyMetrics,
    LeaderboardComparison,
    LEADERBOARD_SCORES,
    SAMPLE_TASKS,
)


class TestEnums:
    """Test enum definitions."""

    def test_task_category_values(self) -> None:
        """Test TaskCategory enum values."""
        assert TaskCategory.CODE_COMPILATION.value == "code_compilation"
        assert TaskCategory.SYSTEM_ADMIN.value == "system_admin"
        assert TaskCategory.SCRIPTING.value == "scripting"

    def test_task_difficulty_values(self) -> None:
        """Test TaskDifficulty enum values."""
        assert TaskDifficulty.EASY.value == "easy"
        assert TaskDifficulty.MEDIUM.value == "medium"
        assert TaskDifficulty.HARD.value == "hard"

    def test_command_status_values(self) -> None:
        """Test CommandStatus enum values."""
        assert CommandStatus.SUCCESS.value == "success"
        assert CommandStatus.FAILED.value == "failed"
        assert CommandStatus.TIMEOUT.value == "timeout"


class TestTerminalTask:
    """Test TerminalTask dataclass."""

    def test_minimal_task(self) -> None:
        """Test creating a task with minimal fields."""
        task = TerminalTask(
            task_id="test_001",
            instruction="Test instruction",
            category=TaskCategory.SCRIPTING,
            difficulty=TaskDifficulty.EASY,
            test_script="#!/bin/bash\nexit 0",
            reference_solution="echo 'hello'",
        )

        assert task.task_id == "test_001"
        assert task.timeout_seconds == 300  # Default
        assert task.docker_image == "ubuntu:22.04"  # Default
        assert task.network_enabled is False  # Default

    def test_full_task(self) -> None:
        """Test creating a task with all fields."""
        task = TerminalTask(
            task_id="test_002",
            instruction="Full test",
            category=TaskCategory.CODE_COMPILATION,
            difficulty=TaskDifficulty.HARD,
            test_script="exit 0",
            reference_solution="gcc -o main main.c",
            timeout_seconds=600,
            required_tools=["gcc", "make"],
            initial_state="mkdir /workspace/build",
            setup_script="apt-get install -y build-essential",
            docker_image="gcc:latest",
            network_enabled=True,
            expected_files=["main", "main.c"],
            metadata={"author": "test"},
        )

        assert task.timeout_seconds == 600
        assert task.docker_image == "gcc:latest"
        assert task.network_enabled is True
        assert len(task.required_tools) == 2


class TestTerminalCommand:
    """Test TerminalCommand dataclass."""

    def test_command_creation(self) -> None:
        """Test creating a terminal command record."""
        cmd = TerminalCommand(
            command="ls -la",
            stdout="total 0",
            stderr="",
            exit_code=0,
            execution_time_ms=15.5,
            timestamp=datetime.now(),
        )

        assert cmd.command == "ls -la"
        assert cmd.exit_code == 0
        assert cmd.status == CommandStatus.SUCCESS

    def test_command_with_error(self) -> None:
        """Test command with error status."""
        cmd = TerminalCommand(
            command="invalid_command",
            stdout="",
            stderr="command not found",
            exit_code=127,
            execution_time_ms=5.0,
            timestamp=datetime.now(),
            status=CommandStatus.FAILED,
        )

        assert cmd.exit_code == 127
        assert cmd.status == CommandStatus.FAILED


class TestTerminalSession:
    """Test TerminalSession dataclass."""

    def test_session_creation(self) -> None:
        """Test creating a terminal session."""
        task = TerminalTask(
            task_id="test",
            instruction="Test",
            category=TaskCategory.SCRIPTING,
            difficulty=TaskDifficulty.EASY,
            test_script="exit 0",
            reference_solution="echo test",
        )

        session = TerminalSession(
            session_id="session_001",
            task=task,
        )

        assert session.session_id == "session_001"
        assert session.working_directory == "/workspace"
        assert len(session.commands) == 0


class TestTerminalBenchResult:
    """Test TerminalBenchResult dataclass."""

    def test_successful_result(self) -> None:
        """Test creating a successful result."""
        result = TerminalBenchResult(
            task_id="test_001",
            success=True,
            commands_executed=5,
            total_execution_time_ms=1500.0,
            test_output="Test passed",
            test_exit_code=0,
            tokens_used=500,
        )

        assert result.success is True
        assert result.test_exit_code == 0
        assert result.error_message is None

    def test_failed_result(self) -> None:
        """Test creating a failed result."""
        result = TerminalBenchResult(
            task_id="test_002",
            success=False,
            commands_executed=3,
            total_execution_time_ms=800.0,
            test_output="Test failed: file not found",
            test_exit_code=1,
            error_message="Missing expected file",
        )

        assert result.success is False
        assert result.error_message is not None


class TestTerminalBenchConfig:
    """Test TerminalBenchConfig dataclass."""

    def test_default_config(self) -> None:
        """Test default configuration."""
        config = TerminalBenchConfig()

        assert config.version == "2.0"
        assert config.max_iterations == 20
        assert config.docker_image == "ubuntu:22.04"
        assert config.model_name == "gpt-5-mini"
        assert config.temperature == 0.0

    def test_custom_config(self) -> None:
        """Test custom configuration."""
        config = TerminalBenchConfig(
            data_path="/custom/path",
            version="1.0",
            max_tasks=50,
            model_name="gpt-4-turbo",
            verbose=True,
        )

        assert config.data_path == "/custom/path"
        assert config.version == "1.0"
        assert config.max_tasks == 50


class TestLeaderboardScores:
    """Test leaderboard data."""

    def test_leaderboard_structure(self) -> None:
        """Test that leaderboard data has expected structure."""
        assert "Droid (Factory) + GPT-5.2" in LEADERBOARD_SCORES
        assert "Human Expert" in LEADERBOARD_SCORES

        for name, scores in LEADERBOARD_SCORES.items():
            assert "overall" in scores
            assert isinstance(scores["overall"], float)

    def test_human_baseline(self) -> None:
        """Test human expert baseline is highest."""
        human_score = LEADERBOARD_SCORES["Human Expert"]["overall"]

        for name, scores in LEADERBOARD_SCORES.items():
            if name != "Human Expert":
                assert scores["overall"] < human_score


class TestSampleTasks:
    """Test sample tasks data."""

    def test_sample_tasks_exist(self) -> None:
        """Test that sample tasks are defined."""
        assert len(SAMPLE_TASKS) > 0

    def test_sample_task_structure(self) -> None:
        """Test sample task structure."""
        for task in SAMPLE_TASKS:
            assert "task_id" in task
            assert "instruction" in task
            assert "test_script" in task
            assert "reference_solution" in task


class TestMetrics:
    """Test metrics dataclasses."""

    def test_category_metrics(self) -> None:
        """Test CategoryMetrics dataclass."""
        metrics = CategoryMetrics(
            total=10,
            passed=7,
            failed=3,
            accuracy=0.7,
            avg_commands=5.5,
            avg_time_ms=1200.0,
        )

        assert metrics.total == 10
        assert metrics.accuracy == 0.7

    def test_difficulty_metrics(self) -> None:
        """Test DifficultyMetrics dataclass."""
        metrics = DifficultyMetrics(
            total=20,
            passed=15,
            failed=5,
            accuracy=0.75,
        )

        assert metrics.total == 20
        assert metrics.accuracy == 0.75

    def test_leaderboard_comparison(self) -> None:
        """Test LeaderboardComparison dataclass."""
        comparison = LeaderboardComparison(
            our_score=55.0,
            rank=5,
            total_entries=10,
            comparison={"Agent A": 60.0, "Agent B": 50.0},
            percentile=60.0,
            nearest_above=("Agent A", 60.0),
            nearest_below=("Agent B", 50.0),
        )

        assert comparison.rank == 5
        assert comparison.percentile == 60.0
