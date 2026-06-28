#!/usr/bin/env python3
"""Run the ASIMOV-1 integration evidence chain."""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]


def _sha256_file(path: Path | None) -> str | None:
    if path is None or not path.is_file():
        return None
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _load_json(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return payload if isinstance(payload, dict) else {}


def _checkpoint_policy_artifact(checkpoint: Path | None) -> Path | None:
    if checkpoint is None:
        return None
    manifest = _load_json(checkpoint / "manifest.json")
    artifact = manifest.get("ckpt", "policy_brax.pkl")
    if not isinstance(artifact, str) or not artifact:
        return None
    return (checkpoint / artifact).resolve()


def _workspace_promotion_plan(workspace: Path | None) -> Path | None:
    return None if workspace is None else (workspace / "asimov_promotion_plan.json").resolve()


def _artifact_sha256(
    *,
    workspace_promotion: Path | None,
    real_hardware_evidence: Path | None,
    production_checkpoint: Path | None,
    full_training_run: Path | None,
    real_agent_run: Path | None,
) -> dict[str, str | None]:
    return {
        "workspace_promotion_plan": _sha256_file(
            _workspace_promotion_plan(workspace_promotion)
        ),
        "real_hardware_evidence": _sha256_file(real_hardware_evidence),
        "production_checkpoint_manifest": _sha256_file(
            None if production_checkpoint is None else production_checkpoint / "manifest.json"
        ),
        "production_checkpoint_training_job": _sha256_file(
            None
            if production_checkpoint is None
            else production_checkpoint / "training_job.json"
        ),
        "production_checkpoint_config": _sha256_file(
            None if production_checkpoint is None else production_checkpoint / "config.json"
        ),
        "production_checkpoint_metrics": _sha256_file(
            None if production_checkpoint is None else production_checkpoint / "metrics.json"
        ),
        "production_checkpoint_inference_check": _sha256_file(
            None
            if production_checkpoint is None
            else production_checkpoint / "inference_check.json"
        ),
        "production_checkpoint_policy": _sha256_file(
            _checkpoint_policy_artifact(production_checkpoint)
        ),
        "full_training_run": _sha256_file(full_training_run),
        "real_agent_run": _sha256_file(real_agent_run),
    }


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


def run_asimov1_e2e(
    out_dir: Path,
    *,
    steps: int,
    seed: int,
    require_real: bool = False,
    workspace_promotion: Path | None = None,
    require_promotion_applied: bool = False,
    real_hardware_evidence: Path | None = None,
    production_checkpoint: Path | None = None,
    production_min_steps: int = 1_000_000,
    full_training_run: Path | None = None,
    real_agent_run: Path | None = None,
) -> dict:
    out_dir = out_dir.resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    workspace_promotion_path = workspace_promotion.resolve() if workspace_promotion is not None else None
    evidence_path = real_hardware_evidence.resolve() if real_hardware_evidence is not None else None
    production_checkpoint_path = production_checkpoint.resolve() if production_checkpoint is not None else None
    full_training_run_path = full_training_run.resolve() if full_training_run is not None else None
    real_agent_run_path = real_agent_run.resolve() if real_agent_run is not None else None
    ckpt = out_dir / "checkpoint"
    full_job = out_dir / "full_training_job"
    tiny_brax_job = out_dir / "tiny_brax_training_job"
    gate = out_dir / "sim_validation_gate"
    py = sys.executable
    readiness_argv = [
        py,
        "scripts/validate_asimov1_real_agent_readiness.py",
        "--max-steps",
        str(max(1, steps)),
    ]
    if production_checkpoint_path is not None:
        readiness_argv.extend(
            [
                "--checkpoint",
                str(production_checkpoint_path),
                "--production-min-steps",
                str(production_min_steps),
                "--require-production",
            ]
        )
    if evidence_path is not None:
        readiness_argv.extend(
            ["--hardware-evidence", str(evidence_path), "--require-hardware"]
        )
    steps_run = [
        _run("source_inventory", [py, "scripts/check_asimov1_source_inventory.py"]),
        _run(
            "released_model_audit",
            [
                py,
                "scripts/audit_asimov1_released_models.py",
                "--check-github-releases",
                "--require-none",
                "--require-complete",
            ],
        ),
        _run("cad_mujoco_training_pipeline", [py, "scripts/validate_asimov1_pipeline.py"]),
        _run("cad_edit_loop", [py, "scripts/validate_asimov1_cad_edit_loop.py"]),
        _run(
            "alberta_checkpoint",
            [
                py,
                "-m",
                "eliza_robot.rl.text_conditioned.train",
                "--profile",
                "asimov-1",
                "--tasks",
                "stand_up",
                "walk_forward",
                "--steps",
                str(steps),
                "--episode-steps",
                "4",
                "--eval-episodes",
                "1",
                "--out",
                str(ckpt),
                "--seed",
                str(seed),
            ],
        ),
        _run("full_training_job", [py, "scripts/validate_asimov1_full_training_job.py", "--job-dir", str(full_job), "--create"]),
        _run("full_training_readiness", [py, "scripts/run_asimov1_full_training.py", "--job-dir", str(full_job), "--check-only", "--require-ready"]),
        _run("full_training_runner_check", [str(full_job / "run_full_training.sh"), "--check"], cwd=out_dir),
        _run("tiny_brax_training_job", [py, "scripts/validate_asimov1_tiny_brax_training.py", "--job-dir", str(tiny_brax_job), "--create"]),
        _run("asimov_sim_gate", [py, "scripts/sim_validation_gate.py", "--profile", "asimov-1", "--checkpoint", str(ckpt), "--out", str(gate)]),
        _run("asimov_controller_contract", [py, "scripts/validate_asimov1_controller_contract.py"]),
        _run("asimov_server_command_surface", [py, "scripts/validate_asimov1_server_command_surface.py"]),
        _run("asimov_real_bridge_dry_run", [py, "scripts/validate_asimov1_real_bridge_dry_run.py"]),
        _run("asimov_real_agent_readiness", readiness_argv),
        _run("asimov_real_prereqs", [py, "scripts/check_asimov1_real_prereqs.py"] + (["--require-credentials", "--require-modules"] if require_real else [])),
        _run("bridge_targets", [py, "-m", "eliza_robot.bridge.launch", "--list-targets"]),
    ]
    if workspace_promotion_path is not None:
        argv = [
            py,
            "scripts/validate_asimov1_workspace_promotion.py",
            "--workspace",
            str(workspace_promotion_path),
        ]
        if require_promotion_applied:
            argv.append("--require-applied")
        steps_run.append(_run("asimov_workspace_promotion", argv))
    if evidence_path is not None:
        steps_run.append(
            _run(
                "asimov_real_hardware_evidence",
                [py, "scripts/validate_asimov1_real_hardware_evidence.py", str(evidence_path)],
            )
        )
    if production_checkpoint_path is not None:
        steps_run.append(
            _run(
                "asimov_production_checkpoint",
                [
                    py,
                    "scripts/validate_asimov1_production_checkpoint.py",
                    str(production_checkpoint_path),
                    "--min-steps",
                    str(production_min_steps),
                    "--require-inference-check",
                ],
            )
        )
    if full_training_run_path is not None:
        argv = [
            py,
            "scripts/validate_asimov1_full_training_run.py",
            str(full_training_run_path),
        ]
        if production_checkpoint_path is not None:
            argv.extend(["--job-dir", str(production_checkpoint_path)])
        steps_run.append(_run("asimov_full_training_run", argv))
    if real_agent_run_path is not None:
        argv = [
            py,
            "scripts/validate_asimov1_real_agent_run.py",
            str(real_agent_run_path),
            "--require-allow-motion",
            "--require-motion",
        ]
        if production_checkpoint_path is not None:
            argv.extend(["--checkpoint", str(production_checkpoint_path)])
        if evidence_path is not None:
            argv.extend(["--hardware-evidence", str(evidence_path)])
        steps_run.append(_run("asimov_real_agent_run", argv))
    launch_stdout = next(step["stdout"] for step in steps_run if step["name"] == "bridge_targets")
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
        "workspace_promotion": str(workspace_promotion_path)
        if workspace_promotion_path
        else None,
        "require_promotion_applied": require_promotion_applied,
        "real_hardware_evidence": str(evidence_path) if evidence_path else None,
        "production_checkpoint": str(production_checkpoint_path)
        if production_checkpoint_path
        else None,
        "full_training_run": str(full_training_run_path) if full_training_run_path else None,
        "real_agent_run": str(real_agent_run_path) if real_agent_run_path else None,
        "production_min_steps": int(production_min_steps),
        "artifact_sha256": _artifact_sha256(
            workspace_promotion=workspace_promotion_path,
            real_hardware_evidence=evidence_path,
            production_checkpoint=production_checkpoint_path,
            full_training_run=full_training_run_path,
            real_agent_run=real_agent_run_path,
        ),
        "out_dir": str(out_dir),
        "checkpoint_dir": str(ckpt),
        "tiny_brax_training_job_dir": str(tiny_brax_job),
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
    parser.add_argument("--workspace-promotion", type=Path, default=None)
    parser.add_argument("--require-promotion-applied", action="store_true")
    parser.add_argument("--real-hardware-evidence", type=Path, default=None)
    parser.add_argument("--production-checkpoint", type=Path, default=None)
    parser.add_argument("--production-min-steps", type=int, default=1_000_000)
    parser.add_argument("--full-training-run", type=Path, default=None)
    parser.add_argument("--real-agent-run", type=Path, default=None)
    parser.add_argument("--asimov-livekit-url", default="")
    parser.add_argument("--asimov-livekit-token", default="")
    args = parser.parse_args()
    report = run_asimov1_e2e(
        args.out,
        steps=args.steps,
        seed=args.seed,
        require_real=args.require_real,
        workspace_promotion=args.workspace_promotion,
        require_promotion_applied=args.require_promotion_applied,
        real_hardware_evidence=args.real_hardware_evidence,
        production_checkpoint=args.production_checkpoint,
        production_min_steps=args.production_min_steps,
        full_training_run=args.full_training_run,
        real_agent_run=args.real_agent_run,
    )
    print(json.dumps(report, indent=2))
    return 0 if report["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
