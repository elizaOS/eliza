#!/usr/bin/env python3
"""Run or inspect an ASIMOV-1 full MJX/Brax training package."""

from __future__ import annotations

import argparse
import hashlib
import importlib
import json
import subprocess
import sys
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.validate_asimov1_full_training_job import validate_full_training_job  # noqa: E402


def _load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {}


def _sha256_file(path: Path | None) -> str | None:
    if path is None or not path.is_file():
        return None
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _artifact_hashes(job_dir: Path) -> dict[str, str | None]:
    return {
        name: _sha256_file(job_dir / name)
        for name in (
            "training_job.json",
            "manifest.template.json",
            "policy_brax.pkl",
            "manifest.json",
            "metrics.json",
            "config.json",
            "inference_check.json",
        )
    }


def _input_asset_hashes(job_dir: Path) -> dict[str, str | None]:
    job = _load_json(job_dir / "training_job.json")
    mjcf = Path(str(job.get("mjcf_xml", "")))
    manifest = Path(str(job.get("asset_manifest", "")))
    return {
        "mjcf_xml": _sha256_file(mjcf),
        "asset_manifest": _sha256_file(manifest),
    }


def _write_report(path: Path | None, report: dict[str, Any]) -> None:
    if path is None:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")


def inspect_training_readiness(job_dir: Path) -> dict:
    validation = validate_full_training_job(job_dir)
    modules = {}
    for name in ("jax", "brax", "mujoco", "mujoco_playground"):
        try:
            importlib.import_module(name)
            modules[name] = True
        except Exception:
            modules[name] = False
    trainer = "eliza_robot.sim.mujoco.asimov_mjx_training:train_from_job"
    try:
        mod, fn = trainer.split(":")
        trainer_importable = hasattr(importlib.import_module(mod), fn)
        trainer_error = None
    except Exception as exc:
        trainer_importable = False
        trainer_error = str(exc)
    missing = [name for name, ok in modules.items() if not ok]
    if not trainer_importable:
        missing.append("asimov_mjx_training_entrypoint")
    return {
        "ready": validation["ok"] and not missing,
        "job_dir": str(job_dir),
        "package_validation": validation,
        "modules": modules,
        "trainer_entrypoint": trainer,
        "trainer_importable": trainer_importable,
        "trainer_error": trainer_error,
        "missing_capabilities": missing,
        "expected_artifacts": [
            "policy_brax.pkl",
            "manifest.json",
            "metrics.json",
            "config.json",
            "inference_check.json",
            "full_training_run.json",
        ],
    }


def _parse_json(text: str) -> Any:
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return None


def run_post_training_validation(
    job_dir: Path,
    *,
    run_fn: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run,
) -> dict[str, Any]:
    job = _load_json(job_dir / "training_job.json")
    manifest_template = dict(job.get("manifest_template") or {})
    ppo = dict(job.get("ppo") or {})
    critic_obs_dim = int(manifest_template.get("critic_obs_dim", 86))
    total_steps = int(ppo.get("num_timesteps", job.get("total_steps", 0)))
    commands = [
        [
            sys.executable,
            "scripts/verify_brax_text_policy.py",
            "--ckpt",
            str(job_dir),
            "--profile",
            "asimov-1",
            "--require-proprio-dim",
            "45",
            "--require-action-dim",
            "12",
            "--require-output-dim",
            "25",
            "--require-critic-obs-dim",
            str(critic_obs_dim),
            "--require-policy-obs-key",
            "state",
            "--require-value-obs-key",
            "privileged_state",
        ],
        [
            sys.executable,
            "scripts/validate_asimov1_production_checkpoint.py",
            str(job_dir),
            "--min-steps",
            str(total_steps),
            "--require-inference-check",
        ],
    ]
    steps = []
    for command in commands:
        proc = run_fn(
            command,
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )
        parsed = _parse_json(proc.stdout)
        if parsed is None and "scripts/verify_brax_text_policy.py" in command:
            parsed = _load_json(job_dir / "inference_check.json")
        steps.append(
            {
                "argv": command,
                "returncode": proc.returncode,
                "stdout": proc.stdout,
                "stderr": proc.stderr,
                "parsed": parsed,
                "passed": proc.returncode == 0,
            }
        )
    return {
        "ok": all(step["passed"] for step in steps),
        "job_dir": str(job_dir),
        "steps": steps,
    }


def build_training_run_report(
    job_dir: Path,
    *,
    training: dict[str, Any],
    post_training_validation: dict[str, Any],
) -> dict[str, Any]:
    return {
        "schema": "asimov-1-full-training-run-v1",
        "profile_id": "asimov-1",
        "created_at_unix": time.time(),
        "job_dir": str(job_dir.resolve()),
        "ok": bool(training.get("ok")) and post_training_validation["ok"],
        "artifact_sha256": _artifact_hashes(job_dir),
        "input_asset_sha256": _input_asset_hashes(job_dir),
        "training": training,
        "post_training_validation": post_training_validation,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--job-dir", type=Path, required=True)
    parser.add_argument("--check-only", action="store_true")
    parser.add_argument("--require-ready", action="store_true")
    parser.add_argument("--out", type=Path, default=None)
    args = parser.parse_args()
    report = inspect_training_readiness(args.job_dir)
    if args.check_only:
        print(json.dumps(report, indent=2))
        return 0 if report["ready"] or not args.require_ready else 2
    if not report["ready"]:
        print(json.dumps(report, indent=2))
        return 2
    from eliza_robot.sim.mujoco.asimov_mjx_training import train_from_job

    train_report = train_from_job(args.job_dir)
    post_training_validation = run_post_training_validation(args.job_dir)
    report = build_training_run_report(
        args.job_dir,
        training=train_report,
        post_training_validation=post_training_validation,
    )
    _write_report(args.out, report)
    print(json.dumps(report, indent=2))
    return 0 if report["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
