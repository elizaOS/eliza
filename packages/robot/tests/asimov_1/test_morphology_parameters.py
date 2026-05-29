from __future__ import annotations

import subprocess
import sys

from eliza_robot.asimov_1.morphology_parameters import morphology_parameter_catalog


def test_morphology_parameter_catalog_defines_core_shape_controls() -> None:
    catalog = morphology_parameter_catalog()

    assert catalog["schema"] == "asimov-1-morphology-parameter-catalog-v1"
    assert catalog["parameter_count"] >= 8
    assert {"lean", "torso", "pelvis", "hips", "legs", "arms"}.issubset(
        set(catalog["groups"])
    )
    assert set(catalog["required_proof_types"]) == {
        "spline_fit",
        "interface_preservation",
        "topology",
        "surface_distance",
        "mujoco_load",
    }

    by_name = {param["name"]: param for param in catalog["parameters"]}
    for required in (
        "global_shell_scale",
        "hip_spacing_scale",
        "bust_front_gain",
        "back_arch_shift_m",
        "calf_back_bulge",
        "arm_slim_taper",
    ):
        assert required in by_name
        param = by_name[required]
        assert param["minimum"] <= param["default"] <= param["maximum"]
        assert param["affected_links"]
        assert param["proof_requirements"] == catalog["required_proof_types"]

    assert "WAIST_YAW" in by_name["bust_front_gain"]["affected_links"]
    assert "IMU_ORIGIN" in by_name["hip_spacing_scale"]["affected_links"]


def test_morphology_parameter_catalog_cli_outputs_json() -> None:
    proc = subprocess.run(
        [sys.executable, "scripts/inventory_asimov1_morphology_parameters.py"],
        cwd=".",
        text=True,
        capture_output=True,
        check=False,
    )

    assert proc.returncode == 0
    assert '"schema": "asimov-1-morphology-parameter-catalog-v1"' in proc.stdout
    assert '"bust_front_gain"' in proc.stdout
