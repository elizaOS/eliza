#!/usr/bin/env python3
"""Validate an archived ASIMOV-1 full-training runner report."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from eliza_robot.asimov_1.constants import (  # noqa: E402
    ASIMOV1_GENERATED_MANIFEST,
    ASIMOV1_GENERATED_MJCF,
)

REQUIRED_ARTIFACTS = (
    "training_job.json",
    "manifest.template.json",
    "policy_brax.pkl",
    "manifest.json",
    "metrics.json",
    "config.json",
    "inference_check.json",
)

REQUIRED_POST_VALIDATION_COMMANDS = (
    "scripts/verify_brax_text_policy.py",
    "scripts/validate_asimov1_production_checkpoint.py",
)


def _load(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def _load_dict(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}
    return loaded if isinstance(loaded, dict) else {}


def _sha256_file(path: Path) -> str | None:
    try:
        if not path.is_file():
            return None
        h = hashlib.sha256()
        with path.open("rb") as f:
            for chunk in iter(lambda: f.read(1024 * 1024), b""):
                h.update(chunk)
        return h.hexdigest()
    except OSError:
        return None


def _asset_suffix(path: Path) -> tuple[str, ...]:
    parts = path.parts
    if "assets" in parts:
        return parts[parts.index("assets") :]
    return parts[-1:]


def _step_argv(step: Any) -> list[str]:
    if not isinstance(step, dict):
        return []
    argv = step.get("argv")
    if not isinstance(argv, list) or not all(isinstance(item, str) for item in argv):
        return []
    return argv


def _step_parsed_ok(step: Any) -> bool:
    if not isinstance(step, dict):
        return False
    parsed = step.get("parsed")
    return isinstance(parsed, dict) and parsed.get("ok") is True


def _has_command_step(steps: list[Any], command: str) -> bool:
    for step in steps:
        argv = _step_argv(step)
        if (
            isinstance(step, dict)
            and command in argv
            and step.get("passed") is True
            and _step_parsed_ok(step)
        ):
            return True
    return False


def _arg_after(argv: list[str], flag: str) -> str | None:
    try:
        idx = argv.index(flag)
    except ValueError:
        return None
    if idx + 1 >= len(argv):
        return None
    return argv[idx + 1]


def _positive_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    try:
        parsed = int(value)
    except Exception:
        return None
    return parsed if parsed > 0 else None


def _expected_verify_dims(job: dict[str, Any], manifest: dict[str, Any]) -> dict[str, int]:
    text_dim = int(manifest.get("text_dim", manifest.get("pca_dim", job.get("pca_dim", 32))))
    actor_dim = int(job.get("actor_observation_dim", manifest.get("proprio_dim", 45)))
    return {
        "proprio": int(manifest.get("proprio_dim", actor_dim)),
        "action": int(manifest.get("action_dim", job.get("leg_action_dim", 12))),
        "output": int(manifest.get("output_dim", job.get("output_dim", 25))),
        "critic": int(
            manifest.get(
                "critic_obs_dim",
                job.get("critic_observation_dim", actor_dim + text_dim + 9),
            )
        ),
    }


def _verify_step_contract(
    steps: list[Any],
    *,
    job: dict[str, Any],
    manifest: dict[str, Any],
) -> bool:
    for step in steps:
        argv = _step_argv(step)
        if "scripts/verify_brax_text_policy.py" not in argv:
            continue
        required_flags = {
            "--profile",
            "--require-proprio-dim",
            "--require-action-dim",
            "--require-output-dim",
            "--require-critic-obs-dim",
            "--require-policy-obs-key",
            "--require-value-obs-key",
        }
        expected = _expected_verify_dims(job, manifest)
        return (
            step.get("passed") is True
            and _step_parsed_ok(step)
            and required_flags.issubset(set(argv))
            and _arg_after(argv, "--profile") == "asimov-1"
            and _arg_after(argv, "--require-proprio-dim") == str(expected["proprio"])
            and _arg_after(argv, "--require-action-dim") == str(expected["action"])
            and _arg_after(argv, "--require-output-dim") == str(expected["output"])
            and _arg_after(argv, "--require-critic-obs-dim") == str(expected["critic"])
            and _arg_after(argv, "--require-policy-obs-key") == "state"
            and _arg_after(argv, "--require-value-obs-key") == "privileged_state"
        )
    return False


def _expected_production_min_steps(job: dict[str, Any]) -> int | None:
    ppo = job.get("ppo") if isinstance(job.get("ppo"), dict) else {}
    return _positive_int(ppo.get("num_timesteps", job.get("total_steps", 0)))


def _production_step_contract(
    steps: list[Any],
    *,
    expected_min_steps: int | None,
) -> bool:
    for step in steps:
        argv = _step_argv(step)
        if "scripts/validate_asimov1_production_checkpoint.py" not in argv:
            continue
        parsed = step.get("parsed") if isinstance(step, dict) else {}
        checks = parsed.get("checks") if isinstance(parsed, dict) else {}
        argv_min_steps = _positive_int(_arg_after(argv, "--min-steps"))
        parsed_min_steps = _positive_int(parsed.get("min_steps")) if isinstance(parsed, dict) else None
        min_steps_match = (
            argv_min_steps == expected_min_steps and parsed_min_steps == expected_min_steps
            if expected_min_steps is not None
            else argv_min_steps is not None
            and (parsed_min_steps is None or parsed_min_steps == argv_min_steps)
        )
        return (
            step.get("passed") is True
            and _step_parsed_ok(step)
            and min_steps_match
            and "--require-inference-check" in argv
            and isinstance(checks, dict)
            and checks.get("inference_check") is True
        )
    return False


def _input_asset_provenance_checks(
    *,
    job: dict[str, Any],
    manifest: dict[str, Any],
    config: dict[str, Any],
    input_asset_sha: dict[str, Any],
) -> dict[str, bool]:
    checks: dict[str, bool] = {}
    for label, path_key, hash_key, expected_path in (
        ("mjcf_xml", "mjcf_xml", "mjcf_xml_sha256", ASIMOV1_GENERATED_MJCF),
        (
            "asset_manifest",
            "asset_manifest",
            "asset_manifest_sha256",
            ASIMOV1_GENERATED_MANIFEST,
        ),
    ):
        path = Path(str(job.get(path_key, "")))
        actual_hash = _sha256_file(path)
        if actual_hash is None and _asset_suffix(path) == _asset_suffix(expected_path):
            actual_hash = _sha256_file(expected_path)
            current_asset = actual_hash is not None
        else:
            try:
                current_asset = path.is_file() and path.resolve() == expected_path.resolve()
            except OSError:
                current_asset = False
        checks[label] = (
            bool(job.get(path_key))
            and current_asset
            and actual_hash is not None
            and job.get(hash_key) == actual_hash
            and manifest.get(path_key) == str(path)
            and manifest.get(hash_key) == actual_hash
            and config.get(path_key) == str(path)
            and config.get(hash_key) == actual_hash
            and input_asset_sha.get(label) == actual_hash
        )
    return checks


def validate_asimov1_full_training_run(
    report_path: Path,
    *,
    job_dir: Path | None = None,
) -> dict[str, Any]:
    report_path = report_path.resolve()
    report = _load(report_path)
    resolved_job_dir = (
        job_dir.resolve() if job_dir is not None else Path(str(report.get("job_dir", ""))).resolve()
    )
    artifact_sha = report.get("artifact_sha256")
    artifact_sha = artifact_sha if isinstance(artifact_sha, dict) else {}
    artifact_checks = {
        name: artifact_sha.get(name) == _sha256_file(resolved_job_dir / name)
        for name in REQUIRED_ARTIFACTS
    }
    job = _load_dict(resolved_job_dir / "training_job.json")
    manifest = _load_dict(resolved_job_dir / "manifest.json")
    config = _load_dict(resolved_job_dir / "config.json")
    input_asset_sha = report.get("input_asset_sha256")
    input_asset_sha = input_asset_sha if isinstance(input_asset_sha, dict) else {}
    input_asset_checks = _input_asset_provenance_checks(
        job=job,
        manifest=manifest,
        config=config,
        input_asset_sha=input_asset_sha,
    )
    post = report.get("post_training_validation")
    post = post if isinstance(post, dict) else {}
    steps = post.get("steps") if isinstance(post.get("steps"), list) else []
    expected_min_steps = _expected_production_min_steps(job)
    checks = {
        "schema": report.get("schema") == "asimov-1-full-training-run-v1",
        "profile_id": report.get("profile_id") == "asimov-1",
        "job_dir_matches": Path(str(report.get("job_dir", ""))).resolve() == resolved_job_dir,
        "top_level_ok": report.get("ok") is True,
        "training_ok": (report.get("training") or {}).get("ok") is True,
        "post_training_validation_ok": post.get("ok") is True,
        "post_training_steps": bool(steps) and all(
            isinstance(step, dict) and step.get("passed") is True for step in steps
        ),
        "post_training_required_commands": all(
            _has_command_step(steps, command) for command in REQUIRED_POST_VALIDATION_COMMANDS
        ),
        "post_training_verify_contract": _verify_step_contract(
            steps,
            job=job,
            manifest=manifest,
        ),
        "post_training_production_contract": _production_step_contract(
            steps,
            expected_min_steps=expected_min_steps,
        ),
        "artifact_hashes": all(artifact_checks.values()),
        "input_asset_hashes": all(input_asset_checks.values()),
        "checkpoint_input_asset_provenance": all(input_asset_checks.values()),
    }
    return {
        "ok": all(checks.values()),
        "profile_id": "asimov-1",
        "report": str(report_path),
        "job_dir": str(resolved_job_dir),
        "checks": checks,
        "artifact_checks": artifact_checks,
        "input_asset_checks": input_asset_checks,
        "expected_production_min_steps": expected_min_steps,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("report", type=Path)
    parser.add_argument("--job-dir", type=Path, default=None)
    args = parser.parse_args()
    validation = validate_asimov1_full_training_run(args.report, job_dir=args.job_dir)
    print(json.dumps(validation, indent=2))
    return 0 if validation["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
