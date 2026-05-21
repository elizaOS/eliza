#!/usr/bin/env python3
"""Run or inspect an ASIMOV-1 full MJX/Brax training package."""

from __future__ import annotations

import argparse
import importlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.validate_asimov1_full_training_job import validate_full_training_job  # noqa: E402


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
        "expected_artifacts": ["policy_brax.pkl", "manifest.json", "metrics.json", "config.json"],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--job-dir", type=Path, required=True)
    parser.add_argument("--check-only", action="store_true")
    parser.add_argument("--require-ready", action="store_true")
    args = parser.parse_args()
    report = inspect_training_readiness(args.job_dir)
    if args.check_only:
        print(json.dumps(report, indent=2))
        return 0 if report["ready"] or not args.require_ready else 2
    if not report["ready"]:
        print(json.dumps(report, indent=2))
        return 2
    from eliza_robot.sim.mujoco.asimov_mjx_training import train_from_job

    print(json.dumps(train_from_job(args.job_dir), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
