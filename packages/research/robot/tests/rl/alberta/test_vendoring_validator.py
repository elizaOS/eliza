from __future__ import annotations

import subprocess
import sys
from pathlib import Path

from scripts.validate_alberta_vendoring import validate_alberta_vendoring

EXPECTED_HEAD = "2ac35333efae45cf969ce02ec1f2703476fed6c2"


def test_alberta_vendoring_validator_accepts_current_tree() -> None:
    report = validate_alberta_vendoring(expected_upstream_head=EXPECTED_HEAD)

    assert report["ok"] is True
    assert report["vendored_commit"] == EXPECTED_HEAD
    assert report["checks"]["robot_pyproject_source"] is True
    assert report["checks"]["uv_lock_source"] is True
    assert report["checks"]["import_resolves_to_vendored_tree"] is True


def test_alberta_vendoring_validator_cli() -> None:
    proc = subprocess.run(
        [
            sys.executable,
            "packages/robot/scripts/validate_alberta_vendoring.py",
            "--expected-upstream-head",
            EXPECTED_HEAD,
        ],
        cwd=Path(__file__).resolve().parents[5],
        capture_output=True,
        text=True,
        check=False,
    )

    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert EXPECTED_HEAD in proc.stdout
