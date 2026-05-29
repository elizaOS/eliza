from __future__ import annotations

import subprocess
import sys
import json

from eliza_robot.asimov_1.constants import ASIMOV1_FULL_ACTION_DIM
from eliza_robot.asimov_1.mujoco_load_proof import (
    build_mujoco_load_proof,
    collect_static_mjcf_checks,
)


def test_static_mjcf_checks_capture_actuator_and_meshdir_state() -> None:
    checks = collect_static_mjcf_checks()

    assert checks.mjcf_exists is True
    assert checks.mesh_refs == 28
    assert checks.position_actuators == ASIMOV1_FULL_ACTION_DIM
    assert checks.expected_actuators == ASIMOV1_FULL_ACTION_DIM
    assert checks.actuator_joints_match_firmware_order is True
    assert checks.foot_collision_geoms >= 10
    assert checks.compiler_meshdir_exists is True
    assert checks.mesh_files_found == 28


def test_mujoco_load_proof_fails_closed_without_valid_local_load() -> None:
    report = build_mujoco_load_proof()

    assert report["schema"] == "asimov-1-mujoco-load-proof-v1"
    assert report["summary"]["position_actuators"] == ASIMOV1_FULL_ACTION_DIM
    assert report["summary"]["expected_actuators"] == ASIMOV1_FULL_ACTION_DIM
    assert report["summary"]["compiler_meshdir_exists"] is True
    assert report["summary"]["mesh_files_found"] == 28
    if report["ok"]:
        assert len(report["links"]) == 28
    else:
        assert report["links"] == []


def test_mujoco_load_proof_cli_can_require_ok(tmp_path) -> None:
    output = tmp_path / "mujoco-load.json"
    proc = subprocess.run(
        [
            sys.executable,
            "scripts/generate_asimov1_mujoco_load_proof.py",
            "--output",
            str(output),
            "--require-ok",
        ],
        cwd=".",
        text=True,
        capture_output=True,
        check=False,
    )

    assert proc.returncode in {0, 2}
    assert output.is_file()
    report = json.loads(output.read_text(encoding="utf-8"))
    assert proc.returncode == (0 if report["ok"] else 2)
    assert '"schema": "asimov-1-mujoco-load-proof-v1"' in proc.stdout
