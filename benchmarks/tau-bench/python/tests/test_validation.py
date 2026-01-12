"""
Tests for data validation in Tau-bench.
"""

import pytest
from elizaos_tau_bench.dataset import TauBenchDataset, DataValidationError
from elizaos_tau_bench.types import TauDomain


class TestDataValidation:
    """Tests for data validation."""

    def test_valid_task_data(self):
        """Test parsing valid task data."""
        dataset = TauBenchDataset("./nonexistent")
        
        valid_data = {
            "task_id": "test_001",
            "user_instruction": "Help me return an order",
            "available_tools": [
                {"name": "get_order", "description": "Get order details"}
            ],
            "expected_tool_calls": [
                {"tool_name": "get_order", "arguments": {"order_id": "123"}}
            ],
            "policy_constraints": [
                {"policy_id": "RETURN", "description": "Returns within 30 days"}
            ],
        }
        
        task = dataset._parse_task(valid_data, TauDomain.RETAIL)
        assert task.task_id == "test_001"
        assert task.user_instruction == "Help me return an order"
        assert len(task.available_tools) == 1
        assert len(task.expected_tool_calls) == 1

    def test_missing_task_id(self):
        """Test that missing task_id raises error."""
        dataset = TauBenchDataset("./nonexistent")
        
        invalid_data = {
            "user_instruction": "Help me",
        }
        
        with pytest.raises(DataValidationError, match="task_id"):
            dataset._parse_task(invalid_data, TauDomain.RETAIL)

    def test_missing_user_instruction(self):
        """Test that missing user_instruction raises error."""
        dataset = TauBenchDataset("./nonexistent")
        
        invalid_data = {
            "task_id": "test_001",
        }
        
        with pytest.raises(DataValidationError, match="user_instruction"):
            dataset._parse_task(invalid_data, TauDomain.RETAIL)

    def test_tool_without_name(self):
        """Test that tool without name raises error."""
        dataset = TauBenchDataset("./nonexistent")
        
        invalid_data = {
            "task_id": "test_001",
            "user_instruction": "Help me",
            "available_tools": [
                {"description": "Missing name"}
            ],
        }
        
        with pytest.raises(DataValidationError, match="tool .* must have 'name'"):
            dataset._parse_task(invalid_data, TauDomain.RETAIL)

    def test_expected_call_without_name(self):
        """Test that expected_tool_call without name raises error."""
        dataset = TauBenchDataset("./nonexistent")
        
        invalid_data = {
            "task_id": "test_001",
            "user_instruction": "Help me",
            "expected_tool_calls": [
                {"arguments": {"order_id": "123"}}
            ],
        }
        
        with pytest.raises(DataValidationError, match="expected_tool_call .* must have"):
            dataset._parse_task(invalid_data, TauDomain.RETAIL)

    def test_alternative_field_names(self):
        """Test that alternative field names work (id vs task_id)."""
        dataset = TauBenchDataset("./nonexistent")
        
        data_with_alt_names = {
            "id": "test_alt",
            "instruction": "Help me with something",
            "goal": "Complete the task",
            "expected_response": "Done!",
            "expected_tool_calls": [
                {"name": "some_tool", "arguments": {}}  # Using 'name' instead of 'tool_name'
            ],
        }
        
        task = dataset._parse_task(data_with_alt_names, TauDomain.RETAIL)
        assert task.task_id == "test_alt"
        assert task.user_instruction == "Help me with something"
        assert task.user_goal == "Complete the task"
        assert task.ground_truth_response == "Done!"
        assert task.expected_tool_calls[0].tool_name == "some_tool"

    def test_invalid_types_handled_gracefully(self):
        """Test that invalid types are handled gracefully."""
        dataset = TauBenchDataset("./nonexistent")
        
        data_with_bad_types = {
            "task_id": "test_001",
            "user_instruction": "Help me",
            "conversation_history": "not a list",  # Should be list
            "success_criteria": {"not": "a list"},  # Should be list
            "initialization_data": ["not", "a", "dict"],  # Should be dict
            "available_tools": [
                {"name": "tool", "parameters": "not a dict"}  # Should be dict
            ],
        }
        
        # Should not raise, just use defaults
        task = dataset._parse_task(data_with_bad_types, TauDomain.RETAIL)
        assert task.conversation_history == []
        assert task.success_criteria == []
        assert task.initialization_data == {}

    def test_numeric_fields_parsed_correctly(self):
        """Test that numeric fields are parsed as integers."""
        dataset = TauBenchDataset("./nonexistent")
        
        data = {
            "task_id": "test_001",
            "user_instruction": "Help me",
            "max_turns": "20",  # String that should become int
            "timeout_ms": 60000.5,  # Float that should become int
        }
        
        task = dataset._parse_task(data, TauDomain.RETAIL)
        assert task.max_turns == 20
        assert task.timeout_ms == 60000
        assert isinstance(task.max_turns, int)
        assert isinstance(task.timeout_ms, int)
