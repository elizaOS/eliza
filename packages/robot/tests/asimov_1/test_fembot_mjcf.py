from __future__ import annotations

import json
import subprocess
import sys

from eliza_robot.asimov_1.fembot_mjcf import generate_fembot_mjcf


def test_fembot_mjcf_primary_model_compiles_without_stl_mesh_assets(tmp_path) -> None:
    report = generate_fembot_mjcf(output_mjcf=tmp_path / "asimov_fembot.xml")

    assert report["schema"] == "asimov-fembot-mjcf-v1"
    assert report["ok"] is True
    assert report["accepted"] is False
    assert report["summary"]["mujoco_compiled"] is True
    assert report["summary"]["nmesh"] == 0
    assert report["summary"]["no_stl_mesh_assets"] is True
    assert report["summary"]["nu"] == 25
    assert report["summary"]["mass_inertia_ok"] is True
    assert report["summary"]["actuator_lag_ok"] is True
    assert report["summary"]["primary_visual_mesh_replacement_ok"] is True
    assert report["summary"]["primary_visual_mesh_assets_removed"] == 28
    assert report["summary"]["primary_visual_mesh_geoms_replaced"] == 28
    assert report["summary"]["primary_visual_mesh_geom_replacement_failures"] == 0
    assert report["summary"]["primary_visual_envelope_failure_count"] == 0
    assert report["summary"]["primary_visual_max_bbox_center_delta_m"] == 0.0
    assert report["summary"]["primary_visual_max_bbox_extent_delta_m"] == 0.0
    assert "without STL mesh assets" in report["summary"]["acceptance_blocker"]


def test_fembot_mjcf_cli_writes_no_stl_primary_proof(tmp_path) -> None:
    proof_output = tmp_path / "fembot-mjcf.json"
    mjcf_output = tmp_path / "asimov_fembot.xml"
    proc = subprocess.run(
        [
            sys.executable,
            "scripts/generate_asimov_fembot_mjcf.py",
            "--output",
            str(proof_output),
            "--output-mjcf",
            str(mjcf_output),
            "--require-ok",
        ],
        cwd=".",
        text=True,
        capture_output=True,
        check=False,
    )

    assert proc.returncode == 0, proc.stdout + proc.stderr
    report = json.loads(proof_output.read_text(encoding="utf-8"))
    assert report["ok"] is True
    assert report["accepted"] is False
    assert report["summary"]["nmesh"] == 0
    assert report["summary"]["primary_visual_mesh_geoms_replaced"] == 28
    assert '"no_stl_mesh_assets": true' in proc.stdout
