"""Validate an end-to-end full-training launch bundle.

This checks the generated bundle from ``prepare_end_to_end_full_training.py``
without launching long training. It is intended to run locally and again on the
Nebius host before executing the numbered training scripts.
"""

from __future__ import annotations

import argparse
import importlib
import json
import os
import sys
from pathlib import Path
from typing import Any

PKG_ROOT = Path(__file__).resolve().parents[1]
if str(PKG_ROOT) not in sys.path:
    sys.path.insert(0, str(PKG_ROOT))

validate_full_training_job = importlib.import_module(
    "scripts.validate_asimov1_full_training_job"
).validate_full_training_job
validate_instance_launch_hygiene = importlib.import_module(
    "scripts.validate_nebius_instance_launch_hygiene"
).validate_instance_launch_hygiene
DEFAULT_PROFILES = tuple(
    importlib.import_module("scripts.prepare_end_to_end_full_training").DEFAULT_PROFILES
)

REQUIRED_SCRIPTS = (
    "local_preflight",
    "train_alberta",
    "compare_backends",
    "continual_benchmarks",
    "brax_baseline",
    "post_training_validation",
    "run_all_stages",
)
REQUIRED_LAUNCH_ORDER = (
    "scripts/00_local_preflight.sh",
    "scripts/10_nebius_train_alberta.sh",
    "scripts/20_nebius_compare_backends.sh",
    "scripts/30_nebius_continual_benchmarks.sh",
    "scripts/40_nebius_brax_baseline.sh",
    "scripts/50_post_train_validation.sh",
)
CURRICULUM_EVAL_TASKS = (
    "stand_up",
    "walk_forward",
    "walk_backward",
    "sidestep_left",
    "sidestep_right",
    "turn_left",
    "turn_right",
)
MIN_PRODUCTION_BUDGETS = {
    "alberta_steps": 150_000_000,
    "alberta_episode_steps": 200,
    "alberta_eval_episodes": 3,
    "backend_compare_steps": 30_000,
    "brax_steps": 150_000_000,
    "brax_num_envs": 8192,
    "brax_num_evals": 10,
    "benchmark_steps_per_task": 16_000,
    "benchmark_seeds": 3,
}


def _load(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}
    return loaded if isinstance(loaded, dict) else {}


def _resolve_from_bundle(bundle_dir: Path, value: str) -> Path:
    path = Path(value)
    if path.is_absolute():
        return path
    candidate = (bundle_dir / value).resolve()
    if candidate.exists():
        return candidate
    return (PKG_ROOT.parent.parent / value).resolve()


def _script_contains(path: Path, needles: tuple[str, ...]) -> bool:
    if not path.is_file():
        return False
    text = path.read_text(encoding="utf-8")
    return all(needle in text for needle in needles)


def _post_training_eval_contract_ok(path: Path) -> bool:
    if not path.is_file():
        return False
    text = path.read_text(encoding="utf-8")
    return "POST_TRAIN_SKIP_EVAL" not in text and all(
        needle in text
        for needle in (
            "eval_text_policy.py",
            "--tasks " + " ".join(CURRICULUM_EVAL_TASKS),
            "--out evidence/curriculum_eval/eval_text_policy.json",
            "--curriculum-report-out evidence/curriculum_eval/report.json",
            "--fail-under-success-rate 1.0",
        )
    )


def _local_preflight_profiles_ok(path: Path) -> bool:
    if not path.is_file():
        return False
    text = path.read_text(encoding="utf-8")
    expected = "--profiles " + " ".join(DEFAULT_PROFILES)
    return expected in text


def _int_at_least(payload: dict[str, Any], key: str, minimum: int) -> bool:
    try:
        return int(payload.get(key, 0) or 0) >= minimum
    except (TypeError, ValueError):
        return False


def _production_budgets_ok(report: dict[str, Any]) -> bool:
    budgets = report.get("budgets")
    if not isinstance(budgets, dict):
        return False
    return all(
        _int_at_least(budgets, key, minimum)
        for key, minimum in MIN_PRODUCTION_BUDGETS.items()
    )


def _brax_job_production_budget_ok(job_dir: Path) -> bool:
    job = _load(job_dir / "training_job.json")
    ppo = job.get("ppo") if isinstance(job.get("ppo"), dict) else {}
    return (
        _int_at_least(ppo, "num_timesteps", MIN_PRODUCTION_BUDGETS["brax_steps"])
        and _int_at_least(ppo, "num_envs", MIN_PRODUCTION_BUDGETS["brax_num_envs"])
        and _int_at_least(ppo, "num_evals", MIN_PRODUCTION_BUDGETS["brax_num_evals"])
    )


