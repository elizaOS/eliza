#!/usr/bin/env python3
"""Run the ASIMOV-1 integration evidence chain."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _run(name: str, argv: list[str], *, cwd: Path = ROOT) -> dict:
    proc = subprocess.run(argv, cwd=cwd, text=True, capture_output=True, check=False)
    parsed = None
    try:
        parsed = json.loads(proc.stdout)
    except Exception:
        parsed = None
    return {
        "name": name,
        "argv": argv,
        "returncode": proc.returncode,
        "stdout": proc.stdout,
        "stderr": proc.stderr,
        "passed": proc.returncode == 0,
        "parsed": parsed,
    }


def run_asimov1_e2e(out_dir: Path, *, steps: int, seed: int, require_real: bool = False) -> dict:
    out_dir.mkdir(parents=True, exist_ok=True)
    ckpt = out_dir / "checkpoint"
    full_job = out_dir / "full_training_job"
    gate = out_dir / "sim_validation_gate"
    py = sys.executable
    steps_run = [
        _run("source_inventory", [py, "scripts/check_asimov1_source_inventory.py"]),
        _run(
            "released_model_audit",
            [py, "scripts/audit_asimov1_released_models.py", "--check-github-releases", "--require-none"],
        ),
        _run("cad_mujoco_training_pipeline", [py, "scripts/validate_asimov1_pipeline.py"]),
        _run("cad_edit_loop", [py, "scripts/validate_asimov1_cad_edit_loop.py"]),
        _run(
            "smoke_checkpoint",
            [py, "-m", "eliza_robot.rl.text_conditioned.train", "--profile", "asimov-1", "--smoke", "--steps", str(steps), "--out", str(ckpt), "--seed", str(seed)],
        ),
        _run("full_training_job", [py, "scripts/validate_asimov1_full_training_job.py", "--job-dir", str(full_job), "--create"]),
        _run("full_training_readiness", [py, "scripts/run_asimov1_full_training.py", "--job-dir", str(full_job), "--check-only", "--require-ready"]),
        _run("asimov_sim_gate", [py, "scripts/sim_validation_gate.py", "--profile", "asimov-1", "--checkpoint", str(ckpt), "--out", str(gate)]),
        _run("asimov_real_prereqs", [py, "scripts/check_asimov1_real_prereqs.py"] + (["--require-credentials", "--require-modules"] if require_real else [])),
        _run("bridge_targets", [py, "-m", "eliza_robot.bridge.launch", "--list-targets"]),
    ]
    launch_stdout = steps_run[-1]["stdout"]
    launch_checks = {
        "asimov_target": "asimov" in launch_stdout and "asimov_mock" in launch_stdout,
        "asimov_mujoco_target": "asimov-mujoco" in launch_stdout and "asimov_mujoco" in launch_stdout,
        "asimov_real_target": "asimov-real" in launch_stdout and "asimov_remote" in launch_stdout,
        "profile": True,
    }
    parsed = {step["name"]: step["parsed"] for step in steps_run if step["parsed"] is not None}
    ok = all(step["passed"] for step in steps_run) and all(launch_checks.values())
    report = {
        "ok": ok,
        "profile_id": "asimov-1",
        "require_real": require_real,
        "out_dir": str(out_dir),
        "checkpoint_dir": str(ckpt),
        "gate_dir": str(gate),
        "launch_checks": launch_checks,
        "parsed": parsed,
        "steps": steps_run,
    }
    (out_dir / "asimov1_e2e_report.json").write_text(json.dumps(report, indent=2) + "\n")
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--steps", type=int, default=2)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--require-real", action="store_true")
    parser.add_argument("--asimov-livekit-url", default="")
    parser.add_argument("--asimov-livekit-token", default="")
    args = parser.parse_args()
    report = run_asimov1_e2e(args.out, steps=args.steps, seed=args.seed, require_real=args.require_real)
    print(json.dumps(report, indent=2))
    return 0 if report["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
