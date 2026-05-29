from __future__ import annotations

import json
import subprocess
import sys

from eliza_robot.asimov_1.fembot_inventory import collect_fembot_inventory
from eliza_robot.asimov_1.fembot_materials import build_fembot_material_manufacturing_proof


def test_fembot_material_manufacturing_proof_classifies_source_candidates() -> None:
    inventory = collect_fembot_inventory()
    report = build_fembot_material_manufacturing_proof(inventory["body_groups"])

    assert report["schema"] == "asimov-fembot-material-manufacturing-proof-v1"
    assert report["ok"] is True
    assert report["accepted"] is False
    assert report["summary"]["fabrication_candidates"] > 0
    assert report["summary"]["unknown_candidate_count"] == 0
    assert report["summary"]["generated_part_records"] == 28
    assert report["summary"]["generated_material_class_counts"] == {
        "ALU_7075": 2,
        "MJF_PA12": 26,
    }
    assert report["summary"]["generated_mass_estimate_kg"] > 0.0
    assert report["summary"]["generated_geometry_measurement_parts"] == 28
    assert report["summary"]["generated_geometry_measurement_missing_parts"] == 0
    assert report["summary"]["generated_preliminary_mass_property_parts"] == 28
    assert report["summary"]["generated_preliminary_mass_property_missing_parts"] == 0
    assert report["summary"]["generated_wall_thickness_failures"] == 2
    assert report["summary"]["generated_adjusted_wall_thickness_failures"] == 0
    assert report["summary"]["generated_adjusted_wall_thickness_ready_parts"] == 28
    assert report["summary"]["generated_draft_review_pending_parts"] == 26
    assert report["summary"]["production_material_selection_pending_parts"] == 28
    assert report["summary"]["production_tolerance_drawing_pending_parts"] == 28
    assert report["summary"]["production_inspection_pending_parts"] == 28
    assert report["summary"]["material_properties_accepted"] is False
    assert report["summary"]["manufacturing_process_accepted"] is False
    assert "generated geometry" in report["summary"]["acceptance_blocker"]
    assert "measured hardware mass/inertia" in report["summary"]["acceptance_blocker"]

    groups = {group["group"]: group for group in report["body_groups"]}
    assert groups["arm"]["fabrication_class_counts"]["ALU_7075"] > 0
    assert groups["leg"]["fabrication_class_counts"]["MJF_PA12"] > 0
    assert groups["torso"]["fabrication_class_counts"]["OFF_THE_SHELF"] > 0

    pa12 = groups["leg"]["material_records"]["MJF_PA12"]
    assert pa12["density_kg_m3"] > 0
    assert pa12["allowable_stress_pa"] > 0
    assert "vendor" in pa12["source"]

    mjf = groups["leg"]["manufacturing_records"]["MJF_PA12"]
    assert mjf["requires_smoothness_check"] is True
    assert mjf["minimum_wall_thickness_m"] > 0

    parts = {part["part_id"]: part for part in report["generated_parts"]}
    assert parts["LEFT_TOE"]["material_class"] == "ALU_7075"
    assert parts["LEFT_TOE"]["wall_thickness_ok"] is False
    assert parts["LEFT_TOE"]["manufacturing_adjusted_wall_thickness_ok"] is True
    assert parts["LEFT_TOE"]["geometry_measurements_present"] is True
    assert parts["LEFT_TOE"]["preliminary_mass_properties_present"] is True
    assert parts["LEFT_TOE"]["mass_estimate_kg"] > 0.0
    assert parts["NECK_PITCH"]["material_class"] == "MJF_PA12"
    assert parts["NECK_PITCH"]["requires_draft_review"] is True


def test_fembot_inventory_surfaces_material_manufacturing_status() -> None:
    report = collect_fembot_inventory()

    assert report["material_manufacturing"]["ok"] is True
    assert report["material_manufacturing"]["accepted"] is False
    assert report["material_manufacturing"]["summary"]["classification_ok"] is True
    assert report["material_manufacturing"]["summary"]["generated_part_records"] == 28
    assert (
        report["material_manufacturing"]["summary"][
            "generated_geometry_measurement_missing_parts"
        ]
        == 0
    )
    assert (
        report["material_manufacturing"]["summary"][
            "generated_adjusted_wall_thickness_failures"
        ]
        == 0
    )
    for group in report["body_groups"]:
        assert "material_properties" in group["missing_proofs"]
        assert "manufacturing_process" in group["missing_proofs"]


def test_fembot_material_manufacturing_cli_writes_gateable_proof(tmp_path) -> None:
    output = tmp_path / "material-manufacturing.json"
    proc = subprocess.run(
        [
            sys.executable,
            "scripts/generate_asimov_fembot_material_manufacturing_proof.py",
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
    assert report["schema"] == "asimov-fembot-material-manufacturing-proof-v1"
    assert proc.returncode == (0 if report["accepted"] else 2)
    assert '"accepted": false' in proc.stdout
