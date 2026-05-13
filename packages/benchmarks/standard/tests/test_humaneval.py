"""Smoke + unit tests for the HumanEval adapter."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from benchmarks.standard._base import MockClient
from benchmarks.standard._cli import main_entry
from benchmarks.standard.humaneval import (
    BENCHMARK_ID,
    SMOKE_FIXTURES,
    HumanEvalRunner,
    _build_program,
    _execute_program,
    _reindent_function_body,
    _strip_code_fence,
    _HumanEvalFactory,
)


def test_strip_code_fence_handles_plain() -> None:
    assert _strip_code_fence("    return a + b") == "    return a + b"


def test_strip_code_fence_extracts_python_block() -> None:
    fenced = "```python\n    return a + b\n```"
    assert _strip_code_fence(fenced) == "    return a + b\n"


def test_build_program_appends_test_block() -> None:
    item = SMOKE_FIXTURES[0]
    program = _build_program(
        str(item["prompt"]),
        str(item["canonical_solution"]),
        str(item["test"]),
        str(item["entry_point"]),
    )
    assert "def add" in program
    assert "check(add)" in program


def test_build_program_accepts_full_function_completion() -> None:
    item = SMOKE_FIXTURES[0]
    completion = "```python\ndef add(a: int, b: int) -> int:\n    return a + b\n```"
    program = _build_program(
        str(item["prompt"]),
        completion,
        str(item["test"]),
        str(item["entry_point"]),
    )
    assert program.count("def add") == 1
    ok, err = _execute_program(program, timeout_s=10.0)
    assert ok, err


def test_reindent_function_body_fixes_dropped_first_line_indent() -> None:
    """Regression: gpt-oss-120b via the eliza REPLY action sometimes emits the
    first body line at column 0 while indenting the rest. The standard
    HumanEval task expects every body line to be indented under the prompt's
    function signature; we re-indent before splicing.
    """
    body = (
        "numbers = sorted(numbers)\n"
        "    if len(numbers) < 2:\n"
        "        return False\n"
        "    return True\n"
    )
    fixed = _reindent_function_body(body)
    expected = (
        "    numbers = sorted(numbers)\n"
        "    if len(numbers) < 2:\n"
        "        return False\n"
        "    return True\n"
    )
    assert fixed == expected


def test_reindent_function_body_leaves_well_indented_body_alone() -> None:
    body = "    return a + b\n"
    assert _reindent_function_body(body) == body


def test_reindent_function_body_leaves_fully_unindented_body_alone() -> None:
    """If every line is at column 0 (the model returned only a one-liner body
    that the dedent path will handle elsewhere, or pure dedented prose),
    leave it alone — we only fix the mixed-indent regression."""
    body = "return a + b\n"
    assert _reindent_function_body(body) == body


def test_build_program_recovers_from_dropped_first_line_indent() -> None:
    """End-to-end: ``def f():\\n  return 1`` (canonical, indented) and
    ``return 1`` alone-but-after-a-real-completion-with-mixed-indent should
    both execute cleanly after _build_program post-processes them."""
    prompt = "def f() -> int:\n    \"\"\"Return the count.\"\"\"\n"
    test = "def check(candidate):\n    assert candidate() == 1\n"
    # Canonical: leading 4-space indent already present.
    good = _build_program(prompt, "    return 1\n", test, "f")
    ok_good, err_good = _execute_program(good, timeout_s=10.0)
    assert ok_good, err_good
    # Mixed-indent regression: gpt-oss style — first stmt unindented,
    # subsequent block correctly indented.
    mixed = _build_program(
        prompt,
        "x = 1\n    if x:\n        return 1\n    return 0\n",
        test,
        "f",
    )
    ok_mixed, err_mixed = _execute_program(mixed, timeout_s=10.0)
    assert ok_mixed, err_mixed


def test_execute_program_runs_canonical_solution() -> None:
    item = SMOKE_FIXTURES[0]
    program = _build_program(
        str(item["prompt"]),
        str(item["canonical_solution"]),
        str(item["test"]),
        str(item["entry_point"]),
    )
    ok, err = _execute_program(program, timeout_s=10.0)
    assert ok, err


def test_execute_program_catches_wrong_answer() -> None:
    item = SMOKE_FIXTURES[0]
    program = _build_program(
        str(item["prompt"]),
        "    return a - b\n",  # wrong implementation
        str(item["test"]),
        str(item["entry_point"]),
    )
    ok, _err = _execute_program(program, timeout_s=10.0)
    assert ok is False


def test_execute_program_enforces_timeout() -> None:
    item = SMOKE_FIXTURES[0]
    spinner = "    while True:\n        pass\n"
    program = _build_program(
        str(item["prompt"]),
        spinner,
        str(item["test"]),
        str(item["entry_point"]),
    )
    ok, err = _execute_program(program, timeout_s=1.0)
    assert ok is False
    assert "timeout" in err.lower()


def test_humaneval_runner_perfect_score(tmp_path: Path) -> None:
    responses = [str(item["canonical_solution"]) for item in SMOKE_FIXTURES]
    runner = HumanEvalRunner(examples=list(SMOKE_FIXTURES), timeout_s=10.0)
    result = runner.run(
        client=MockClient(responses),
        model="m",
        endpoint="http://mock",
        output_dir=tmp_path,
        limit=None,
    )
    assert result.benchmark == BENCHMARK_ID
    assert result.metrics["score"] == 1.0
    assert result.metrics["pass@1"] == 1.0
    assert result.metrics["passed"] == float(len(SMOKE_FIXTURES))


def test_humaneval_runner_records_failures(tmp_path: Path) -> None:
    # Wrong implementations.
    responses = ["    return a - b\n", "    return min(xs)\n"]
    runner = HumanEvalRunner(examples=list(SMOKE_FIXTURES), timeout_s=10.0)
    result = runner.run(
        client=MockClient(responses),
        model="m",
        endpoint="http://mock",
        output_dir=tmp_path,
        limit=None,
    )
    assert result.metrics["score"] == 0.0
    assert len(result.failures) >= 1


def test_humaneval_cli_end_to_end(tmp_path: Path) -> None:
    out_dir = tmp_path / "out"
    rc = main_entry(
        _HumanEvalFactory(),
        output_filename="humaneval-results.json",
        argv=[
            "--mock",
            "--provider",
            "openai",
            "--model",
            "mock",
            "--output",
            str(out_dir),
            "--api-key-env",
            "DOES_NOT_EXIST",
            "--timeout-s",
            "10",
        ],
    )
    assert rc == 0
    data = json.loads((out_dir / "humaneval-results.json").read_text("utf-8"))
    assert data["metrics"]["score"] == 1.0
