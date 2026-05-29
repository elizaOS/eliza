from __future__ import annotations

import os
from pathlib import Path

from scripts import prepare_end_to_end_full_training as prepare
from scripts.validate_end_to_end_full_training_preflight import validate_bundle

CURRICULUM_EVAL_TASKS = (
    "stand_up",
    "walk_forward",
    "walk_backward",
    "sidestep_left",
    "sidestep_right",
    "turn_left",
    "turn_right",
)


def _bundle(tmp_path: Path) -> Path:
    prepare.prepare(
        out_dir=tmp_path,
        profile_id="asimov-1",
        tasks=CURRICULUM_EVAL_TASKS,
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
    assert report["checks"]["post_training_eval_contract"] is True
    assert report["checks"]["launch_template_exists"] is True
    assert report["checks"]["launch_template_hygiene"] is True
    assert report["launch_hygiene"]["checks"]["uses_training_s3_uri"] is True
    assert report["checks"]["brax_job_valid"] is True


def test_post_training_script_clears_stale_curriculum_eval_and_writes_provenance(
    tmp_path: Path,
) -> None:
    bundle = _bundle(tmp_path)
    script = bundle / "scripts" / "50_post_train_validation.sh"
    text = script.read_text(encoding="utf-8")

    assert "rm -rf evidence/curriculum_eval\n" in text
    assert "mkdir -p evidence/curriculum_eval\n" in text
    assert "'schema': 'robot-curriculum-eval-provenance-v1'" in text
    assert "'checkpoint_manifest_sha256': sha256(checkpoint / 'manifest.json')" in text
    assert "'checkpoint_policy_sha256': sha256(checkpoint / 'alberta_policy.npz')" in text
    assert text.index("rm -rf evidence/curriculum_eval") < text.index(
        "scripts/eval_text_policy.py"
    )


def test_training_script_uses_periodic_phase_eval_for_action_scale_ramp(
    tmp_path: Path,
) -> None:
    bundle = _bundle(tmp_path)
    script = bundle / "scripts" / "10_nebius_train_alberta.sh"
    text = script.read_text(encoding="utf-8")

    assert (
        'ALBERTA_PHASE_EVAL_INTERVAL_STEPS="${ALBERTA_PHASE_EVAL_INTERVAL_STEPS:-50000}"'
        in text
    )
    assert '--phase-eval-interval-steps "$ALBERTA_PHASE_EVAL_INTERVAL_STEPS"' in text


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


def test_validate_full_training_preflight_rejects_missing_eval_native_output(
    tmp_path: Path,
) -> None:
    bundle = _bundle(tmp_path)
    script = bundle / "scripts" / "50_post_train_validation.sh"
    script.write_text(
        script.read_text().replace(
            " --out evidence/curriculum_eval/eval_text_policy.json",
            "",
        ),
        encoding="utf-8",
    )

    report = validate_bundle(bundle)

    assert report["ok"] is False
    assert report["checks"]["post_training_eval_contract"] is False


def test_validate_full_training_preflight_rejects_eval_skip_bypass(
    tmp_path: Path,
) -> None:
    bundle = _bundle(tmp_path)
    script = bundle / "scripts" / "50_post_train_validation.sh"
    script.write_text(
        script.read_text()
        + "\nPOST_TRAIN_SKIP_EVAL=\"${POST_TRAIN_SKIP_EVAL:-0}\"\n",
        encoding="utf-8",
    )

    report = validate_bundle(bundle)

    assert report["ok"] is False
    assert report["checks"]["post_training_eval_contract"] is False


def test_validate_full_training_preflight_rejects_stale_alberta_training_script(
    tmp_path: Path,
) -> None:
    bundle = _bundle(tmp_path)
    script = bundle / "scripts" / "10_nebius_train_alberta.sh"
    text = script.read_text()
    text = text.replace(" --require-phase-success", "")
    text = text.replace(" --min-phase-success-rate 1.0", "")
    text = text.replace(
        ' --phase-eval-interval-steps "$ALBERTA_PHASE_EVAL_INTERVAL_STEPS"',
        "",
    )
    script.write_text(text, encoding="utf-8")

    report = validate_bundle(bundle)

    assert report["ok"] is False
    assert report["checks"]["alberta_training_script"] is False


def test_validate_full_training_preflight_rejects_missing_phase_promotion_validation(
    tmp_path: Path,
) -> None:
    bundle = _bundle(tmp_path)
    script = bundle / "scripts" / "50_post_train_validation.sh"
    script.write_text(
        script.read_text().replace(" --require-phase-promotion", ""),
        encoding="utf-8",
    )

    report = validate_bundle(bundle)

    assert report["ok"] is False
    assert report["checks"]["post_training_script"] is False
