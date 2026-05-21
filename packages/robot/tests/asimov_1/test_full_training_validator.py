from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

from eliza_robot.asimov_1.constants import ASIMOV1_GENERATED_MJCF
from eliza_robot.sim.mujoco.asimov_training import asimov_full_training_job_spec
from scripts.validate_asimov1_full_training_job import validate_full_training_job


def _write_minimal_job(job_dir: Path, *, eval_command: str) -> None:
    job = asimov_full_training_job_spec(
        curriculum_version=1,
        output_dir=str(job_dir),
        total_steps=8,
        num_envs=2,
        num_evals=1,
        domain_rand=True,
    )
    job["mjcf_xml"] = str(ASIMOV1_GENERATED_MJCF)
    job["validation_commands"] = [
        f"python3 scripts/run_asimov1_full_training.py --job-dir {job_dir} --check-only",
        f"python3 scripts/verify_brax_text_policy.py --ckpt {job_dir} --profile asimov-1 --require-proprio-dim 45 --require-action-dim 12 --require-output-dim 25",
        f"python3 scripts/validate_asimov1_production_checkpoint.py {job_dir} --min-steps 8",
        eval_command,
        f"python3 scripts/sim_validation_gate.py --profile asimov-1 --checkpoint {job_dir}",
    ]
    job_dir.mkdir(parents=True, exist_ok=True)
    (job_dir / "training_job.json").write_text(json.dumps(job), encoding="utf-8")
    (job_dir / "manifest.template.json").write_text(
        json.dumps(job["manifest_template"]),
        encoding="utf-8",
    )
    (job_dir / "run_full_training.sh").write_text(
        "#!/usr/bin/env bash\n"
        "case \"${1:---check}\" in\n"
        "  --check) python3 scripts/run_asimov1_full_training.py --job-dir \"$JOB_DIR\" --check-only --require-ready ;;\n"
        "  --train)\n"
        "    python3 scripts/run_asimov1_full_training.py --job-dir \"$JOB_DIR\"\n"
        "    python3 scripts/verify_brax_text_policy.py --ckpt \"$JOB_DIR\" --profile asimov-1 --require-proprio-dim 45 --require-action-dim 12 --require-output-dim 25\n"
        "    python3 scripts/validate_asimov1_production_checkpoint.py \"$JOB_DIR\" --min-steps 8\n"
        "    python3 scripts/eval_text_policy.py --profile asimov-1 --backend mjx --ckpt \"$JOB_DIR\" --tasks stand_up --episodes 1 --max-steps 1\n"
        "    python3 scripts/sim_validation_gate.py --profile asimov-1 --checkpoint \"$JOB_DIR\"\n"
        "    ;;\n"
        "esac\n",
        encoding="utf-8",
    )
    (job_dir / "run_full_training.sh").chmod(0o755)
    (job_dir / "README.full_training.md").write_text("ASIMOV training\n", encoding="utf-8")


@pytest.mark.skipif(not shutil.which("python3"), reason="python3 unavailable")
def test_full_training_validator_requires_asimov_mjx_eval_backend(tmp_path: Path) -> None:
    stale = tmp_path / "stale"
    _write_minimal_job(
        stale,
        eval_command=(
            f"python3 scripts/eval_text_policy.py --profile asimov-1 --ckpt {stale} "
            "--tasks stand_up --episodes 1 --max-steps 1"
        ),
    )
    stale_report = validate_full_training_job(stale)
    assert stale_report["checks"]["validation_commands"] is False
    assert stale_report["ok"] is False

    current = tmp_path / "current"
    _write_minimal_job(
        current,
        eval_command=(
            f"python3 scripts/eval_text_policy.py --profile asimov-1 --backend mjx --ckpt {current} "
            "--tasks stand_up --episodes 1 --max-steps 1"
        ),
    )
    current_report = validate_full_training_job(current)
    assert current_report["checks"]["validation_commands"] is True
    assert current_report["checks"]["run_script_train_mode"] is True
    assert current_report["ok"] is True


def test_full_training_job_export_writes_trainable_runner(tmp_path: Path) -> None:
    report = validate_full_training_job(tmp_path, create=True)
    script = (tmp_path / "run_full_training.sh").read_text(encoding="utf-8")

    assert report["ok"] is True
    assert report["checks"]["run_script_train_mode"] is True
    assert "ELIZA_ROBOT_PACKAGE_ROOT" in script
    assert "--train" in script
    assert "verify_brax_text_policy.py" in script
    assert "validate_asimov1_production_checkpoint.py" in script
    assert "--min-steps 150000000" in script
    assert "eval_text_policy.py --profile asimov-1 --backend mjx" in script
    assert "sim_validation_gate.py --profile asimov-1" in script
