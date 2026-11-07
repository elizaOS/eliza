from __future__ import annotations

import sys
from pathlib import Path

from benchmarks.orchestrator.code_agent_execution import MatrixCell, run_cell
from pytest import MonkeyPatch


def test_timeout_preserves_partial_utf8_streams_and_redacts_secrets(
    tmp_path: Path,
) -> None:
    cell = MatrixCell(
        benchmark="synthetic-evidence",
        adapter="child-process",
        command=[
            "/bin/sh",
            "-c",
            (
                "printf 'stdout café %s\\n' \"$PRIVATE_CHILD_SECRET\"; "
                "printf '  stderr naïve %s\\n' \"$PRIVATE_CHILD_SECRET\" >&2; "
                "exec sleep 60"
            ),
        ],
        cwd=str(tmp_path),
        output_dir=str(tmp_path / "cell" / "output"),
        trajectory_dir=str(tmp_path / "cell" / "trajectories"),
        env_overrides={"PRIVATE_CHILD_SECRET": "private-fixture-value"},
    )

    result = run_cell(cell, dry_run=False, timeout_seconds=2, resume=False)
    stdout = Path(result.stdout_path).read_text(encoding="utf-8")
    stderr = Path(result.stderr_path).read_text(encoding="utf-8")

    assert result.status == "failed"
    assert result.exit_code == 124
    assert result.failure_class == "timeout"
    assert stdout == "stdout café [REDACTED]\n"
    assert stderr.startswith("  stderr naïve [REDACTED]\n")
    assert "Command timed out after 2s" in stderr
    assert "private-fixture-value" not in stdout + stderr


def test_complete_redacted_logs_classify_failure_before_long_tail(
    tmp_path: Path,
    monkeypatch: MonkeyPatch,
) -> None:
    monkeypatch.setenv("CODE_AGENT_MATRIX_LOG_LIMIT_BYTES", "1024")
    cell = MatrixCell(
        benchmark="synthetic-evidence",
        adapter="child-process",
        command=[
            sys.executable,
            "-u",
            "-c",
            (
                "import os, sys\n"
                "secret = os.environ['PRIVATE_CHILD_SECRET']\n"
                "sys.stdout.write('unauthorized early failure ' + secret + '\\n' + 'tail' * 4096 + '\\n')\n"
                "sys.stderr.write('early stderr ' + secret + '\\n' + 'error-tail' * 4096 + '\\n')\n"
                "sys.exit(1)\n"
            ),
        ],
        cwd=str(tmp_path),
        output_dir=str(tmp_path / "cell" / "output"),
        trajectory_dir=str(tmp_path / "cell" / "trajectories"),
        env_overrides={"PRIVATE_CHILD_SECRET": "private-fixture-value"},
    )

    result = run_cell(cell, dry_run=False, timeout_seconds=10, resume=False)
    stdout = Path(result.stdout_path).read_text(encoding="utf-8")
    stderr = Path(result.stderr_path).read_text(encoding="utf-8")

    assert result.status == "failed"
    assert result.exit_code == 1
    assert result.failure_class == "auth_or_provider"
    assert stdout == "unauthorized early failure [REDACTED]\n" + "tail" * 4096 + "\n"
    assert stderr == "early stderr [REDACTED]\n" + "error-tail" * 4096 + "\n"
    assert "private-fixture-value" not in stdout + stderr
