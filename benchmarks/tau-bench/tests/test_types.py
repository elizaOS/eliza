"""
Tests for Tau-bench types.
"""

import pytest
from elizaos_tau_bench.types import (
    TauDomain,
    ToolCallStatus,
    TaskDifficulty,
    ToolDefinition,
    ToolCall,
    TauBenchTask,
    TauBenchResult,
    PassKMetrics,
    TauBenchConfig,
)


class TestToolDefinition:
    """Tests for ToolDefinition."""

    def test_create_tool_definition(self):
        """Test creating a tool definition."""
        tool = ToolDefinition(
            name="test_tool",
            description="A test tool",
            parameters={
                "type": "object",
                "properties": {
                    "param1": {"type": "string"}
                },
            },
        )
        assert tool.name == "test_tool"
        assert tool.description == "A test tool"

    def test_tool_to_dict(self):
        """Test converting tool to dictionary."""
        tool = ToolDefinition(
            name="get_order",
            description="Get order details",
            parameters={"type": "object"},
            returns={"type": "object"},
        )
        d = tool.to_dict()
        assert d["name"] == "get_order"
        assert "parameters" in d


class TestToolCall:
    """Tests for ToolCall."""

    def test_create_tool_call(self):
        """Test creating a tool call."""
        call = ToolCall(
            tool_name="get_order_details",
            arguments={"order_id": "ORD-123"},
        )
        assert call.tool_name == "get_order_details"
        assert call.arguments["order_id"] == "ORD-123"
        assert call.result is None
        assert call.status == ToolCallStatus.CORRECT

    def test_tool_call_with_result(self):
        """Test tool call with result."""
        call = ToolCall(
            tool_name="get_order_details",
            arguments={"order_id": "ORD-123"},
            result={"status": "delivered"},
            status=ToolCallStatus.CORRECT,
        )
        assert call.result["status"] == "delivered"

    def test_tool_call_to_dict(self):
        """Test converting tool call to dictionary."""
        call = ToolCall(
            tool_name="test",
            arguments={"a": 1},
            result="ok",
        )
        d = call.to_dict()
        assert d["tool_name"] == "test"
        assert d["result"] == "ok"


class TestPassKMetrics:
    """Tests for Pass^k metric calculation."""

    def test_calculate_pass_1(self):
        """Test Pass^1 calculation."""
        results = [
            TauBenchResult(task_id="t1", domain=TauDomain.RETAIL, success=True),
            TauBenchResult(task_id="t2", domain=TauDomain.RETAIL, success=True),
            TauBenchResult(task_id="t3", domain=TauDomain.RETAIL, success=False),
        ]
        metrics = PassKMetrics.calculate(results, k=1)
        assert metrics.k == 1
        # 2 out of 3 tasks passed on first trial
        assert metrics.pass_rate == pytest.approx(2/3, rel=0.01)

    def test_calculate_pass_2(self):
        """Test Pass^2 calculation - stricter than Pass^1."""
        # Task t1: trial 1 pass, trial 2 pass -> passes
        # Task t2: trial 1 pass, trial 2 fail -> fails
        # Task t3: trial 1 fail, trial 2 fail -> fails
        results = [
            TauBenchResult(task_id="t1", domain=TauDomain.RETAIL, trial_number=1, success=True),
            TauBenchResult(task_id="t1", domain=TauDomain.RETAIL, trial_number=2, success=True),
            TauBenchResult(task_id="t2", domain=TauDomain.RETAIL, trial_number=1, success=True),
            TauBenchResult(task_id="t2", domain=TauDomain.RETAIL, trial_number=2, success=False),
            TauBenchResult(task_id="t3", domain=TauDomain.RETAIL, trial_number=1, success=False),
            TauBenchResult(task_id="t3", domain=TauDomain.RETAIL, trial_number=2, success=False),
        ]
        metrics = PassKMetrics.calculate(results, k=2)
        # Only t1 passes both trials
        assert metrics.pass_rate == pytest.approx(1/3, rel=0.01)

    def test_calculate_empty_results(self):
        """Test Pass^k with empty results."""
        metrics = PassKMetrics.calculate([], k=1)
        assert metrics.pass_rate == 0.0
        assert metrics.total_trials == 0


class TestTauBenchTask:
    """Tests for TauBenchTask."""

    def test_create_task(self, sample_retail_task):
        """Test creating a task."""
        assert sample_retail_task.task_id == "test_retail_001"
        assert sample_retail_task.domain == TauDomain.RETAIL
        assert len(sample_retail_task.available_tools) == 2

    def test_task_defaults(self):
        """Test task default values."""
        task = TauBenchTask(
            task_id="t1",
            domain=TauDomain.RETAIL,
            user_instruction="Help me",
        )
        assert task.max_turns == 15
        assert task.timeout_ms == 120000
        assert task.difficulty == TaskDifficulty.MEDIUM


class TestTauBenchConfig:
    """Tests for TauBenchConfig."""

    def test_default_config(self):
        """Test default configuration values."""
        config = TauBenchConfig()
        assert TauDomain.RETAIL in config.domains
        assert TauDomain.AIRLINE in config.domains
        assert config.num_trials == 1

    def test_get_enabled_domains(self, default_config):
        """Test getting enabled domains."""
        domains = default_config.get_enabled_domains()
        assert TauDomain.RETAIL in domains
        assert TauDomain.AIRLINE in domains