def validate_bundle(bundle_dir: Path, *, allow_smoke: bool = False) -> dict[str, Any]:
    bundle_dir = bundle_dir.resolve()
    report_path = bundle_dir / "preflight_report.json"
    report = _load(report_path)
    scripts = report.get("scripts") if isinstance(report.get("scripts"), dict) else {}
    script_paths = {
        name: _resolve_from_bundle(bundle_dir, str(scripts.get(name, "")))
        for name in REQUIRED_SCRIPTS
    }
    brax_job_dir = _resolve_from_bundle(bundle_dir, str(report.get("brax_job_dir", "")))
    brax_validation = validate_full_training_job(brax_job_dir) if brax_job_dir.is_dir() else {"ok": False}
    launch_template_path = _resolve_from_bundle(
        bundle_dir,
        str(
            (report.get("launch_template") or {}).get("path", "")
            if isinstance(report.get("launch_template"), dict)
            else ""
        ),
    )
    launch_hygiene = (
        validate_instance_launch_hygiene(launch_template_path)
        if launch_template_path.is_file()
        else {"ok": False, "checks": {}}
    )

    checks = {
        "report_exists": report_path.is_file(),
        "schema": report.get("schema") == "robot-end-to-end-full-training-preflight-v1",
        "report_ok": report.get("ok") is True,
        "production_budgets": allow_smoke or _production_budgets_ok(report),
        "default_profiles": tuple(report.get("default_profiles", [])) == DEFAULT_PROFILES,
        "launch_order": tuple(report.get("launch_order", [])) == REQUIRED_LAUNCH_ORDER,
        "required_scripts_declared": set(REQUIRED_SCRIPTS).issubset(scripts),
        "scripts_exist": all(path.is_file() for path in script_paths.values()),
        "scripts_executable": all(os.access(path, os.X_OK) for path in script_paths.values()),
        "local_preflight_script": _script_contains(
            script_paths["local_preflight"],
            (
                "validate_multi_robot_training_readiness.py",
                "validate_asimov1_full_training_job.py",
                "run_asimov1_full_training.py",
                "--check-only --require-ready",
                "eliza-robot-validate-full-training-preflight",
            ),
        ),
        "local_preflight_profiles": _local_preflight_profiles_ok(
            script_paths["local_preflight"]
        ),
        "alberta_training_script": _script_contains(
            script_paths["train_alberta"],
            (
                "eliza-robot-train",
                "ALBERTA_STREAMING_STEPS",
                "--profile",
                "--steps",
                '--steps "$ALBERTA_STREAMING_STEPS"',
                "--episode-steps",
                "--eval-episodes",
                "--require-phase-success",
                "--min-phase-success-rate 1.0",
                "--phase-eval-interval-steps",
                "ALBERTA_PHASE_EVAL_INTERVAL_STEPS",
            ),
        ),
        "backend_compare_script": _script_contains(
            script_paths["compare_backends"],
            ("eliza-robot-compare-backends", "--eval-episodes", "--out-root"),
        ),
        "continual_benchmark_script": _script_contains(
            script_paths["continual_benchmarks"],
            (
                "--env joint_reach",
                "--env obstacle_course",
                "eliza-robot-validate-alberta-benchmark",
                "--expected-env joint_reach",
                "--expected-env obstacle_course",
            ),
        ),
        "brax_baseline_script": _script_contains(
            script_paths["brax_baseline"],
            ("run_full_training.sh --train",),
        ),
        "post_training_script": _script_contains(
            script_paths["post_training_validation"],
            (
                "eliza-robot-validate-alberta-checkpoint",
                "--require-phase-promotion",
                "eliza-robot-validate-asimov1-production-checkpoint",
                "--require-inference-check",
                "validate_asimov1_real_agent_readiness.py",
                "--require-production",
                "evidence_text_to_action_e2e.py",
                "--profile",
                "record_agent_videos.py",
                "--policy-checkpoint",
            ),
        ),
        "post_training_eval_contract": _post_training_eval_contract_ok(
            script_paths["post_training_validation"]
        ),
        "run_all_stages_script": _script_contains(
            script_paths["run_all_stages"],
            (
                "eliza-robot-run-full-training-bundle",
                "--bundle-dir evidence/full_training_preflight",
                "NEBIUS_S3_ENDPOINT",
                "NEBIUS_TRAINING_S3_URI",
            ),
        ),
        "launch_template_exists": launch_template_path.is_file(),
        "launch_template_hygiene": bool(launch_hygiene.get("ok")),
        "brax_job_dir_exists": brax_job_dir.is_dir(),
        "brax_job_valid": bool(brax_validation.get("ok")),
        "brax_job_production_budget": allow_smoke
        or _brax_job_production_budget_ok(brax_job_dir),
    }
    return {
        "ok": all(checks.values()),
        "bundle_dir": str(bundle_dir),
        "report": str(report_path),
        "checks": checks,
        "scripts": {name: str(path) for name, path in script_paths.items()},
        "launch_template": str(launch_template_path),
        "launch_hygiene": launch_hygiene,
        "brax_job_dir": str(brax_job_dir),
        "brax_validation": {
            "ok": bool(brax_validation.get("ok")),
            "failed_checks": [
                name
                for name, ok in (brax_validation.get("checks") or {}).items()
                if not ok
            ],
        },
        "production_budget_contract": {
            "allow_smoke": bool(allow_smoke),
            "minimums": dict(MIN_PRODUCTION_BUDGETS),
            "budgets": report.get("budgets") if isinstance(report.get("budgets"), dict) else {},
        },
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bundle_dir", type=Path)
    parser.add_argument(
        "--allow-smoke",
        action="store_true",
        help="Allow tiny unit-test/smoke budgets. Do not use for production launch validation.",
    )
    args = parser.parse_args(argv)
    report = validate_bundle(args.bundle_dir, allow_smoke=args.allow_smoke)
    print(json.dumps(report, indent=2))
    return 0 if report["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
