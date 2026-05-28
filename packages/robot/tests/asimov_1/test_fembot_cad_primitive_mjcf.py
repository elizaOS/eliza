from __future__ import annotations

import json
import subprocess
import sys

from eliza_robot.asimov_1.fembot_cad_primitive_mjcf import (
    build_fembot_cad_primitive_mjcf_proof,
)
from eliza_robot.asimov_1.fembot_inventory import FEMBOT_BODY_GROUP_LINKS


def _body_groups() -> list[dict[str, object]]:
    return [
        {"group": group, "links": list(links)}
        for group, links in FEMBOT_BODY_GROUP_LINKS.items()
    ]


def test_fembot_cad_primitive_mjcf_compiles_without_mesh_assets(tmp_path) -> None:
    report = build_fembot_cad_primitive_mjcf_proof(
        _body_groups(),
        output_mjcf=tmp_path / "asimov_fembot_cad_primitive.xml",
    )

    assert report["schema"] == "asimov-fembot-cad-primitive-mjcf-v1"
    assert report["ok"] is True
    assert report["accepted"] is False
    assert report["summary"]["links"] == 28
    assert report["summary"]["generated_step_links"] == 28
    assert report["summary"]["missing_generated_step_links"] == []
    assert report["summary"]["source_mesh_assets_removed"] == 28
    assert report["summary"]["mesh_visual_geoms_replaced"] == 28
    assert report["summary"]["mesh_visual_geom_replacement_failures"] == 0
    assert report["summary"]["ellipsoid_visual_primitives"] == 26
    assert report["summary"]["box_visual_primitives"] == 2
    assert report["summary"]["primitive_type_counts"] == {
        "box": 2,
        "ellipsoid": 26,
    }
    assert report["summary"]["visual_envelope_matches_generated_cad"] is True
    assert report["summary"]["visual_envelope_failure_count"] == 0
    assert report["summary"]["max_visual_bbox_center_delta_m"] == 0.0
    assert report["summary"]["max_visual_bbox_extent_delta_m"] == 0.0
    assert report["summary"]["mujoco_compiled"] is True
    assert report["summary"]["nmesh"] == 0
    assert report["summary"]["nu"] == 25
    assert report["summary"]["no_stl_mesh_assets"] is True
    assert report["summary"]["all_visual_meshes_replaced_with_cad_primitives"] is True
    assert "shape-aware CAD-extent primitives" in report["summary"]["acceptance_blocker"]

    by_link = {record["link"]: record for record in report["replacements"]}
    pelvis = by_link["IMU_ORIGIN"]
    assert pelvis["replaced"] is True
    assert pelvis["source_mesh"] == "pelvis.STL"
    assert pelvis["primitive"] == "ellipsoid"
    assert pelvis["shape_family"] == "hollow_lofted_elliptic_shell_reference"
    assert len(pelvis["size_m"]) == 3
    assert pelvis["visual_envelope_matches_generated_cad"] is True
    assert pelvis["visual_bbox_extent_delta_m"] == 0.0
    assert pelvis["visual_bbox_center_delta_m"] == 0.0
    assert pelvis["visual_bbox_extent_m"] == pelvis["generated_bbox_extent_m"]
    assert pelvis["visual_bbox_center_m"] == pelvis["generated_bbox_center_m"]
    assert pelvis["generated_step_path"].endswith("/imu_origin.step")
    assert pelvis["generated_step_reload_ok"] is True
    assert pelvis["generated_step_extent_within_tolerance"] is True
    toe = by_link["LEFT_TOE"]
    assert toe["primitive"] == "box"
    assert toe["shape_family"] == "flat_plate_envelope"


def test_fembot_cad_primitive_mjcf_cli_writes_gateable_proof(tmp_path) -> None:
    proof_output = tmp_path / "fembot-cad-primitive-mjcf.json"
    mjcf_output = tmp_path / "asimov_fembot_cad_primitive.xml"
    proc = subprocess.run(
        [
            sys.executable,
            "scripts/generate_asimov_fembot_cad_primitive_mjcf.py",
            "--proof-output",
            str(proof_output),
            "--mjcf-output",
            str(mjcf_output),
            "--require-accepted",
        ],
        cwd=".",
        text=True,
        capture_output=True,
        check=False,
    )

    assert proof_output.is_file()
    assert mjcf_output.is_file()
    report = json.loads(proof_output.read_text(encoding="utf-8"))
    assert report["schema"] == "asimov-fembot-cad-primitive-mjcf-v1"
    assert report["ok"] is True
    assert report["accepted"] is False
    assert report["summary"]["nmesh"] == 0
    assert report["summary"]["mesh_visual_geoms_replaced"] == 28
    assert report["summary"]["ellipsoid_visual_primitives"] == 26
    assert report["summary"]["box_visual_primitives"] == 2
    assert report["summary"]["visual_envelope_matches_generated_cad"] is True
    assert report["summary"]["visual_envelope_failure_count"] == 0
    assert proc.returncode == 2
    assert '"nmesh": 0' in proc.stdout
