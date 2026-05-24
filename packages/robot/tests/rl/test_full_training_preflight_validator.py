from __future__ import annotations

import os
from pathlib import Path

from scripts import prepare_end_to_end_full_training as prepare
from scripts.validate_end_to_end_full_training_preflight import validate_bundle


def _bundle(tmp_path: Path) -> Path:
    prepare.prepare(
        out_dir=tmp_path,
        profile_id="asimov-1",
        tasks=("stand_up", "walk_forward"),
        alberta_steps=100,
        alberta_episode_steps=11,
        alberta_eval_episodes=2,
        backend_compare_steps=20,
        brax_steps=100,
        brax_num_envs=16,
        brax_num_evals=1,
        benchmark_steps_per_task=8,
        benchmark_seeds=1,
        run_multi_readiness=False,
    )
    return tmp_path


def test_validate_full_training_preflight_bundle(tmp_path: Path) -> None:
    report = validate_bundle(_bundle(tmp_path))

    assert report["ok"] is True
    assert report["checks"]["scripts_executable"] is True
    assert report["checks"]["default_profiles"] is True
    assert report["checks"]["local_preflight_script"] is True
    assert report["checks"]["local_preflight_profiles"] is True
    assert report["checks"]["run_all_stages_script"] is True
    assert report["checks"]["launch_template_exists"] is True
    assert report["checks"]["launch_template_hygiene"] is True
    assert report["launch_hygiene"]["checks"]["uses_training_s3_uri"] is True
    assert report["checks"]["brax_job_valid"] is True


def test_validate_full_training_preflight_rejects_non_executable_script(
    tmp_path: Path,
) -> None:
    bundle = _bundle(tmp_path)
    script = bundle / "scripts" / "10_nebius_train_alberta.sh"
    script.chmod(0o644)

    report = validate_bundle(bundle)

    assert report["ok"] is False
    assert report["checks"]["scripts_executable"] is False
    assert os.access(script, os.X_OK) is False


def test_validate_full_training_preflight_rejects_missing_default_profile(
    tmp_path: Path,
) -> None:
    bundle = _bundle(tmp_path)
    script = bundle / "scripts" / "00_local_preflight.sh"
    text = script.read_text()
    script.write_text(text.replace(" unitree-r1", ""))

    report = validate_bundle(bundle)

    assert report["ok"] is False
    assert report["checks"]["default_profiles"] is True
    assert report["checks"]["local_preflight_profiles"] is False


def test_validate_full_training_preflight_rejects_unsafe_launch_template(
    tmp_path: Path,
) -> None:
    bundle = _bundle(tmp_path)
    launch_template = bundle / "nebius_instance_launch_template.json"
    text = launch_template.read_text()
    launch_template.write_text(
        text.replace(
            "evidence/full_training_preflight/scripts/run_all_nebius_stages.sh",
            "run_stage 10_nebius_train_alberta scripts/10_nebius_train_alberta.sh",
        ).replace(
            "NEBIUS_TRAINING_S3_URI",
            "OLD_RUN_PREFIX",
        )
    )

    report = validate_bundle(bundle)

    assert report["ok"] is False
    assert report["checks"]["launch_template_hygiene"] is False
    assert report["launch_hygiene"]["checks"]["uses_repo_owned_stage_runner"] is False
    assert report["launch_hygiene"]["checks"]["uses_training_s3_uri"] is False
