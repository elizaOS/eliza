"""Exercises pipeline rejection and dispatch with CPU-only stage stand-ins."""

import json
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


@pytest.mark.parametrize("failure", ["base", "finetuned", "quantize", "known", "publish"])
def test_requested_stage_failure_stops_pipeline(tmp_path: Path, failure: str) -> None:
    source = Path(__file__).resolve().parent
    scripts = tmp_path / "scripts"
    recipes = scripts / "quantization"
    recipes.mkdir(parents=True)
    shutil.copyfile(source / "run_pipeline.py", scripts / "run_pipeline.py")
    (recipes / "known_apply.py").write_text("# GPU stage dispatched through uv\n")
    calls = tmp_path / "calls"
    launcher = tmp_path / "uv"
    launcher.write_text(
        f"#!{sys.executable}\n"
        "import json, sys\nfrom pathlib import Path\n"
        "args = sys.argv[1:]\n"
        "if '-m' in args:\n"
        "    stage = 'publish'\n"
        "elif '--calibration' in args:\n"
        "    stage = 'quantize'\n"
        "else:\n"
        "    out = Path(args[args.index('--out-dir') + 1])\n"
        "    stage = out.parent.name\n"
        f"with Path({str(calls)!r}).open('a') as f: f.write(stage + '\\n')\n"
        f"if stage == {failure!r}: raise SystemExit(23)\n"
        "if stage == 'quantize':\n"
        "    Path(args[args.index('--output') + 1]).mkdir(parents=True)\n"
        "elif stage != 'publish':\n"
        "    out.mkdir(parents=True)\n"
        "    (out / 'summary.json').write_text(json.dumps(\n"
        "        {'buckets': {'tools': {'n': 10, 'structure_ok': 10}}}))\n"
    )
    launcher.chmod(0o755)
    command = [
        sys.executable, str(scripts / "run_pipeline.py"),
        "--registry-key", "gemma4-e2b", "--run-name", "failure-proof",
        "--quantizers", "known", "--skip-finetune", "--skip-throughput-bench",
    ]
    if failure == "publish":
        command += ["--publish", "--bundle-dir", str(tmp_path / "bundle")]
    result = subprocess.run(
        command, cwd=tmp_path,
        env={**os.environ, "PATH": str(tmp_path),
             "PYTHONPATH": os.pathsep.join([str(source), str(source.parent)])},
        capture_output=True, text=True, timeout=20,
    )
    assert result.returncode == 1, result.stderr
    order = ["base", "finetuned", "quantize", "known", "publish"]
    assert calls.read_text().splitlines() == order[:order.index(failure) + 1]
    summary = json.loads((tmp_path / "benchmarks/failure-proof/pipeline-summary.json").read_text())
    stage = {"base": "base_bench", "finetuned": "finetuned_bench",
             "quantize": "quantize_known", "known": "known_bench", "publish": "publish"}[failure]
    exit_status = summary["stages"][stage]["exit"]
    assert exit_status == (23 if failure in ("quantize", "publish") else {"native_tool_call": 23})
