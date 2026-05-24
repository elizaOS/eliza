#!/usr/bin/env python3
"""Validate an archived ASIMOV-1 real-agent runner report."""

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


def _load(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def _sha256_file(path: Path | None) -> str | None:
    if path is None or not path.is_file():
        return None
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _path_from_evidence(value: Any) -> Path | None:
    if not isinstance(value, str) or not value:
        return None
    return Path(value).resolve()


def _checkpoint_policy_artifact(checkpoint: Path | None) -> Path | None:
    if checkpoint is None:
        return None
    try:
        manifest = _load(checkpoint / "manifest.json")
    except Exception:
        return None
    artifact = manifest.get("ckpt", "policy_brax.pkl")
    if not isinstance(artifact, str) or not artifact:
        return None
    return (checkpoint / artifact).resolve()


def _checkpoint_regime(checkpoint: Path | None) -> str:
    if checkpoint is None:
        return ""
    try:
        manifest = _load(checkpoint / "manifest.json")
    except Exception:
        return ""
    regime = manifest.get("regime")
    return regime if isinstance(regime, str) else ""


def _sidecar_required(regime: str) -> bool:
    return regime != "alberta_streaming"


def _optional_hash_matches(
    evidence: dict[str, Any],
    key: str,
    expected_sha: str | None,
    *,
    required: bool,
) -> bool:
    archived = evidence.get(key)
    if required:
        return expected_sha is not None and archived == expected_sha
    return archived is None if expected_sha is None else archived == expected_sha


def validate_asimov1_real_agent_run(
    report_path: Path,
    *,
    checkpoint: Path | None = None,
    hardware_evidence: Path | None = None,
    require_motion: bool = False,
    require_allow_motion: bool = False,
) -> dict[str, Any]:
    report_path = report_path.resolve()
    report = _load(report_path)
    evidence = report.get("run_evidence")
    evidence = evidence if isinstance(evidence, dict) else {}
    archived_checkpoint_path = _path_from_evidence(evidence.get("checkpoint"))
    archived_hardware_path = _path_from_evidence(evidence.get("hardware_evidence"))
    checkpoint_path = checkpoint.resolve() if checkpoint is not None else archived_checkpoint_path
    hardware_path = (
        hardware_evidence.resolve()
        if hardware_evidence is not None
        else archived_hardware_path
    )
    expected_manifest_sha = (
        _sha256_file(checkpoint_path / "manifest.json") if checkpoint_path is not None else None
    )
    expected_training_job_sha = (
        _sha256_file(checkpoint_path / "training_job.json")
        if checkpoint_path is not None
        else None
    )
    expected_config_sha = (
        _sha256_file(checkpoint_path / "config.json") if checkpoint_path is not None else None
    )
    expected_metrics_sha = (
        _sha256_file(checkpoint_path / "metrics.json") if checkpoint_path is not None else None
    )
    expected_inference_sha = (
        _sha256_file(checkpoint_path / "inference_check.json")
        if checkpoint_path is not None
        else None
    )
    expected_policy_path = _checkpoint_policy_artifact(checkpoint_path)
    archived_policy_path = _path_from_evidence(evidence.get("checkpoint_policy"))
    expected_policy_sha = _sha256_file(expected_policy_path)
    expected_hardware_sha = _sha256_file(hardware_path) if hardware_path is not None else None
    checkpoint_regime = _checkpoint_regime(checkpoint_path)
    require_sidecars = _sidecar_required(checkpoint_regime)
    production_validation = (
        validate_asimov1_production_checkpoint(
            checkpoint_path,
            min_steps=int(evidence.get("production_min_steps", 0)),
            require_inference_check=True,
        )
        if checkpoint_path is not None and checkpoint_path.is_dir()
        else None
    )
    archived_production = evidence.get("production_validation")
    archived_production = archived_production if isinstance(archived_production, dict) else {}
    archived_production_checks = archived_production.get("checks")
    archived_production_checks = (
        archived_production_checks if isinstance(archived_production_checks, dict) else {}
    )
    current_production_checks = (
        production_validation.get("checks")
        if isinstance(production_validation, dict)
        else {}
    )
    current_production_checks = (
        current_production_checks if isinstance(current_production_checks, dict) else {}
    )
    hardware_validation = (
        validate_asimov1_real_hardware_evidence(_load(hardware_path))
        if hardware_path is not None and hardware_path.is_file()
        else None
    )
    checks = {
        "top_level_ok": report.get("ok") is True,
        "schema": evidence.get("schema") == "asimov-1-real-agent-run-v1",
        "profile_id": report.get("profile_id") == "asimov-1"
        and evidence.get("profile_id") == "asimov-1",
        "checkpoint_present": bool(evidence.get("checkpoint")),
        "hardware_evidence_present": bool(evidence.get("hardware_evidence")),
        "checkpoint_file_present": checkpoint_path is not None and checkpoint_path.is_dir(),
        "checkpoint_manifest_present": checkpoint_path is not None
        and (checkpoint_path / "manifest.json").is_file(),
        "checkpoint_training_job_present": (
            checkpoint_path is not None and (checkpoint_path / "training_job.json").is_file()
        )
        if require_sidecars
        else expected_training_job_sha is None,
        "checkpoint_config_present": (
            checkpoint_path is not None and (checkpoint_path / "config.json").is_file()
        )
        if require_sidecars
        else expected_config_sha is None,
        "checkpoint_metrics_present": (
            checkpoint_path is not None and (checkpoint_path / "metrics.json").is_file()
        )
        if require_sidecars
        else expected_metrics_sha is None,
        "checkpoint_inference_check_present": (
            checkpoint_path is not None and (checkpoint_path / "inference_check.json").is_file()
        )
        if require_sidecars
        else expected_inference_sha is None,
        "checkpoint_policy_present": expected_policy_path is not None
        and expected_policy_path.is_file(),
        "hardware_evidence_file_present": hardware_path is not None and hardware_path.is_file(),
        "checkpoint_matches": archived_checkpoint_path is not None
        and checkpoint_path is not None
        and archived_checkpoint_path == checkpoint_path,
        "hardware_evidence_matches": archived_hardware_path is not None
        and hardware_path is not None
        and archived_hardware_path == hardware_path,
        "checkpoint_manifest_hash_matches": (
            expected_manifest_sha is not None
            and evidence.get("checkpoint_manifest_sha256") == expected_manifest_sha
        ),
        "checkpoint_training_job_hash_matches": _optional_hash_matches(
            evidence,
            "checkpoint_training_job_sha256",
            expected_training_job_sha,
            required=require_sidecars,
        ),
        "checkpoint_config_hash_matches": _optional_hash_matches(
            evidence,
            "checkpoint_config_sha256",
            expected_config_sha,
            required=require_sidecars,
        ),
        "checkpoint_metrics_hash_matches": _optional_hash_matches(
            evidence,
            "checkpoint_metrics_sha256",
            expected_metrics_sha,
            required=require_sidecars,
        ),
        "checkpoint_inference_check_hash_matches": _optional_hash_matches(
            evidence,
            "checkpoint_inference_check_sha256",
            expected_inference_sha,
            required=require_sidecars,
        ),
        "checkpoint_policy_matches": archived_policy_path is not None
        and expected_policy_path is not None
        and archived_policy_path == expected_policy_path,
        "checkpoint_policy_hash_matches": (
            expected_policy_sha is not None
            and evidence.get("checkpoint_policy_sha256") == expected_policy_sha
        ),
        "hardware_evidence_hash_matches": (
            expected_hardware_sha is not None
            and evidence.get("hardware_evidence_sha256") == expected_hardware_sha
        ),
        "production_ok": evidence.get("production_ok") is True,
        "production_validation_archived": archived_production.get("ok") is True,
        "production_validation_regime_matches": archived_production.get("production_regime")
        == (
            production_validation.get("production_regime")
            if isinstance(production_validation, dict)
            else None
        ),
        "production_validation_steps_match": archived_production.get("max_metric_steps")
        == (
            production_validation.get("max_metric_steps")
            if isinstance(production_validation, dict)
            else None
        ),
        "production_validation_checks_match": archived_production_checks
        == current_production_checks,
        "production_revalidates": production_validation is not None
        and production_validation.get("ok") is True,
        "hardware_ok": evidence.get("hardware_ok") is True,
        "hardware_revalidates": hardware_validation is not None
        and hardware_validation.get("ok") is True,
        "livekit_configured": evidence.get("livekit_url_configured") is True
        and evidence.get("livekit_token_configured") is True,
        "allow_motion": evidence.get("allow_motion") is True if require_allow_motion else True,
        "motion_executed": evidence.get("motion_executed") is True if require_motion else True,
        "motion_ok": evidence.get("motion_ok") is True if require_motion else True,
        "top_level_motion_matches_evidence": bool(report.get("motion_executed"))
        == bool(evidence.get("motion_executed")),
    }
    return {
        "ok": all(checks.values()),
        "profile_id": "asimov-1",
        "report": str(report_path),
        "checkpoint": str(checkpoint_path) if checkpoint_path else None,
        "checkpoint_regime": checkpoint_regime,
        "hardware_evidence": str(hardware_path) if hardware_path else None,
        "require_motion": require_motion,
        "require_allow_motion": require_allow_motion,
        "checks": checks,
        "run_evidence": evidence,
        "production_validation": None
        if production_validation is None
        else {
            "ok": production_validation.get("ok"),
            "max_metric_steps": production_validation.get("max_metric_steps"),
            "checks": production_validation.get("checks"),
        },
        "hardware_validation": None
        if hardware_validation is None
        else {
            "ok": hardware_validation.get("ok"),
            "checks": hardware_validation.get("checks"),
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("report", type=Path)
    parser.add_argument("--checkpoint", type=Path, default=None)
    parser.add_argument("--hardware-evidence", type=Path, default=None)
    parser.add_argument("--require-motion", action="store_true")
    parser.add_argument("--require-allow-motion", action="store_true")
    args = parser.parse_args()
    validation = validate_asimov1_real_agent_run(
        args.report,
        checkpoint=args.checkpoint,
        hardware_evidence=args.hardware_evidence,
        require_motion=args.require_motion,
        require_allow_motion=args.require_allow_motion,
    )
    print(json.dumps(validation, indent=2))
    return 0 if validation["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
