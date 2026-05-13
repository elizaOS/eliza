"""
Tests for pdf-excel-diff task.

Verifies that the agent correctly identifies:
1. Deleted employees (present in PDF but not in current Excel)
2. Modified employee records (different values between PDF and Excel)
"""

import json
from pathlib import Path

import pytest

OUTPUT_FILE = Path("/root/diff_report.json")
EXPECTED_FILE = Path("/tests/expected_output.json")


class TestFileExists:
    """Test that the output file exists and is valid JSON."""

    def test_output_file_exists(self):
        """Verify the output file was created."""
        assert OUTPUT_FILE.exists(), f"Output file not found at {OUTPUT_FILE}"

    def test_output_file_valid_json(self):
        """Verify the output file contains valid JSON."""
        assert OUTPUT_FILE.exists(), "Output file does not exist"
        with open(OUTPUT_FILE) as f:
            try:
                json.load(f)
            except json.JSONDecodeError as e:
                pytest.fail(f"Output file is not valid JSON: {e}")

    def test_output_has_required_keys(self):
        """Verify the output has the required structure."""
        assert OUTPUT_FILE.exists(), "Output file does not exist"
        with open(OUTPUT_FILE) as f:
            data = json.load(f)

        assert "deleted_employees" in data, "Missing 'deleted_employees' key"
        assert "modified_employees" in data, "Missing 'modified_employees' key"
        assert isinstance(data["deleted_employees"], list), "'deleted_employees' should be a list"
        assert isinstance(data["modified_employees"], list), "'modified_employees' should be a list"


class TestDeletedEmployees:
    """Test detection of deleted employees."""

    def test_correct_deleted_count(self):
        """Verify the correct number of deleted employees was found."""
        with open(OUTPUT_FILE) as f:
            output = json.load(f)
        with open(EXPECTED_FILE) as f:
            expected = json.load(f)

        assert len(output["deleted_employees"]) == len(
            expected["deleted_employees"]
        ), f"Expected {len(expected['deleted_employees'])} deleted employees, found {len(output['deleted_employees'])}"

    def test_correct_deleted_ids(self):
        """Verify the correct employee IDs were identified as deleted."""
        with open(OUTPUT_FILE) as f:
            output = json.load(f)
        with open(EXPECTED_FILE) as f:
            expected = json.load(f)

        output_ids = set(output["deleted_employees"])
        expected_ids = set(expected["deleted_employees"])

        missing = expected_ids - output_ids
        extra = output_ids - expected_ids

        assert missing == set(), f"Failed to detect deleted employees: {missing}"
        assert extra == set(), f"Incorrectly marked as deleted: {extra}"


class TestModifiedEmployees:
    """Test detection of modified employee records."""

    def test_correct_modified_count(self):
        """Verify the correct number of modifications was found."""
        with open(OUTPUT_FILE) as f:
            output = json.load(f)
        with open(EXPECTED_FILE) as f:
            expected = json.load(f)

        assert len(output["modified_employees"]) == len(
            expected["modified_employees"]
        ), f"Expected {len(expected['modified_employees'])} modifications, found {len(output['modified_employees'])}"

    def test_modified_employee_structure(self):
        """Verify each modification entry has required fields."""
        with open(OUTPUT_FILE) as f:
            output = json.load(f)

        for mod in output["modified_employees"]:
            assert "id" in mod, "Modification entry missing 'id' field"
            assert "field" in mod, "Modification entry missing 'field' field"
            assert "old_value" in mod, "Modification entry missing 'old_value' field"
            assert "new_value" in mod, "Modification entry missing 'new_value' field"

    def test_correct_modified_ids(self):
        """Verify the correct employee IDs were identified as modified."""
        with open(OUTPUT_FILE) as f:
            output = json.load(f)
        with open(EXPECTED_FILE) as f:
            expected = json.load(f)

        output_ids = {m["id"] for m in output["modified_employees"]}
        expected_ids = {m["id"] for m in expected["modified_employees"]}

        missing = expected_ids - output_ids
        extra = output_ids - expected_ids

        assert missing == set(), f"Failed to detect modifications for: {missing}"
        assert extra == set(), f"Incorrectly detected modifications for: {extra}"

    def test_correct_modified_fields(self):
        """Verify the correct fields were identified as modified."""
        with open(OUTPUT_FILE) as f:
            output = json.load(f)
        with open(EXPECTED_FILE) as f:
            expected = json.load(f)

        # Create lookup by ID
        expected_by_id = {m["id"]: m for m in expected["modified_employees"]}
        output_by_id = {m["id"]: m for m in output["modified_employees"]}

        for emp_id, exp_mod in expected_by_id.items():
            if emp_id in output_by_id:
                out_mod = output_by_id[emp_id]
                assert out_mod["field"] == exp_mod["field"], f"For {emp_id}: expected field '{exp_mod['field']}', got '{out_mod['field']}'"

    def test_correct_modified_values(self):
        """Verify the old and new values are correct."""
        with open(OUTPUT_FILE) as f:
            output = json.load(f)
        with open(EXPECTED_FILE) as f:
            expected = json.load(f)

        # Create lookup by ID
        expected_by_id = {m["id"]: m for m in expected["modified_employees"]}
        output_by_id = {m["id"]: m for m in output["modified_employees"]}

        for emp_id, exp_mod in expected_by_id.items():
            if emp_id in output_by_id:
                out_mod = output_by_id[emp_id]

                # Compare old values (handle type differences)
                exp_old = exp_mod["old_value"]
                out_old = out_mod["old_value"]
                if isinstance(exp_old, (int, float)) and isinstance(out_old, (int, float)):
                    assert abs(exp_old - out_old) < 0.01, f"For {emp_id}: expected old_value {exp_old}, got {out_old}"
                else:
                    assert str(exp_old) == str(out_old), f"For {emp_id}: expected old_value '{exp_old}', got '{out_old}'"

                # Compare new values
                exp_new = exp_mod["new_value"]
                out_new = out_mod["new_value"]
                if isinstance(exp_new, (int, float)) and isinstance(out_new, (int, float)):
                    assert abs(exp_new - out_new) < 0.01, f"For {emp_id}: expected new_value {exp_new}, got {out_new}"
                else:
                    assert str(exp_new) == str(out_new), f"For {emp_id}: expected new_value '{exp_new}', got '{out_new}'"


class TestIntegration:
    """Integration tests verifying overall correctness."""

    def test_full_comparison(self):
        """Full comparison of output vs expected."""
        with open(OUTPUT_FILE) as f:
            output = json.load(f)
        with open(EXPECTED_FILE) as f:
            expected = json.load(f)

        # Check deleted employees
        assert set(output["deleted_employees"]) == set(expected["deleted_employees"]), "Deleted employees do not match"

        # Check modified employees count
        assert len(output["modified_employees"]) == len(expected["modified_employees"]), "Modified employees count does not match"

        # Check each modification
        expected_mods = {(m["id"], m["field"]): m for m in expected["modified_employees"]}
        output_mods = {(m["id"], m["field"]): m for m in output["modified_employees"]}

        assert set(expected_mods.keys()) == set(output_mods.keys()), "Modified employee/field combinations do not match"
