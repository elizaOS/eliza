#!/usr/bin/env python3
# ruff: noqa: E402,I001
"""Strict completion gate for the ASIMOV-1 integration objective."""

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

from scripts.validate_asimov1_production_checkpoint import (  # noqa: E402
    validate_asimov1_production_checkpoint,
)
from scripts.validate_asimov1_real_hardware_evidence import (  # noqa: E402
    validate_asimov1_real_hardware_evidence,
)
from scripts.validate_asimov1_real_agent_run import (  # noqa: E402
    validate_asimov1_real_agent_run,
)
from scripts.validate_asimov1_full_training_run import (  # noqa: E402
    validate_asimov1_full_training_run,
)
from scripts.validate_asimov1_workspace_promotion import (  # noqa: E402
    validate_workspace_promotion,
)


REQUIRED_E2E_STEPS = {
    "source_inventory",
    "released_model_audit",
    "cad_mujoco_training_pipeline",
    "cad_edit_loop",
    "full_training_job",
    "full_training_readiness",
    "full_training_runner_check",
    "asimov_full_training_run",
    "tiny_brax_training_job",
    "asimov_sim_gate",
    "asimov_controller_contract",
    "asimov_server_command_surface",
    "asimov_real_bridge_dry_run",
    "asimov_real_agent_readiness",
    "asimov_real_prereqs",
    "asimov_real_agent_run",
    "bridge_targets",
    "asimov_production_checkpoint",
    "asimov_real_hardware_evidence",
}


