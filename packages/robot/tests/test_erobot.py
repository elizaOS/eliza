"""Tests for the from-scratch erobot humanoid.

Builds every artifact once (spec -> MJCF/URDF/profile/BOM/proofs) and asserts the
robot loads and steps in MuJoCo, the profile validates against the canonical
schema, and every engineering proof passes.
"""

from __future__ import annotations

import numpy as np
import pytest

from eliza_robot.erobot import build as erobot_build
from eliza_robot.erobot.mass import compute_budget
from eliza_robot.erobot.spec import build_spec
from eliza_robot.profiles.schema import RobotProfile, load_profile


@pytest.fixture(scope="module")
def built() -> dict:
    return erobot_build.build_all()


def test_spec_is_full_size_25dof() -> None:
    spec = build_spec()
    assert spec.dof == 25
    assert spec.profile_id == "erobot"
    # full-size humanoid in the 1.5-1.9 m band
    assert 1.5 <= spec.standing_height_m <= 1.9
    # contiguous joint indices, unique names
    idx = sorted(j.index for j in spec.joints)
    assert idx == list(range(25))
    assert len({j.name for j in spec.joints}) == 25


def test_mass_budget_is_lightweight() -> None:
    budget = compute_budget()
    # thin-shell plastic full-size humanoid: meaningfully lighter than steel peers
    assert 20.0 <= budget.total_mass_kg <= 35.0
    # structure is mostly plastic shell + off-the-shelf actuators
    assert budget.shell_mass_kg > 0
    assert budget.actuator_mass_kg > budget.shell_mass_kg


def test_profile_validates_against_schema(built: dict) -> None:
    prof = load_profile("erobot")
    assert isinstance(prof, RobotProfile)
    assert prof.id == "erobot"
    assert prof.kinematics.dof == 25
    assert prof.gait.controller == "rl"
    # every joint has a positive torque + velocity limit
    for j in prof.kinematics.joints:
        assert j.actuator_torque_nm > 0
        assert j.velocity_max_rad_s > 0


def test_mjcf_loads_steps_and_stands(built: dict) -> None:
    import mujoco

    scene = built["artifacts"]["scene"]
    model = mujoco.MjModel.from_xml_path(scene)
    data = mujoco.MjData(model)
    mujoco.mj_resetDataKeyframe(model, data, 0)
    for _ in range(1000):
        mujoco.mj_step(model, data)
    assert np.isfinite(data.qpos).all()
    assert np.isfinite(data.qvel).all()
    # still standing (did not collapse)
    assert data.qpos[2] > 0.7
    # mass matches the analytic model
    assert abs(float(sum(model.body_mass)) - built["spec"]["total_mass_kg"]) < 0.1


def test_urdf_is_wellformed(built: dict) -> None:
    import xml.etree.ElementTree as ET

    root = ET.parse(built["artifacts"]["urdf"]).getroot()
    assert root.tag == "robot"
    assert len(root.findall("link")) == 26
    assert len(root.findall("joint")) == 25


def test_all_proofs_pass(built: dict) -> None:
    assert built["ok"], built["proofs_ok"]
    for name, ok in built["proofs_ok"].items():
        assert ok, f"proof {name} failed"


def test_bom_is_sane(built: dict) -> None:
    totals = built["bom_totals"]
    # off-the-shelf actuator-dominated humanoid in a believable price band
    assert 5_000 < totals["cost_qty1_usd"] < 50_000
    assert totals["cost_qty1000_usd_per_unit"] < totals["cost_qty1_usd"]
    assert totals["unique_molds"] > 0
    # BOM mass >= sim mass model (extra discrete hardware)
    assert totals["bom_mass_kg"] >= totals["mass_model_total_kg"] - 0.01
