from __future__ import annotations

import json
import subprocess
import sys

from eliza_robot.asimov_1.morphology_effects import build_morphology_effect_proof


def test_morphology_effect_proof_separates_measured_effects_from_catalog_intent() -> None:
    report = build_morphology_effect_proof()

    assert report["schema"] == "asimov-1-morphology-effect-proof-v1"
    assert report["ok"] is True
    assert report["accepted"] is True
    assert report["summary"]["parameters"] == 8
    assert report["summary"]["accepted_parameters"] == 8
    assert report["summary"]["blocked_parameters"] == 0
    assert report["summary"]["affected_links"] >= 20

    by_name = {record["name"]: record for record in report["parameters"]}
    assert by_name["global_shell_scale"]["accepted"] is True
    assert by_name["global_shell_scale"]["metrics"]["slimmed_link_count"] >= 8
    assert by_name["upper_thigh_hip_flare"]["accepted"] is True
    assert by_name["upper_thigh_hip_flare"]["metrics"]["median_non_spine_area_ratio"] > 1.05
    assert by_name["arm_slim_taper"]["accepted"] is True
    assert by_name["arm_slim_taper"]["metrics"]["median_non_spine_area_ratio"] < 0.94
    assert by_name["calf_back_bulge"]["accepted"] is True
    assert by_name["calf_back_bulge"]["metrics"]["median_mid_calf_x_min_delta_m"] < -0.005
    assert by_name["bust_front_gain"]["accepted"] is True
    assert by_name["bust_front_gain"]["metrics"]["bust_band_x_max_delta_m"] > 0.01
    assert by_name["back_arch_shift_m"]["accepted"] is True
    assert by_name["back_arch_shift_m"]["metrics"]["mid_torso_x_center_delta_m"] < -0.008

    assert by_name["torso_waist_cinch_depth"]["accepted"] is True
    assert (
        by_name["torso_waist_cinch_depth"]["metrics"]["median_waist_section_area_ratio"]
        < 0.95
    )
    assert by_name["hip_spacing_scale"]["accepted"] is True
    assert by_name["hip_spacing_scale"]["metrics"]["fembot_mjcf_ok"] is True
    assert by_name["hip_spacing_scale"]["metrics"]["hip_spacing_ratio"] < 0.98


def test_morphology_effect_cli_writes_gateable_proof(tmp_path) -> None:
    output = tmp_path / "morphology-effects.json"
    proc = subprocess.run(
        [
            sys.executable,
            "scripts/generate_asimov1_morphology_effects.py",
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
    assert report["schema"] == "asimov-1-morphology-effect-proof-v1"
    assert report["ok"] is True
    assert report["accepted"] is True
    assert proc.returncode == 0
    assert '"accepted_parameters": 8' in proc.stdout
