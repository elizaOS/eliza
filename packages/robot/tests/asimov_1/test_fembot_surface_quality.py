from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from eliza_robot.asimov_1.fembot_inventory import collect_fembot_inventory
from eliza_robot.asimov_1.fembot_surface_quality import (
    build_fembot_surface_quality_proof,
    measure_surface_quality_for_stl,
)


def test_fembot_surface_quality_measures_source_stl_geometry() -> None:
    inventory = collect_fembot_inventory()
    report = build_fembot_surface_quality_proof(inventory["body_groups"])

    assert report["schema"] == "asimov-fembot-surface-quality-proof-v1"
    assert report["ok"] is True
    assert report["accepted"] is False
    assert report["summary"]["measured_links"] == 28
    assert report["summary"]["missing_links"] == []
    assert report["summary"]["generated_reference_links"] == 28
    assert report["summary"]["generated_missing_links"] == []
    assert report["summary"]["generated_flat_plate_surfaces"] == 2
    assert report["summary"]["generated_smooth_loft_surfaces"] == 26
    assert report["summary"]["generated_surface_check_failures"] == 0
    assert report["summary"]["generated_flatness_tolerance_m"] == 1.0e-6
    assert report["summary"]["max_largest_patch_flatness_error_m"] is not None
    assert report["summary"]["max_adjacent_normal_angle_rad"] is not None

    groups = {group["group"]: group for group in report["body_groups"]}
    assert groups["torso"]["surface_count"] == 2
    assert groups["head"]["surface_count"] == 2
    assert groups["arm"]["surface_count"] == 10
    assert groups["leg"]["surface_count"] == 12
    assert groups["foot"]["surface_count"] == 2
    generated_groups = {group["group"]: group for group in report["generated_body_groups"]}
    assert generated_groups["foot"]["surfaces"][0]["surface_class"] == (
        "generated-flat-plate-reference"
    )
    assert generated_groups["foot"]["surfaces"][0]["flatness_error_m"] == 0.0
    assert generated_groups["arm"]["surfaces"][0]["surface_class"] == (
        "generated-smooth-loft-reference"
    )
    assert generated_groups["arm"]["surfaces"][0]["generated_surface_check_ok"] is True

    first_surface = groups["arm"]["surfaces"][0]
    assert first_surface["triangle_count"] > 0
    assert first_surface["area_m2"] > 0.0
    assert first_surface["surface_class"] in {
        "flat-dominant-source-mesh",
        "smooth-or-complex-source-mesh",
    }
    assert first_surface["accepted"] is False


def test_fembot_inventory_surfaces_flatness_smoothness_status() -> None:
    report = collect_fembot_inventory()

    assert report["surface_quality"]["ok"] is True
    assert report["surface_quality"]["accepted"] is False
    assert report["surface_quality"]["summary"]["measured_links"] == 28
    assert report["surface_quality"]["summary"]["generated_reference_links"] == 28
    assert report["surface_quality"]["summary"]["generated_surface_check_failures"] == 0
    for group in report["body_groups"]:
        assert "flatness_or_smoothness" in group["missing_proofs"]


def test_measure_surface_quality_for_single_stl_has_contract_fields() -> None:
    inventory = collect_fembot_inventory()
    report = measure_surface_quality_for_stl(
        Path(inventory["source"]["mesh_dir"]) / "LEFT_ELBOW.STL"
    )

    assert report["part_id"] == "LEFT_ELBOW"
    assert report["surface_id"] == "LEFT_ELBOW:source-stl"
    assert report["flatness_error_m"] is not None
    assert report["curvature_discontinuity_max"] is not None
    assert report["normal_deviation_max_rad"] is not None
    assert report["accepted"] is False


def test_fembot_surface_quality_cli_writes_gateable_proof(tmp_path) -> None:
    output = tmp_path / "surface-quality.json"
    proc = subprocess.run(
        [
            sys.executable,
            "scripts/generate_asimov_fembot_surface_quality_proof.py",
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
    assert report["schema"] == "asimov-fembot-surface-quality-proof-v1"
    assert proc.returncode == (0 if report["accepted"] else 2)
    assert '"accepted": false' in proc.stdout
