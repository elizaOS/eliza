"""Regression tests for the vendored MINT code grader (``upstream/mint/utils/exec.py``).

The grader runs untrusted, model-generated solutions in a child process. Upstream
human-eval used a *local closure* as the process target, which only works under the
``fork`` start method (the child inherits the parent address space). Under the
default ``spawn`` start method (macOS / Windows, and the Python 3.14 default) the
target is pickled, a local closure raises ``Can't pickle local object``, the child
never runs, the result list stays empty, and every code task is silently scored as a
failure regardless of model output.

The fix hoists the target to a module-level ``_unsafe_execute`` so it is picklable
under both ``spawn`` and ``fork``. These tests pin the three real verdicts and force
the ``spawn`` start method explicitly so the guard is meaningful on fork-default
Linux CI, not just on the macOS spawn default.
"""

import multiprocessing

import pytest

from benchmarks.mint.upstream.mint.utils.exec import check_correctness

# A trivial unit-under-test plus a harness in the upstream check format: the test
# code is concatenated after the solution and the two run together in the sandbox.
SOLUTION_OK = "def add(a, b):\n    return a + b\n"
SOLUTION_WRONG = "def add(a, b):\n    return a - b\n"
SOLUTION_LOOP = "def add(a, b):\n    while True:\n        pass\n"
TEST_CODE = "def check(candidate):\n    assert candidate(1, 2) == 3\n\ncheck(add)\n"

# Always exercise ``spawn`` (the start method that broke the closure target); also
# exercise ``fork`` where the platform provides it.
START_METHODS = [m for m in ("spawn", "fork") if m in multiprocessing.get_all_start_methods()]


def _force_start_method(monkeypatch, method):
    """Point the grader's ``multiprocessing.Process``/``Manager`` at ``method``'s
    context, without a global ``set_start_method`` (which may only run once)."""
    ctx = multiprocessing.get_context(method)
    monkeypatch.setattr(multiprocessing, "Process", ctx.Process)
    monkeypatch.setattr(multiprocessing, "Manager", ctx.Manager)


@pytest.mark.parametrize("method", START_METHODS)
def test_correct_solution_passes(monkeypatch, method):
    _force_start_method(monkeypatch, method)
    result = check_correctness(SOLUTION_OK, TEST_CODE, timeout=5)
    assert result["success"] is True
    assert result["result"] == "passed"


@pytest.mark.parametrize("method", START_METHODS)
def test_wrong_solution_fails(monkeypatch, method):
    _force_start_method(monkeypatch, method)
    result = check_correctness(SOLUTION_WRONG, TEST_CODE, timeout=5)
    assert result["success"] is False
    assert result["result"].startswith("failed")


@pytest.mark.parametrize("method", START_METHODS)
def test_infinite_loop_times_out(monkeypatch, method):
    _force_start_method(monkeypatch, method)
    result = check_correctness(SOLUTION_LOOP, TEST_CODE, timeout=2)
    assert result["success"] is False
    assert result["result"] == "timed out"
