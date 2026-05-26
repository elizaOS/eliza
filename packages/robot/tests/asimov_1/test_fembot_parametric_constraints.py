from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from eliza_robot.asimov_1.fembot_inventory import (
    FEMBOT_BODY_GROUP_LINKS,
    collect_fembot_inventory,
)
from eliza_robot.asimov_1.fembot_parametric_constraints import (
    build_fembot_parametric_constraints_proof,
)


def _body_groups() -> list[dict[str, object]]:
    return [
        {"group": group, "links": list(links)}
        for group, links in FEMBOT_BODY_GROUP_LINKS.items()
    ]


def _proof(name: str) -> dict | None:
    path = Path("cad/asimov-feminine/proofs") / name
    return json.loads(path.read_text(encoding="utf-8")) if path.is_file() else None


def test_fembot_parametric_constraints_manifest_links_parameters_to_proofs() -> None:
    report = build_fembot_parametric_constraints_proof(
        _body_groups(),
        slimming_report=_proof("fembot-slimming-envelope.json"),
        clearance_report=_proof("fembot-clearance-projection.json"),
        generated_cad_report=_proof("fembot-generated-cad-envelope.json"),
        material_report=_proof("fembot-material-manufacturing.json"),
        surface_report=_proof("fembot-surface-quality.json"),
        topology_report=_proof("fembot-topology.json"),
        topology_promotion_report=_proof("fembot-topology-promotion.json"),
        mold_dfm_report=_proof("fembot-mold-dfm.json"),
        thinness_frontier_report=_proof("fembot-thinness-frontier.json"),
    )

    assert report["schema"] == "asimov-fembot-parametric-constraints-v1"
    assert report["ok"] is True
    assert report["accepted"] is False
    assert report["summary"]["links"] == 28
    assert report["summary"]["missing_links"] == []
    assert report["summary"]["parameters"] == 84
    assert report["summary"]["dimension_parameters_per_link"] == 3
    assert report["summary"]["constraints"] == 228
    assert report["summary"]["verified_constraints"] == 176
    assert report["summary"]["production_blockers"] == 170
    assert report["summary"]["links_with_height_preserved"] == 28
    assert report["summary"]["links_with_keepout_adjusted_clearance"] == 28
    assert report["summary"]["links_with_topology_accepted"] == 28
    assert report["summary"]["links_with_promoted_topology_accepted"] == 28
    assert report["summary"]["links_with_full_cavity_clearance_candidate"] == 26
    assert report["summary"]["links_with_full_cavity_clearance_verified"] == 26
    assert report["summary"]["links_with_supplier_vendor_keepout_growth"] == 8
    assert report["summary"]["links_with_supplier_vendor_adjusted_bbox_fit"] == 8
    assert report["summary"]["supplier_vendor_adjusted_fit_fail"] == 0
    assert report["summary"]["supplier_vendor_adjusted_max_residual_extent_growth_m"] == 0.0
    assert (
        report["summary"]["supplier_vendor_max_required_extent_growth_m"]
        == 0.0264997322031618
    )

    links = {record["link"]: record for record in report["links"]}
    imu = links["IMU_ORIGIN"]
    assert imu["parameter_count"] == 3
    assert imu["constraint_count"] == 8
    assert {parameter["name"] for parameter in imu["parameters"]} == {
        "x_extent_m",
        "y_extent_m",
        "z_extent_m",
    }
    assert all(parameter["proofs"] for parameter in imu["parameters"])
    assert any(not parameter["verified"] for parameter in imu["parameters"])
    assert "internal_cavity_keepout" in imu["active_thinness_limiters"]
    assert {
        constraint["name"] for constraint in imu["constraints"]
    } >= {
        "z_height_preservation",
        "keepout_clearance_adjusted",
        "wall_or_plate_thickness",
        "surface_intent",
        "topology_or_repair_preview",
        "internal_cavity_clearance",
        "full_cavity_clearance_candidate",
        "mold_draft_or_vacuform_process",
    }

    left_knee = links["LEFT_KNEE"]
    assert "supplier_vendor_keepout" in left_knee["active_thinness_limiters"]
    supplier_constraint = next(
        constraint
        for constraint in left_knee["constraints"]
        if constraint["name"] == "supplier_vendor_keepout_growth"
    )
    assert supplier_constraint["verified"] is True
    assert (
        supplier_constraint["value"]["max_required_extent_growth_m"]
        == 0.0264997322031618
    )
    assert supplier_constraint["value"]["fit_fail_count"] == 5
    assert supplier_constraint["value"]["supplier_vendor_adjusted_fit_check_count"] == 5
    assert supplier_constraint["value"]["supplier_vendor_adjusted_fit_pass_count"] == 5
    assert supplier_constraint["value"]["supplier_vendor_adjusted_fit_fail_count"] == 0
    assert (
        supplier_constraint["value"][
            "supplier_vendor_adjusted_max_residual_extent_growth_m"
        ]
        == 0.0
    )
    assert supplier_constraint["value"]["supplier_vendor_adjusted_step_sha256"]

    left_toe = links["LEFT_TOE"]
    assert left_toe["surface_intent"] == "flat"
    assert left_toe["constraint_count"] == 6
    assert "mold_draft_or_vacuform_process" not in {
        constraint["name"] for constraint in left_toe["constraints"]
    }
    assert "supplier_vendor_keepout_growth" not in {
        constraint["name"] for constraint in left_toe["constraints"]
    }


def test_fembot_inventory_surfaces_parametric_constraints_status() -> None:
    report = collect_fembot_inventory()

    assert report["parametric_constraints"]["ok"] is True
    assert report["parametric_constraints"]["accepted"] is False
    assert report["parametric_constraints"]["summary"]["links"] == 28
    assert report["parametric_constraints"]["summary"]["parameters"] == 84
    assert (
        report["parametric_constraints"]["summary"][
            "links_with_keepout_adjusted_clearance"
        ]
        == 28
    )
    assert (
        report["parametric_constraints"]["summary"][
            "links_with_supplier_vendor_keepout_growth"
        ]
        == 0
    )
    assert (
        report["parametric_constraints"]["summary"][
            "links_with_supplier_vendor_adjusted_bbox_fit"
        ]
        == 0
    )
    assert (
        report["parametric_constraints"]["summary"][
            "links_with_promoted_topology_accepted"
        ]
        == 28
    )
    assert (
        report["parametric_constraints"]["summary"][
            "links_with_full_cavity_clearance_verified"
        ]
        == 26
    )
    assert report["parametric_constraints"]["summary"]["supplier_vendor_adjusted_fit_fail"] == 0


def test_fembot_parametric_constraints_cli_writes_gateable_proof(tmp_path) -> None:
    output = tmp_path / "fembot-parametric-constraints.json"
    proc = subprocess.run(
        [
            sys.executable,
            "scripts/generate_asimov_fembot_parametric_constraints_proof.py",
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
    assert report["schema"] == "asimov-fembot-parametric-constraints-v1"
    assert report["ok"] is True
    assert report["accepted"] is False
    assert proc.returncode == 2
    assert '"accepted": false' in proc.stdout
