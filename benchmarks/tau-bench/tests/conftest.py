"""
Pytest configuration and fixtures for Tau-bench tests.
"""

import pytest
from elizaos_tau_bench.types import (
    TauBenchTask,
    TauBenchConfig,
    TauDomain,
    TaskDifficulty,
    ToolDefinition,
    ToolCall,
    PolicyConstraint,
)


@pytest.fixture
def sample_retail_task() -> TauBenchTask:
    """Create a sample retail task for testing."""
    return TauBenchTask(
        task_id="test_retail_001",
        domain=TauDomain.RETAIL,
        user_instruction="I want to return my order #ORD-12345",
        user_profile="Test customer",
        user_goal="Initiate return",
        conversation_history=[],
        available_tools=[
            ToolDefinition(
                name="get_order_details",
                description="Get order details",
                parameters={
                    "type": "object",
                    "properties": {
                        "order_id": {"type": "string"}
                    },
                    "required": ["order_id"],
                },
            ),
            ToolDefinition(
                name="initiate_return",
                description="Start a return",
                parameters={
                    "type": "object",
                    "properties": {
                        "order_id": {"type": "string"},
                        "reason": {"type": "string"},
                    },
                    "required": ["order_id"],
                },
            ),
        ],
        expected_tool_calls=[
            ToolCall(tool_name="get_order_details", arguments={"order_id": "ORD-12345"}),
            ToolCall(tool_name="initiate_return", arguments={"order_id": "ORD-12345"}),
        ],
        policy_constraints=[
            PolicyConstraint(
                policy_id="RETURN_WINDOW",
                description="Returns within 30 days",
                check_function="check_return_window",
            ),
        ],
        ground_truth_response="Return initiated for order ORD-12345",
        success_criteria=["return_initiated"],
        difficulty=TaskDifficulty.EASY,
    )


@pytest.fixture
def sample_airline_task() -> TauBenchTask:
    """Create a sample airline task for testing."""
    return TauBenchTask(
        task_id="test_airline_001",
        domain=TauDomain.AIRLINE,
        user_instruction="Cancel my booking BK-123456",
        user_profile="Test passenger",
        user_goal="Cancel booking",
        conversation_history=[],
        available_tools=[
            ToolDefinition(
                name="get_booking_details",
                description="Get booking details",
                parameters={
                    "type": "object",
                    "properties": {
                        "booking_id": {"type": "string"}
                    },
                    "required": ["booking_id"],
                },
            ),
            ToolDefinition(
                name="cancel_booking",
                description="Cancel a booking",
                parameters={
                    "type": "object",
                    "properties": {
                        "booking_id": {"type": "string"},
                        "reason": {"type": "string"},
                    },
                    "required": ["booking_id"],
                },
            ),
        ],
        expected_tool_calls=[
            ToolCall(tool_name="get_booking_details", arguments={"booking_id": "BK-123456"}),
            ToolCall(tool_name="cancel_booking", arguments={"booking_id": "BK-123456"}),
        ],
        policy_constraints=[],
        ground_truth_response="Booking BK-123456 has been cancelled",
        success_criteria=["booking_cancelled"],
        difficulty=TaskDifficulty.EASY,
    )


@pytest.fixture
def default_config() -> TauBenchConfig:
    """Create a default benchmark configuration."""
    return TauBenchConfig(
        data_path="./test-data",
        output_dir="./test-output",
        domains=[TauDomain.RETAIL, TauDomain.AIRLINE],
        max_tasks=5,
        num_trials=1,
        timeout_ms=30000,
        save_detailed_logs=False,
        enable_memory_tracking=False,
    )
