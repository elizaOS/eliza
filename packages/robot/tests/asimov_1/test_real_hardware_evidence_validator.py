from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.validate_asimov1_real_hardware_evidence import (  # noqa: E402
    validate_asimov1_real_hardware_evidence,
)


def _telemetry(sequence: int) -> dict:
    return {
        "mode": "STAND",
        "sequence": sequence,
        "timestamp_us": 100 + sequence,
        "fw_timestamp_us": 90 + sequence,
        "error_flags": 0,
        "fw_age_ms": 2,
        "joint_position_count": 25,
        "joint_velocity_count": 25,
        "imu_quat_count": 4,
        "imu_gyro_count": 3,
        "imu_gravity_count": 3,
    }


def _valid_report() -> dict:
    return {
        "schema": "asimov-1-real-hardware-evidence-v1",
        "ok": True,
        "profile_id": "asimov-1",
        "evidence": "real_hardware_livekit_control",
        "checks": {
            "strict_preflight": True,
            "telemetry_probe_completed": True,
            "telemetry_probe_ok": True,
            "command_probe_completed": True,
            "command_probe_ok": True,
            "non_default_motion_requires_flags": True,
        },
        "stages": [
            {
                "name": "strict_preflight",
                "ok": True,
                "report": {
                    "ok": True,
                    "profile_id": "asimov-1",
                    "target": "asimov-real",
                    "backend": "asimov_remote",
                },
            },
            {
                "name": "telemetry_only",
                "ok": True,
                "report": {
                    "ok": True,
                    "profile_id": "asimov-1",
                    "probe": "telemetry_only",
                    "command_messages_published": 0,
                    "checks": {"connected": True, "telemetry_received": True},
                    "telemetry": _telemetry(1),
                },
            },
            {
                "name": "staged_real_command",
                "ok": True,
                "report": {
                    "ok": True,
                    "profile_id": "asimov-1",
                    "probe": "staged_real_command",
                    "non_default_motion_stages_enabled": {
                        "stand": False,
                        "zero_velocity": False,
                    },
                    "commands_sent": ["mode:DAMP"],
                    "checks": {
                        "connected": True,
                        "telemetry_before_commands": True,
                        "telemetry_after_commands": True,
                        "damp_command_sent": True,
                        "stand_requires_flag": True,
                        "zero_velocity_requires_flag": True,
                    },
                    "telemetry_before": _telemetry(2),
                    "telemetry_after": _telemetry(3),
                },
            },
        ],
    }


def test_real_hardware_evidence_validator_accepts_complete_report() -> None:
    validation = validate_asimov1_real_hardware_evidence(_valid_report())

    assert validation["ok"] is True
    assert all(validation["checks"].values())


def test_real_hardware_evidence_validator_rejects_missing_command_probe() -> None:
    report = _valid_report()
    report["stages"] = report["stages"][:2]

    validation = validate_asimov1_real_hardware_evidence(report)

    assert validation["ok"] is False
    assert validation["checks"]["required_stages_present"] is False
    assert validation["checks"]["command_probe_ok"] is False


def test_real_hardware_evidence_validator_rejects_unversioned_report() -> None:
    report = _valid_report()
    del report["schema"]

    validation = validate_asimov1_real_hardware_evidence(report)

    assert validation["ok"] is False
    assert validation["checks"]["schema"] is False


def test_real_hardware_evidence_validator_rejects_non_advancing_command_telemetry() -> None:
    report = _valid_report()
    command = report["stages"][2]["report"]
    command["telemetry_after"] = dict(command["telemetry_before"])

    validation = validate_asimov1_real_hardware_evidence(report)

    assert validation["ok"] is False
    assert validation["checks"]["command_probe_telemetry_advanced"] is False


def test_real_hardware_evidence_validator_rejects_unsafe_telemetry_status() -> None:
    report = _valid_report()
    report["stages"][1]["report"]["telemetry"]["error_flags"] = 4

    validation = validate_asimov1_real_hardware_evidence(report)

    assert validation["ok"] is False
    assert validation["checks"]["telemetry_status"] is False


def test_real_hardware_evidence_validator_rejects_stale_command_telemetry() -> None:
    report = _valid_report()
    report["stages"][2]["report"]["telemetry_after"]["fw_age_ms"] = 5000

    validation = validate_asimov1_real_hardware_evidence(report)

    assert validation["ok"] is False
    assert validation["checks"]["command_probe_telemetry_status"] is False


def test_real_hardware_evidence_validator_rejects_forged_nested_probe_checks() -> None:
    report = _valid_report()
    report["stages"][2]["report"]["checks"]["zero_velocity_requires_flag"] = False

    validation = validate_asimov1_real_hardware_evidence(report)

    assert validation["ok"] is False
    assert validation["checks"]["command_probe_checks"] is False


def test_real_hardware_evidence_validator_rejects_velocity_without_stand_flag() -> None:
    report = _valid_report()
    command = report["stages"][2]["report"]
    command["commands_sent"] = ["mode:DAMP", "velocity:zero"]
    command["non_default_motion_stages_enabled"] = {
        "stand": False,
        "zero_velocity": True,
    }

    validation = validate_asimov1_real_hardware_evidence(report)

    assert validation["ok"] is False
    assert validation["checks"]["command_probe_safety_flags"] is False


def test_real_hardware_evidence_validator_cli(tmp_path: Path) -> None:
    report_path = tmp_path / "evidence.json"
    report_path.write_text(json.dumps(_valid_report()), encoding="utf-8")

    proc = subprocess.run(
        [
            sys.executable,
            "packages/robot/scripts/validate_asimov1_real_hardware_evidence.py",
            str(report_path),
        ],
        cwd=Path(__file__).resolve().parents[4],
        text=True,
        capture_output=True,
        check=False,
    )

    assert proc.returncode == 0
    assert json.loads(proc.stdout)["ok"] is True
