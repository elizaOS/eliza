from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
from pathlib import Path

import pytest

from eliza_robot.asimov_1.constants import ASIMOV1_GENERATED_MANIFEST, ASIMOV1_GENERATED_MJCF
from eliza_robot.sim.mujoco.asimov_training import asimov_full_training_job_spec
from scripts import run_asimov1_full_training as full_training_runner
from scripts.validate_asimov1_full_training_job import validate_full_training_job
from scripts.validate_asimov1_full_training_run import validate_asimov1_full_training_run

CURRICULUM_EVAL_TASKS = (
    "stand_up",
    "walk_forward",
    "walk_backward",
    "sidestep_left",
    "sidestep_right",
    "turn_left",
    "turn_right",
)


def _eval_command(
    job_dir: Path,
    *,
    backend: bool = True,
    curriculum: bool = True,
    native_out: bool = True,
    tasks: tuple[str, ...] = CURRICULUM_EVAL_TASKS,
) -> str:
    parts = [
        "python3 scripts/eval_text_policy.py --profile asimov-1",
    ]
    if backend:
        parts.append("--backend mjx")
    parts.extend(
        [
            f"--ckpt {job_dir}",
            f"--tasks {' '.join(tasks)} --episodes 1 --max-steps 1",
        ]
    )
    if native_out:
        parts.append("--out evidence/curriculum_eval/eval_text_policy.json")
    if curriculum:
        parts.append(
            "--curriculum-report-out evidence/curriculum_eval/report.json "
            "--fail-under-success-rate 1.0"
        )
    return " ".join(parts)


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _write_training_run_artifacts(job_dir: Path, training_job: dict) -> None:
    manifest = {
        "profile_id": "asimov-1",
        "regime": "brax_ppo",
        "mjcf_xml": training_job.get("mjcf_xml"),
        "mjcf_xml_sha256": training_job.get("mjcf_xml_sha256"),
        "asset_manifest": training_job.get("asset_manifest"),
        "asset_manifest_sha256": training_job.get("asset_manifest_sha256"),
    }
    config = {
        "profile_id": "asimov-1",
        "mjcf_xml": training_job.get("mjcf_xml"),
        "mjcf_xml_sha256": training_job.get("mjcf_xml_sha256"),
        "asset_manifest": training_job.get("asset_manifest"),
        "asset_manifest_sha256": training_job.get("asset_manifest_sha256"),
    }
    (job_dir / "manifest.template.json").write_text("manifest.template.json\n", encoding="utf-8")
    (job_dir / "policy_brax.pkl").write_text("policy_brax.pkl\n", encoding="utf-8")
    (job_dir / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    (job_dir / "metrics.json").write_text("metrics.json\n", encoding="utf-8")
    (job_dir / "config.json").write_text(json.dumps(config), encoding="utf-8")
    (job_dir / "inference_check.json").write_text("inference_check.json\n", encoding="utf-8")


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
    job["mjcf_xml_sha256"] = _sha256(ASIMOV1_GENERATED_MJCF)
    job["asset_manifest"] = str(ASIMOV1_GENERATED_MANIFEST)
    job["asset_manifest_sha256"] = _sha256(ASIMOV1_GENERATED_MANIFEST)
    job["validation_commands"] = [
        f"python3 scripts/run_asimov1_full_training.py --job-dir {job_dir} --check-only",
        f"python3 scripts/verify_brax_text_policy.py --ckpt {job_dir} --profile asimov-1 --require-proprio-dim 45 --require-action-dim 12 --require-output-dim 25 --require-critic-obs-dim 86 --require-policy-obs-key state --require-value-obs-key privileged_state",
        f"python3 scripts/validate_asimov1_production_checkpoint.py {job_dir} --min-steps 8 --require-inference-check",
        f"python3 scripts/validate_asimov1_full_training_run.py {job_dir}/full_training_run.json --job-dir {job_dir}",
        eval_command,
        f"python3 scripts/sim_validation_gate.py --profile asimov-1 --checkpoint {job_dir} --require-asimov-model-provenance",
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
        "    python3 scripts/verify_brax_text_policy.py --ckpt \"$JOB_DIR\" --profile asimov-1 --require-proprio-dim 45 --require-action-dim 12 --require-output-dim 25 --require-critic-obs-dim 86 --require-policy-obs-key state --require-value-obs-key privileged_state\n"
        "    python3 scripts/validate_asimov1_production_checkpoint.py \"$JOB_DIR\" --min-steps 8 --require-inference-check\n"
        "    python3 scripts/eval_text_policy.py --profile asimov-1 --backend mjx --ckpt \"$JOB_DIR\" --tasks stand_up walk_forward walk_backward sidestep_left sidestep_right turn_left turn_right --episodes 1 --max-steps 1 --out evidence/curriculum_eval/eval_text_policy.json --curriculum-report-out evidence/curriculum_eval/report.json --fail-under-success-rate 1.0\n"
        "    python3 scripts/sim_validation_gate.py --profile asimov-1 --checkpoint \"$JOB_DIR\" --require-asimov-model-provenance\n"
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
        eval_command=_eval_command(stale, backend=False, curriculum=True),
    )
    stale_report = validate_full_training_job(stale)
    assert stale_report["checks"]["validation_commands"] is False
    assert stale_report["ok"] is False

    current = tmp_path / "current"
    _write_minimal_job(
        current,
        eval_command=_eval_command(current),
    )
    current_report = validate_full_training_job(current)
    assert current_report["checks"]["validation_commands"] is True
    assert current_report["checks"]["observation_delay_steps"] is True
    assert current_report["checks"]["manifest_observation_delay_steps"] is True
    assert current_report["checks"]["ppo_asymmetric_actor_critic"] is True
    assert current_report["checks"]["manifest_asymmetric_actor_critic"] is True
    assert current_report["checks"]["run_script_train_mode"] is True
    assert current_report["checks"]["mjcf_asset_hash"] is True
    assert current_report["checks"]["asset_manifest_hash"] is True
    assert current_report["ok"] is True


def test_full_training_validator_requires_eval_native_and_curriculum_outputs(
    tmp_path: Path,
) -> None:
    _write_minimal_job(
        tmp_path,
        eval_command=_eval_command(tmp_path, native_out=False),
    )
    script = tmp_path / "run_full_training.sh"
    script.write_text(
        script.read_text(encoding="utf-8").replace(
            " --out evidence/curriculum_eval/eval_text_policy.json",
            "",
        ),
        encoding="utf-8",
    )

    report = validate_full_training_job(tmp_path)

    assert report["ok"] is False
    assert report["checks"]["validation_commands"] is False
    assert report["checks"]["run_script_train_mode"] is False


def test_full_training_job_export_writes_trainable_runner(tmp_path: Path) -> None:
    report = validate_full_training_job(tmp_path, create=True)
    script = (tmp_path / "run_full_training.sh").read_text(encoding="utf-8")

    assert report["ok"] is True
    assert report["checks"]["observation_delay_steps"] is True
    assert report["checks"]["manifest_observation_delay_steps"] is True
    assert report["checks"]["ppo_asymmetric_actor_critic"] is True
    assert report["checks"]["manifest_asymmetric_actor_critic"] is True
    assert report["checks"]["run_script_train_mode"] is True
    assert report["checks"]["mjcf_current_asset"] is True
    assert report["checks"]["mjcf_asset_hash"] is True
    assert report["checks"]["asset_manifest_current"] is True
    assert report["checks"]["asset_manifest_hash"] is True
    assert "ELIZA_ROBOT_PACKAGE_ROOT" in script
    assert "--train" in script
    assert "--out \"$JOB_DIR/full_training_run.json\"" in script
    assert "validate_asimov1_full_training_run.py" in script
    assert "verify_brax_text_policy.py" in script
    assert "--require-policy-obs-key state" in script
    assert "--require-value-obs-key privileged_state" in script
    assert "--require-critic-obs-dim 86" in script
    assert "validate_asimov1_production_checkpoint.py" in script
    assert "--require-inference-check" in script
    assert "--min-steps 150000000" in script
    assert "eval_text_policy.py --profile asimov-1 --backend mjx" in script
    assert "--tasks stand_up walk_forward walk_backward sidestep_left sidestep_right turn_left turn_right" in script
    assert "--out evidence/curriculum_eval/eval_text_policy.json" in script
    assert "--curriculum-report-out evidence/curriculum_eval/report.json" in script
    assert "--fail-under-success-rate 1.0" in script
    assert "sim_validation_gate.py --profile asimov-1" in script
    assert "--require-asimov-model-provenance" in script
    assert "inference_check.json" in report["expected_artifacts"]
    assert "full_training_run.json" in report["expected_artifacts"]
    assert any("validate_asimov1_full_training_run.py" in c for c in report["validation_commands"])


def test_full_training_validator_rejects_stale_model_asset_hash(tmp_path: Path) -> None:
    _write_minimal_job(
        tmp_path,
        eval_command=_eval_command(tmp_path),
    )
    job_path = tmp_path / "training_job.json"
    job = json.loads(job_path.read_text(encoding="utf-8"))
    job["mjcf_xml_sha256"] = "0" * 64
    job_path.write_text(json.dumps(job), encoding="utf-8")

    report = validate_full_training_job(tmp_path)

    assert report["ok"] is False
    assert report["checks"]["mjcf_asset_hash"] is False


def test_full_training_validator_rejects_stale_verifier_dimension(
    tmp_path: Path,
) -> None:
    _write_minimal_job(
        tmp_path,
        eval_command=_eval_command(tmp_path),
    )
    job_path = tmp_path / "training_job.json"
    job = json.loads(job_path.read_text(encoding="utf-8"))
    job["validation_commands"][1] = job["validation_commands"][1].replace(
        "--require-critic-obs-dim 86",
        "--require-critic-obs-dim 999",
    )
    job_path.write_text(json.dumps(job), encoding="utf-8")
    script_path = tmp_path / "run_full_training.sh"
    script_path.write_text(
        script_path.read_text(encoding="utf-8").replace(
            "--require-critic-obs-dim 86",
            "--require-critic-obs-dim 999",
        ),
        encoding="utf-8",
    )

    report = validate_full_training_job(tmp_path)

    assert report["ok"] is False
    assert report["checks"]["validation_commands"] is False
    assert report["checks"]["run_script_train_mode"] is False


def test_full_training_runner_post_validation_requires_verifier_evidence(
    tmp_path: Path,
) -> None:
    job = asimov_full_training_job_spec(
        curriculum_version=1,
        output_dir=str(tmp_path),
        total_steps=1234,
        num_envs=2,
        num_evals=1,
        pca_dim=6,
        domain_rand=False,
    )
    (tmp_path / "training_job.json").write_text(json.dumps(job), encoding="utf-8")
    calls: list[list[str]] = []

    def fake_run(argv, **_kwargs):
        calls.append(list(argv))
        return subprocess.CompletedProcess(argv, 0, stdout='{"ok": true}', stderr="")

    report = full_training_runner.run_post_training_validation(tmp_path, run_fn=fake_run)

    assert report["ok"] is True
    verify = calls[0]
    production = calls[1]
    assert "scripts/verify_brax_text_policy.py" in verify
    assert "--require-critic-obs-dim" in verify
    assert verify[verify.index("--require-critic-obs-dim") + 1] == "60"
    assert "--require-policy-obs-key" in verify
    assert verify[verify.index("--require-policy-obs-key") + 1] == "state"
    assert "--require-value-obs-key" in verify
    assert verify[verify.index("--require-value-obs-key") + 1] == "privileged_state"
    assert "scripts/validate_asimov1_production_checkpoint.py" in production
    assert "--min-steps" in production
    assert production[production.index("--min-steps") + 1] == "1234"
    assert "--require-inference-check" in production


def test_full_training_runner_report_binds_output_artifacts(tmp_path: Path) -> None:
    training_job = {
        "mjcf_xml": str(ASIMOV1_GENERATED_MJCF),
        "mjcf_xml_sha256": _sha256(ASIMOV1_GENERATED_MJCF),
        "asset_manifest": str(ASIMOV1_GENERATED_MANIFEST),
        "asset_manifest_sha256": _sha256(ASIMOV1_GENERATED_MANIFEST),
    }
    (tmp_path / "training_job.json").write_text(json.dumps(training_job), encoding="utf-8")
    _write_training_run_artifacts(tmp_path, training_job)
    report = full_training_runner.build_training_run_report(
        tmp_path,
        training={"ok": True},
        post_training_validation={
            "ok": True,
            "steps": [
                {
                    "passed": True,
                    "argv": [
                        "python3",
                        "scripts/verify_brax_text_policy.py",
                        "--profile",
                        "asimov-1",
                        "--require-proprio-dim",
                        "45",
                        "--require-action-dim",
                        "12",
                        "--require-output-dim",
                        "25",
                        "--require-critic-obs-dim",
                        "86",
                        "--require-policy-obs-key",
                        "state",
                        "--require-value-obs-key",
                        "privileged_state",
                    ],
                    "parsed": {"ok": True},
                },
                {
                    "passed": True,
                    "argv": [
                        "python3",
                        "scripts/validate_asimov1_production_checkpoint.py",
                        str(tmp_path),
                        "--min-steps",
                        "8",
                        "--require-inference-check",
                    ],
                    "parsed": {"ok": True, "checks": {"inference_check": True}},
                },
            ],
        },
    )
    report_path = tmp_path / "full-training-run.json"
    report_path.write_text(json.dumps(report), encoding="utf-8")

    validation = validate_asimov1_full_training_run(report_path, job_dir=tmp_path)

    assert validation["ok"] is True
    assert all(validation["artifact_checks"].values())
    assert all(validation["input_asset_checks"].values())
    assert validation["checks"]["input_asset_hashes"] is True
    assert validation["checks"]["checkpoint_input_asset_provenance"] is True
    assert validation["checks"]["post_training_required_commands"] is True
    assert validation["checks"]["post_training_production_contract"] is True


def test_full_training_run_validator_rejects_stale_artifact_hash(tmp_path: Path) -> None:
    training_job = {
        "mjcf_xml": str(ASIMOV1_GENERATED_MJCF),
        "mjcf_xml_sha256": _sha256(ASIMOV1_GENERATED_MJCF),
        "asset_manifest": str(ASIMOV1_GENERATED_MANIFEST),
        "asset_manifest_sha256": _sha256(ASIMOV1_GENERATED_MANIFEST),
    }
    (tmp_path / "training_job.json").write_text(json.dumps(training_job), encoding="utf-8")
    _write_training_run_artifacts(tmp_path, training_job)
    report = full_training_runner.build_training_run_report(
        tmp_path,
        training={"ok": True},
        post_training_validation={
            "ok": True,
            "steps": [
                {
                    "passed": True,
                    "argv": [
                        "python3",
                        "scripts/verify_brax_text_policy.py",
                        "--profile",
                        "asimov-1",
                        "--require-proprio-dim",
                        "45",
                        "--require-action-dim",
                        "12",
                        "--require-output-dim",
                        "25",
                        "--require-critic-obs-dim",
                        "86",
                        "--require-policy-obs-key",
                        "state",
                        "--require-value-obs-key",
                        "privileged_state",
                    ],
                    "parsed": {"ok": True},
                },
                {
                    "passed": True,
                    "argv": [
                        "python3",
                        "scripts/validate_asimov1_production_checkpoint.py",
                        str(tmp_path),
                        "--min-steps",
                        "8",
                        "--require-inference-check",
                    ],
                    "parsed": {"ok": True, "checks": {"inference_check": True}},
                },
            ],
        },
    )
    report_path = tmp_path / "full-training-run.json"
    report_path.write_text(json.dumps(report), encoding="utf-8")
    (tmp_path / "manifest.json").write_text("stale\n", encoding="utf-8")

    validation = validate_asimov1_full_training_run(report_path, job_dir=tmp_path)

    assert validation["ok"] is False
    assert validation["artifact_checks"]["manifest.json"] is False


def test_full_training_run_validator_rejects_stale_input_asset_hash(tmp_path: Path) -> None:
    training_job = {
        "mjcf_xml": str(ASIMOV1_GENERATED_MJCF),
        "mjcf_xml_sha256": "0" * 64,
        "asset_manifest": str(ASIMOV1_GENERATED_MANIFEST),
        "asset_manifest_sha256": _sha256(ASIMOV1_GENERATED_MANIFEST),
    }
    (tmp_path / "training_job.json").write_text(json.dumps(training_job), encoding="utf-8")
    _write_training_run_artifacts(tmp_path, training_job)
    report = full_training_runner.build_training_run_report(
        tmp_path,
        training={"ok": True},
        post_training_validation={
            "ok": True,
            "steps": [
                {
                    "passed": True,
                    "argv": [
                        "python3",
                        "scripts/verify_brax_text_policy.py",
                        "--profile",
                        "asimov-1",
                        "--require-proprio-dim",
                        "45",
                        "--require-action-dim",
                        "12",
                        "--require-output-dim",
                        "25",
                        "--require-critic-obs-dim",
                        "86",
                        "--require-policy-obs-key",
                        "state",
                        "--require-value-obs-key",
                        "privileged_state",
                    ],
                    "parsed": {"ok": True},
                },
                {
                    "passed": True,
                    "argv": [
                        "python3",
                        "scripts/validate_asimov1_production_checkpoint.py",
                        str(tmp_path),
                        "--min-steps",
                        "8",
                        "--require-inference-check",
                    ],
                    "parsed": {"ok": True, "checks": {"inference_check": True}},
                },
            ],
        },
    )
    report_path = tmp_path / "full-training-run.json"
    report_path.write_text(json.dumps(report), encoding="utf-8")

    validation = validate_asimov1_full_training_run(report_path, job_dir=tmp_path)

    assert validation["ok"] is False
    assert validation["checks"]["input_asset_hashes"] is False
    assert validation["checks"]["checkpoint_input_asset_provenance"] is False
    assert validation["input_asset_checks"]["mjcf_xml"] is False


def test_full_training_run_validator_rejects_missing_production_validation_contract(
    tmp_path: Path,
) -> None:
    training_job = {
        "mjcf_xml": str(ASIMOV1_GENERATED_MJCF),
        "mjcf_xml_sha256": _sha256(ASIMOV1_GENERATED_MJCF),
        "asset_manifest": str(ASIMOV1_GENERATED_MANIFEST),
        "asset_manifest_sha256": _sha256(ASIMOV1_GENERATED_MANIFEST),
    }
    (tmp_path / "training_job.json").write_text(json.dumps(training_job), encoding="utf-8")
    _write_training_run_artifacts(tmp_path, training_job)
    report = full_training_runner.build_training_run_report(
        tmp_path,
        training={"ok": True},
        post_training_validation={
            "ok": True,
            "steps": [
                {
                    "passed": True,
                    "argv": [
                        "python3",
                        "scripts/verify_brax_text_policy.py",
                        "--profile",
                        "asimov-1",
                        "--require-proprio-dim",
                        "45",
                        "--require-action-dim",
                        "12",
                        "--require-output-dim",
                        "25",
                        "--require-critic-obs-dim",
                        "86",
                        "--require-policy-obs-key",
                        "state",
                        "--require-value-obs-key",
                        "privileged_state",
                    ],
                    "parsed": {"ok": True},
                },
                {
                    "passed": True,
                    "argv": [
                        "python3",
                        "scripts/validate_asimov1_production_checkpoint.py",
                        str(tmp_path),
                        "--min-steps",
                        "8",
                    ],
                    "parsed": {"ok": True, "checks": {}},
                },
            ],
        },
    )
    report_path = tmp_path / "full-training-run.json"
    report_path.write_text(json.dumps(report), encoding="utf-8")

    validation = validate_asimov1_full_training_run(report_path, job_dir=tmp_path)

    assert validation["ok"] is False
    assert validation["checks"]["post_training_production_contract"] is False


def test_full_training_run_validator_rejects_stale_verifier_dimension(
    tmp_path: Path,
) -> None:
    training_job = {
        "mjcf_xml": str(ASIMOV1_GENERATED_MJCF),
        "mjcf_xml_sha256": _sha256(ASIMOV1_GENERATED_MJCF),
        "asset_manifest": str(ASIMOV1_GENERATED_MANIFEST),
        "asset_manifest_sha256": _sha256(ASIMOV1_GENERATED_MANIFEST),
        "actor_observation_dim": 45,
        "critic_observation_dim": 86,
        "leg_action_dim": 12,
        "output_dim": 25,
    }
    (tmp_path / "training_job.json").write_text(json.dumps(training_job), encoding="utf-8")
    _write_training_run_artifacts(tmp_path, training_job)
    report = full_training_runner.build_training_run_report(
        tmp_path,
        training={"ok": True},
        post_training_validation={
            "ok": True,
            "steps": [
                {
                    "passed": True,
                    "argv": [
                        "python3",
                        "scripts/verify_brax_text_policy.py",
                        "--profile",
                        "asimov-1",
                        "--require-proprio-dim",
                        "45",
                        "--require-action-dim",
                        "12",
                        "--require-output-dim",
                        "25",
                        "--require-critic-obs-dim",
                        "999",
                        "--require-policy-obs-key",
                        "state",
                        "--require-value-obs-key",
                        "privileged_state",
                    ],
                    "parsed": {"ok": True},
                },
                {
                    "passed": True,
                    "argv": [
                        "python3",
                        "scripts/validate_asimov1_production_checkpoint.py",
                        str(tmp_path),
                        "--min-steps",
                        "8",
                        "--require-inference-check",
                    ],
                    "parsed": {"ok": True, "checks": {"inference_check": True}},
                },
            ],
        },
    )
    report_path = tmp_path / "full-training-run.json"
    report_path.write_text(json.dumps(report), encoding="utf-8")

    validation = validate_asimov1_full_training_run(report_path, job_dir=tmp_path)

    assert validation["ok"] is False
    assert validation["checks"]["post_training_verify_contract"] is False


def test_full_training_run_validator_rejects_manifest_config_input_mismatch(
    tmp_path: Path,
) -> None:
    training_job = {
        "mjcf_xml": str(ASIMOV1_GENERATED_MJCF),
        "mjcf_xml_sha256": _sha256(ASIMOV1_GENERATED_MJCF),
        "asset_manifest": str(ASIMOV1_GENERATED_MANIFEST),
        "asset_manifest_sha256": _sha256(ASIMOV1_GENERATED_MANIFEST),
    }
    (tmp_path / "training_job.json").write_text(json.dumps(training_job), encoding="utf-8")
    _write_training_run_artifacts(tmp_path, training_job)
    manifest = json.loads((tmp_path / "manifest.json").read_text(encoding="utf-8"))
    manifest["mjcf_xml_sha256"] = "0" * 64
    (tmp_path / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    report = full_training_runner.build_training_run_report(
        tmp_path,
        training={"ok": True},
        post_training_validation={
            "ok": True,
            "steps": [
                {
                    "passed": True,
                    "argv": [
                        "python3",
                        "scripts/verify_brax_text_policy.py",
                        "--profile",
                        "asimov-1",
                        "--require-proprio-dim",
                        "45",
                        "--require-action-dim",
                        "12",
                        "--require-output-dim",
                        "25",
                        "--require-critic-obs-dim",
                        "86",
                        "--require-policy-obs-key",
                        "state",
                        "--require-value-obs-key",
                        "privileged_state",
                    ],
                    "parsed": {"ok": True},
                },
                {
                    "passed": True,
                    "argv": [
                        "python3",
                        "scripts/validate_asimov1_production_checkpoint.py",
                        str(tmp_path),
                        "--min-steps",
                        "8",
                        "--require-inference-check",
                    ],
                    "parsed": {"ok": True, "checks": {"inference_check": True}},
                },
            ],
        },
    )
    report_path = tmp_path / "full-training-run.json"
    report_path.write_text(json.dumps(report), encoding="utf-8")

    validation = validate_asimov1_full_training_run(report_path, job_dir=tmp_path)

    assert validation["ok"] is False
    assert validation["checks"]["checkpoint_input_asset_provenance"] is False
    assert validation["input_asset_checks"]["mjcf_xml"] is False
