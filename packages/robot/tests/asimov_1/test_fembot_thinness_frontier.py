from __future__ import annotations

import json
import subprocess
import sys

from eliza_robot.asimov_1.fembot_inventory import (
    FEMBOT_BODY_GROUP_LINKS,
    collect_fembot_inventory,
)
from eliza_robot.asimov_1.fembot_thinness_frontier import (
    build_fembot_thinness_frontier_proof,
)


def _body_groups() -> list[dict[str, object]]:
    return [
        {"group": group, "links": list(links)}
        for group, links in FEMBOT_BODY_GROUP_LINKS.items()
    ]


def test_fembot_thinness_frontier_identifies_active_limiters() -> None:
    report = build_fembot_thinness_frontier_proof(_body_groups())

    assert report["schema"] == "asimov-fembot-thinness-frontier-proof-v1"
    assert report["ok"] is True
    assert report["accepted"] is False
    assert report["summary"]["links"] == 28
    assert report["summary"]["missing_links"] == []
    assert report["summary"]["height_preserved_links"] == 28
    assert report["summary"]["source_envelope_preserved_links"] == 28
    assert report["summary"]["source_envelope_tolerance_m"] == 0.005
    assert report["summary"]["source_envelope_max_abs_delta_m"] < 0.005
    assert report["summary"]["source_to_candidate_xy_reduction_fraction"] > 0.7
    assert (
        report["summary"]["source_to_clearance_adjusted_xy_reduction_fraction"]
        > 0.7
    )
    assert abs(report["summary"]["source_to_generated_xy_area_delta_fraction"]) < 0.02
    assert report["summary"]["keepout_limited_links"] == 14
    assert report["summary"]["internal_cavity_limited_links"] == 26
    assert report["summary"]["internal_cavity_violation_component_counts"] == {
        "collision_keepout": 28,
        "joint_axis": 21,
        "motor_actuator": 23,
        "site": 1,
    }
    assert report["summary"]["full_cavity_clearance_candidate_links"] == 26
    assert report["summary"]["full_cavity_clearance_height_preserved_links"] == 10
    assert report["summary"]["full_cavity_clearance_z_expansion_links"] == 16
    assert report["summary"]["structural_limited_links"] == 0
    assert report["summary"]["supplier_vendor_limited_links"] == 8
    assert report["summary"]["supplier_vendor_max_required_extent_growth_m"] == 0.0264997322031618
    assert report["summary"]["supplier_vendor_worst_growth_links"] == [
        "LEFT_KNEE",
        "RIGHT_KNEE",
        "LEFT_ANKLE_A",
        "RIGHT_ANKLE_A",
        "LEFT_HIP_YAW",
        "RIGHT_HIP_YAW",
        "LEFT_HIP_ROLL",
        "RIGHT_HIP_ROLL",
    ]
    assert (
        report["summary"]["supplier_vendor_adjusted_total_sorted_footprint_area_m2"]
        > report["summary"]["generated_total_sorted_footprint_area_m2"]
    )
    assert report["summary"]["active_limiter_counts"]["z_height_preservation"] == 28
    assert report["summary"]["active_limiter_counts"]["internal_cavity_keepout"] == 26
    assert report["summary"]["active_limiter_counts"]["keepout_clearance"] == 14
    assert report["summary"]["active_limiter_counts"]["supplier_vendor_keepout"] == 8

    links = {record["link"]: record for record in report["links"]}
    assert links["IMU_ORIGIN"]["z_height_preserved"] is True
    assert links["IMU_ORIGIN"]["source_envelope_preserved"] is True
    assert links["IMU_ORIGIN"]["internal_cavity_limited"] is True
    assert "internal_cavity_keepout" in links["IMU_ORIGIN"]["active_limiters"]
    assert links["LEFT_KNEE"]["structural_limited"] is False
    assert links["LEFT_KNEE"]["supplier_vendor_limited"] is True
    assert "supplier_vendor_keepout" in links["LEFT_KNEE"]["active_limiters"]
    assert links["LEFT_KNEE"]["full_cavity_clearance_candidate"]["required"] is True
    assert (
        links["LEFT_KNEE"]["full_cavity_clearance_candidate"][
            "internal_cavity_cleared"
        ]
        is True
    )
    assert (
        links["LEFT_KNEE"]["supplier_vendor_growth"][
            "max_required_extent_growth_m"
        ]
        == 0.0264997322031618
    )
    assert links["LEFT_TOE"]["internal_cavity_limited"] is False
    assert links["LEFT_TOE"]["supplier_vendor_limited"] is False


def test_fembot_inventory_surfaces_thinness_frontier_status() -> None:
    report = collect_fembot_inventory()

    assert report["thinness_frontier"]["ok"] is True
    assert report["thinness_frontier"]["accepted"] is False
    assert report["thinness_frontier"]["summary"]["links"] == 28
    assert report["thinness_frontier"]["summary"]["height_preserved_links"] == 28
    assert report["thinness_frontier"]["summary"]["source_envelope_preserved_links"] == 28
    assert report["thinness_frontier"]["summary"]["supplier_vendor_limited_links"] == 8
    assert (
        report["thinness_frontier"]["summary"][
            "source_to_clearance_adjusted_xy_reduction_fraction"
        ]
        > 0.7
    )


def test_fembot_thinness_frontier_cli_writes_gateable_proof(tmp_path) -> None:
    output = tmp_path / "fembot-thinness-frontier.json"
    proc = subprocess.run(
        [
            sys.executable,
            "scripts/generate_asimov_fembot_thinness_frontier_proof.py",
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
    assert report["schema"] == "asimov-fembot-thinness-frontier-proof-v1"
    assert report["ok"] is True
    assert report["accepted"] is False
    assert proc.returncode == 2
    assert '"accepted": false' in proc.stdout
