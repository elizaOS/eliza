"""Exercises pipeline argument rejection in a real CPU-only subprocess."""

import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest


@pytest.mark.parametrize("selection", ["missing", "known,missing", "../train_local"])
def test_rejects_missing_recipe_before_creating_run_or_dispatching(
    tmp_path: Path, selection: str,
) -> None:
    source = Path(__file__).resolve().parent
    scripts = tmp_path / "scripts"
    recipes = scripts / "quantization"
    recipes.mkdir(parents=True)
    shutil.copyfile(source / "run_pipeline.py", scripts / "run_pipeline.py")
    (recipes / "known_apply.py").write_text("raise AssertionError('must not run')\n")
    result = subprocess.run(
        [
            sys.executable, str(scripts / "run_pipeline.py"),
            "--registry-key", "gemma4-e2b", "--quantizers", selection,
        ],
        cwd=tmp_path,
        env={
            **os.environ,
            "PATH": "",
            "PYTHONPATH": os.pathsep.join([str(source), str(source.parent)]),
        },
        capture_output=True, text=True, timeout=20,
    )
    assert result.returncode == 2
    assert "Unknown or unavailable quantizers:" in result.stderr
    assert not (tmp_path / "benchmarks").exists()
    assert not (tmp_path / "checkpoints").exists()
    assert not (tmp_path / "data").exists()