def _load(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def _sha256_file(path: Path | None) -> str | None:
    if path is None or not path.is_file():
        return None
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _checkpoint_policy_artifact(checkpoint: Path) -> Path | None:
    try:
        manifest = _load(checkpoint / "manifest.json")
    except Exception:
        return None
    artifact = manifest.get("ckpt", "policy_brax.pkl")
    if not isinstance(artifact, str) or not artifact:
        return None
    return (checkpoint / artifact).resolve()


def _checkpoint_regime(checkpoint: Path) -> str:
    try:
        manifest = _load(checkpoint / "manifest.json")
    except Exception:
        return ""
    regime = manifest.get("regime")
    return regime if isinstance(regime, str) else ""


def _sidecar_hash_matches(
    report: dict[str, Any],
    name: str,
    path: Path,
    *,
    required: bool,
) -> bool:
    expected = _sha256_file(path)
    archived = _artifact_hash(report, name)
    if required:
        return archived == expected and expected is not None
    return archived is None if expected is None else archived == expected


def _workspace_promotion_plan(workspace: Path | None) -> Path | None:
    return None if workspace is None else (workspace / "asimov_promotion_plan.json").resolve()


def _artifact_hash(report: dict[str, Any], name: str) -> str | None:
    hashes = report.get("artifact_sha256")
    if not isinstance(hashes, dict):
        return None
    value = hashes.get(name)
    return value if isinstance(value, str) else None


def _step_names(report: dict[str, Any]) -> set[str]:
    steps = report.get("steps", [])
    if not isinstance(steps, list):
        return set()
    return {str(step.get("name")) for step in steps if isinstance(step, dict)}


def _step_passed(report: dict[str, Any], name: str) -> bool:
    for step in report.get("steps", []):
        if isinstance(step, dict) and step.get("name") == name:
            return step.get("passed") is True
    return False


def _step_parsed(report: dict[str, Any], name: str) -> dict[str, Any]:
    for step in report.get("steps", []):
        if isinstance(step, dict) and step.get("name") == name:
            parsed = step.get("parsed")
            return parsed if isinstance(parsed, dict) else {}
    return {}


def validate_asimov1_completion(
    *,
    e2e_report: Path,
    production_checkpoint: Path,
    hardware_evidence: Path,
    full_training_run: Path,
    real_agent_run: Path,
    production_min_steps: int,
    workspace_promotion: Path | None = None,
    require_promotion_applied: bool = False,
) -> dict[str, Any]:
    e2e_path = e2e_report.resolve()
    checkpoint_path = production_checkpoint.resolve()
    hardware_path = hardware_evidence.resolve()
    full_training_run_path = full_training_run.resolve()
    real_agent_run_path = real_agent_run.resolve()
    workspace_path = workspace_promotion.resolve() if workspace_promotion else None

    e2e = _load(e2e_path)
    production = validate_asimov1_production_checkpoint(
        checkpoint_path,
        min_steps=production_min_steps,
        require_inference=False,
        require_inference_check=True,
    )
    hardware = validate_asimov1_real_hardware_evidence(_load(hardware_path))
    training_run = validate_asimov1_full_training_run(
        full_training_run_path,
        job_dir=checkpoint_path,
    )
    agent_run = validate_asimov1_real_agent_run(
        real_agent_run_path,
        checkpoint=checkpoint_path,
        hardware_evidence=hardware_path,
        require_motion=True,
        require_allow_motion=True,
    )
    workspace = (
        validate_workspace_promotion(
            workspace_path,
            require_applied=require_promotion_applied,
        )
        if workspace_path is not None
        else None
    )
    names = _step_names(e2e)
    readiness = _step_parsed(e2e, "asimov_real_agent_readiness")
    checkpoint_regime = _checkpoint_regime(checkpoint_path)
    require_checkpoint_sidecars = checkpoint_regime != "alberta_streaming"
    checks = {
        "e2e_ok": e2e.get("ok") is True,
        "e2e_profile": e2e.get("profile_id") == "asimov-1",
        "e2e_required_steps_present": REQUIRED_E2E_STEPS.issubset(names),
        "e2e_required_steps_passed": all(_step_passed(e2e, name) for name in REQUIRED_E2E_STEPS),
        "e2e_production_min_steps": int(e2e.get("production_min_steps", 0)) >= production_min_steps,
        "e2e_references_checkpoint": Path(str(e2e.get("production_checkpoint", ""))).resolve()
        == checkpoint_path,
        "e2e_references_hardware": Path(str(e2e.get("real_hardware_evidence", ""))).resolve()
        == hardware_path,
        "e2e_references_full_training_run": Path(str(e2e.get("full_training_run", ""))).resolve()
        == full_training_run_path,
        "e2e_references_real_agent_run": Path(str(e2e.get("real_agent_run", ""))).resolve()
        == real_agent_run_path,
        "e2e_readiness_requires_production": readiness.get("require_production") is True,
        "e2e_readiness_requires_hardware": readiness.get("require_hardware") is True,
        "e2e_readiness_production_ready": readiness.get("production_ready") is True,
        "e2e_readiness_references_checkpoint": Path(str(readiness.get("checkpoint", ""))).resolve()
        == checkpoint_path,
        "e2e_readiness_references_hardware": Path(str(readiness.get("hardware_evidence", ""))).resolve()
        == hardware_path,
        "e2e_checkpoint_manifest_hash": _artifact_hash(e2e, "production_checkpoint_manifest")
        == _sha256_file(checkpoint_path / "manifest.json"),
        "e2e_checkpoint_training_job_hash": _sidecar_hash_matches(
            e2e,
            "production_checkpoint_training_job",
            checkpoint_path / "training_job.json",
            required=require_checkpoint_sidecars,
        ),
        "e2e_checkpoint_config_hash": _sidecar_hash_matches(
            e2e,
            "production_checkpoint_config",
            checkpoint_path / "config.json",
            required=require_checkpoint_sidecars,
        ),
        "e2e_checkpoint_metrics_hash": _sidecar_hash_matches(
            e2e,
            "production_checkpoint_metrics",
            checkpoint_path / "metrics.json",
            required=require_checkpoint_sidecars,
        ),
        "e2e_checkpoint_inference_check_hash": _sidecar_hash_matches(
            e2e,
            "production_checkpoint_inference_check",
            checkpoint_path / "inference_check.json",
            required=require_checkpoint_sidecars,
        ),
        "e2e_checkpoint_policy_hash": _artifact_hash(e2e, "production_checkpoint_policy")
        == _sha256_file(_checkpoint_policy_artifact(checkpoint_path)),
        "e2e_hardware_evidence_hash": _artifact_hash(e2e, "real_hardware_evidence")
        == _sha256_file(hardware_path),
        "e2e_full_training_run_hash": _artifact_hash(e2e, "full_training_run")
        == _sha256_file(full_training_run_path),
        "e2e_real_agent_run_hash": _artifact_hash(e2e, "real_agent_run")
        == _sha256_file(real_agent_run_path),
        "production_checkpoint": production["ok"],
        "hardware_evidence": hardware["ok"],
        "full_training_run": training_run["ok"],
        "real_agent_run": agent_run["ok"],
        "workspace_promotion": workspace is None or workspace["ok"],
    }
    if workspace_path is not None:
        checks["e2e_references_workspace"] = Path(str(e2e.get("workspace_promotion", ""))).resolve() == workspace_path
        checks["e2e_promotion_applied_mode"] = bool(e2e.get("require_promotion_applied")) == require_promotion_applied
        checks["e2e_workspace_promotion_plan_hash"] = _artifact_hash(
            e2e, "workspace_promotion_plan"
        ) == _sha256_file(_workspace_promotion_plan(workspace_path))

    return {
        "ok": all(checks.values()),
        "profile_id": "asimov-1",
        "completion_gate": "asimov-1-full-integration",
        "checkpoint_regime": checkpoint_regime,
        "checks": checks,
        "e2e_report": str(e2e_path),
        "production_checkpoint": str(checkpoint_path),
        "hardware_evidence": str(hardware_path),
        "full_training_run": str(full_training_run_path),
        "real_agent_run": str(real_agent_run_path),
        "workspace_promotion": str(workspace_path) if workspace_path else None,
        "production": {
            "ok": production["ok"],
            "max_metric_steps": production.get("max_metric_steps"),
            "min_steps": production_min_steps,
        },
        "hardware": {"ok": hardware["ok"]},
        "full_training_run_validation": {"ok": training_run["ok"]},
        "real_agent_run_validation": {"ok": agent_run["ok"]},
        "workspace": None if workspace is None else {"ok": workspace["ok"]},
        "missing_e2e_steps": sorted(REQUIRED_E2E_STEPS - names),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--e2e-report", type=Path, required=True)
    parser.add_argument("--production-checkpoint", type=Path, required=True)
    parser.add_argument("--hardware-evidence", type=Path, required=True)
    parser.add_argument("--full-training-run", type=Path, required=True)
    parser.add_argument("--real-agent-run", type=Path, required=True)
    parser.add_argument("--production-min-steps", type=int, default=1_000_000)
    parser.add_argument("--workspace-promotion", type=Path, default=None)
    parser.add_argument("--require-promotion-applied", action="store_true")
    args = parser.parse_args()
    report = validate_asimov1_completion(
        e2e_report=args.e2e_report,
        production_checkpoint=args.production_checkpoint,
        hardware_evidence=args.hardware_evidence,
        full_training_run=args.full_training_run,
        real_agent_run=args.real_agent_run,
        production_min_steps=args.production_min_steps,
        workspace_promotion=args.workspace_promotion,
        require_promotion_applied=args.require_promotion_applied,
    )
    print(json.dumps(report, indent=2))
    return 0 if report["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
