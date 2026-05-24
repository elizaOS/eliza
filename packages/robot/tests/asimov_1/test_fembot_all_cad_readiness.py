from __future__ import annotations

import json
import subprocess
import sys

from eliza_robot.asimov_1.fembot_all_cad_readiness import (
    build_fembot_all_cad_readiness_proof,
)
from eliza_robot.asimov_1.fembot_inventory import (
    FEMBOT_BODY_GROUP_LINKS,
    collect_fembot_inventory,
)


def _body_groups() -> list[dict[str, object]]:
    return [
        {"group": group, "links": list(links)}
        for group, links in FEMBOT_BODY_GROUP_LINKS.items()
    ]


def test_fembot_all_cad_readiness_counts_remaining_stl_mesh_blocker() -> None:
    report = build_fembot_all_cad_readiness_proof(_body_groups())

    assert report["schema"] == "asimov-fembot-all-cad-readiness-v1"
    assert report["ok"] is True
    assert report["accepted"] is False
    assert report["summary"]["links"] == 28
    assert report["summary"]["links_with_generated_step_reference"] == 28
    assert report["summary"]["missing_generated_step_links"] == []
    assert report["summary"]["mjcf_mesh_assets"] == 28
    assert report["summary"]["mjcf_mesh_visual_geoms"] == 28
    assert report["summary"]["mjcf_stl_mesh_assets"] == 28
    assert report["summary"]["mjcf_stl_mesh_visual_geoms"] == 28
    assert report["summary"]["links_still_using_stl_mesh_assets"] == 28
    assert report["summary"]["no_stl_mesh_assets"] is False
    assert report["summary"]["all_cad_parametric_ready"] is False
    assert "still uses STL mesh assets" in report["summary"]["acceptance_blocker"]

    by_link = {record["link"]: record for record in report["mesh_assets"]}
    pelvis = by_link["IMU_ORIGIN"]
    assert pelvis["uses_stl"] is True
    assert pelvis["file"] == "IMU_ORIGIN.STL"
    assert pelvis["generated_step_path"].endswith("/imu_origin.step")
    assert pelvis["generated_step_sha256"]
    assert pelvis["generated_step_export_ok"] is True
    assert pelvis["generated_step_reload_ok"] is True
    assert pelvis["generated_step_extent_within_tolerance"] is True


def test_fembot_all_cad_readiness_cli_writes_gateable_proof(tmp_path) -> None:
    output = tmp_path / "fembot-all-cad-readiness.json"
    proc = subprocess.run(
        [
            sys.executable,
            "scripts/generate_asimov_fembot_all_cad_readiness.py",
            "--output",
            str(output),
            "--require-accepted",
        ],
        cwd=".",
        text=True,
        capture_output=True,
        check=False,
    )

    assert output.is_file()
    report = json.loads(output.read_text(encoding="utf-8"))
    assert report["schema"] == "asimov-fembot-all-cad-readiness-v1"
    assert report["ok"] is True
    assert report["accepted"] is False
    assert proc.returncode == 2
    assert '"mjcf_stl_mesh_assets": 28' in proc.stdout


def test_fembot_inventory_surfaces_all_cad_no_stl_gap() -> None:
    report = collect_fembot_inventory()

    assert report["all_cad_readiness"]["ok"] is True
    assert report["all_cad_readiness"]["accepted"] is False
    assert report["all_cad_readiness"]["summary"]["links_with_generated_step_reference"] == 28
    assert report["all_cad_readiness"]["summary"]["mjcf_stl_mesh_assets"] == 28
    assert report["all_cad_readiness"]["summary"]["links_still_using_stl_mesh_assets"] == 28
    assert report["all_cad_readiness"]["summary"]["no_stl_mesh_assets"] is False
