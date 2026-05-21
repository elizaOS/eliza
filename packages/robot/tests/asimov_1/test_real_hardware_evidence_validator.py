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
                    "commands_sent": ["mode:DAMP"],
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
