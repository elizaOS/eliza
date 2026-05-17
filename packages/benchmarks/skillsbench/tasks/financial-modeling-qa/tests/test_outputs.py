"""
Use this file to define pytest tests that verify the outputs of the task.

This file will be copied to /tests/test_outputs.py and run by the /tests/test.sh file
from the working directory.
"""


import os
import re
import hashlib

ANSWER_PATH = "/root/answer.txt"

# Inputs (anti-cheating checks)
DATA_PATH = "/root/data.xlsx"
PDF_PATH = "/root/background.pdf"

EXPECTED_ANSWER = 23

# If the expected answer is float, allow a small tolerance
TOL = 1e-6


def sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


class TestOutputs:
    def test_inputs_exist(self):
        """Check required input files exist."""
        assert os.path.exists(DATA_PATH), f"Missing input file: {DATA_PATH}"
        assert os.path.exists(PDF_PATH), f"Missing input file: {PDF_PATH}"

    def test_answer_file_exists(self):
        """Check /root/answer.txt was created."""
        assert os.path.exists(ANSWER_PATH), "Missing output file: /root/answer.txt"

    def test_answer_format_is_number(self):
        """
        Check answer.txt contains only a single numeric value (no extra text).
        Allowed formats: integer or decimal, optional leading minus sign.
        """
        with open(ANSWER_PATH, "r", encoding="utf-8") as f:
            content = f.read().strip()

        assert len(content) > 0, "answer.txt is empty"

        # only number allowed
        pattern = r"^-?\d+(\.\d+)?$"
        assert re.match(pattern, content), (
            f"answer.txt must contain only a number. Got: {content!r}"
        )

    def test_answer_value_correct(self):
        """Check answer numeric value matches expected value."""
        with open(ANSWER_PATH, "r", encoding="utf-8") as f:
            content = f.read().strip()

        actual = float(content)
        expected = float(EXPECTED_ANSWER)

        assert abs(actual - expected) <= TOL, (
            f"Incorrect answer. Expected {expected}, got {actual}"
        )