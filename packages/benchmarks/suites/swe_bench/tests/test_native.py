"""Native coding receipts are transport evidence, not issue-resolution scores."""
import json

import pytest

from benchmarks.swe_bench.native import parse_native_result


def test_native_receipt_preserves_complete_response() -> None:
    row = {"id": "task", "success": True, "actions_taken": ["READ", "EDIT", "SHELL"], "response": "complete " * 20000}
    assert parse_native_result("runtime log\n" + json.dumps(row), "task") == row


@pytest.mark.parametrize("row", [
    {"id": "task", "success": True, "actions_taken": ["REPLY"]},
    {"id": "task", "success": False, "actions_taken": ["EDIT"], "error": "denied"},
    {"id": "other", "success": True, "actions_taken": ["EDIT"]},
])
def test_native_receipt_requires_successful_task_and_mutation_tool(row) -> None:
    with pytest.raises((ValueError, RuntimeError)):
        parse_native_result(json.dumps(row), "task")


def test_duplicate_native_receipts_are_ambiguous() -> None:
    row = json.dumps({"id": "task", "success": True, "actions_taken": ["EDIT"]})
    with pytest.raises(ValueError, match="received 2"):
        parse_native_result(row + "\n" + row, "task")
