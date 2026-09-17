"""Tests the multi-tier CLI with real subprocesses standing in for GPU stages."""

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest


@pytest.mark.parametrize(
    "failure", ["evaluation", "invalid-json", "missing-score", "quantizer", "missing-recipe", None],
)
def test_failed_stage_fails_tier_and_stops_dispatch(tmp_path: Path, failure):
    source = Path(__file__).resolve().parent
    scripts = tmp_path / "scripts"
    recipes = scripts / "quantization"
    recipes.mkdir(parents=True)
    shutil.copyfile(source / "finetune_all_tiers.py", scripts / "finetune_all_tiers.py")
    marker = tmp_path / "calls"
    for stage, relative in [
        ("train", "run_pipeline.py"),
        ("evaluation", "eval_checkpoint.py"),
        ("quantizer", "quantization/turboquant_apply.py"),
    ]:
        if failure == "missing-recipe" and stage == "quantizer":
            continue
        code = (
            "from pathlib import Path\nimport sys\n"
            f"with Path({str(marker)!r}).open('a') as f: f.write({stage!r} + '\\n')\n"
        )
        if failure == stage:
            code += "raise SystemExit(23)\n"
        elif stage == "evaluation":
            payload = "{" if failure == "invalid-json" else json.dumps(
                {} if failure == "missing-score" else {"structure_ok": 0.75},
            )
            code += (
                "out = Path(sys.argv[sys.argv.index('--out') + 1])\n"
                "out.parent.mkdir(parents=True, exist_ok=True)\n"
                f"out.write_text({payload!r})\n"
            )
        (scripts / relative).write_text(code)
    data = tmp_path / "data"
    data.mkdir()
    output = tmp_path / "output"
    command = [
        sys.executable, str(scripts / "finetune_all_tiers.py"),
        "--tiers", "gemma4-e2b", "--data-path", str(data), "--output-dir", str(output),
    ]
    environment = {**os.environ, "PYTHONPATH": str(source)}
    result = subprocess.run(command, env=environment, capture_output=True, text=True, timeout=20)
    assert result.returncode == (0 if failure is None else 1), result.stderr
    summaries = list(output.glob("finetune_all_summary_*.json"))
    assert len(summaries) == 1
    tier = json.loads(summaries[0].read_text())[0]
    assert tier["passed"] is (failure is None)
    assert bool(tier["error"]) is (failure is not None)
    calls = marker.read_text().splitlines()
    assert calls == (["train", "evaluation", "quantizer"] if failure in (None, "quantizer")
                     else ["train", "evaluation"])
    if failure is None:
        assert tier["eval_score"] == 0.75
        shutil.rmtree(output)
        marker.unlink()
        for flags in [["--dry-run"], ["--dry-run", "--nebius"]]:
            planned = subprocess.run(command + flags, env=environment,
                                     capture_output=True, text=True, timeout=20)
            assert planned.returncode == 0, planned.stderr
            assert not output.exists()
            assert not marker.exists()
