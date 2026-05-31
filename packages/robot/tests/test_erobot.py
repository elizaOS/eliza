"""Tests for the from-scratch erobot humanoid.

Builds every artifact + proof once (spec -> MJCF/URDF/profile/BOM -> manifold,
internal-fit/collision, mate, mechanical, and MuJoCo physical proofs) and
asserts the robot loads/steps/stands in MuJoCo, the profile validates against
the canonical schema, every part is a manifold solid with its internals housed
and collision-free, the cable-pulley toes articulate, and every load path keeps
a safety factor above 2.
"""

from __future__ import annotations

import numpy as np
import pytest

from eliza_robot.erobot import analysis, assembly
from eliza_robot.erobot import build as erobot_build
from eliza_robot.erobot.mass import compute_budget
from eliza_robot.erobot.spec import build_spec
from eliza_robot.profiles.schema import RobotProfile, load_profile


@pytest.fixture(scope="module")
def built() -> dict:
    return erobot_build.build_all(visual=False)


def test_spec_is_full_size_humanoid() -> None:
    spec = build_spec()
    assert spec.dof == 27  # 25 direct joints + 2 tendon-driven toes
    assert spec.profile_id == "erobot"
    assert 1.5 <= spec.standing_height_m <= 1.9
    idx = sorted(j.index for j in spec.joints)
    assert idx == list(range(27))
    assert len({j.name for j in spec.joints}) == 27
    assert sum(j.tendon_driven for j in spec.joints) == 2  # the toes


def test_mass_budget_is_lightweight() -> None:
    budget = compute_budget()
    assert 20.0 <= budget.total_mass_kg <= 35.0
    assert budget.actuator_mass_kg > budget.shell_mass_kg


def test_profile_validates_against_schema(built: dict) -> None:
    prof = load_profile("erobot")
    assert isinstance(prof, RobotProfile)
    assert prof.kinematics.dof == 27
    assert prof.gait.controller == "rl"
    for j in prof.kinematics.joints:
        assert j.actuator_torque_nm > 0 and j.velocity_max_rad_s > 0


def test_mjcf_loads_steps_and_stands(built: dict) -> None:
    import mujoco

    model = mujoco.MjModel.from_xml_path(built["artifacts"]["scene"])
    data = mujoco.MjData(model)
    mujoco.mj_resetDataKeyframe(model, data, 0)
    for _ in range(1000):
        mujoco.mj_step(model, data)
    assert np.isfinite(data.qpos).all() and np.isfinite(data.qvel).all()
    assert data.qpos[2] > 0.7  # still standing
    assert abs(float(sum(model.body_mass)) - built["spec"]["total_mass_kg"]) < 0.1
    assert model.ntendon == 2  # toe cable drives


def test_urdf_is_wellformed(built: dict) -> None:
    import xml.etree.ElementTree as ET

    root = ET.parse(built["artifacts"]["urdf"]).getroot()
    assert len(root.findall("link")) == 28
    assert len(root.findall("joint")) == 27


def test_all_proofs_pass(built: dict) -> None:
    assert built["ok"], built["proofs_ok"]
    for name in ("manifold", "internal-collision", "mate-verification",
                 "mechanical-analysis", "transmission", "mujoco-load",
                 "tendon-actuation", "joint-sweep", "range-of-motion",
                 "rom-requirements", "mass-reconciliation", "structural-sanity"):
        assert built["proofs_ok"][name], f"proof {name} failed"


def _proof(name: str) -> dict:
    import json
    from pathlib import Path

    root = Path(__file__).resolve().parents[1] / "cad" / "erobot" / "proofs"
    return json.loads((root / f"{name}.json").read_text())


def test_motor_controls_foot_position_through_pulley(built: dict) -> None:
    t = _proof("transmission")
    assert t["ok"]
    toe = t["toe_position_control"]
    assert toe["monotonic"]                          # command -> position is a function
    assert toe["repeatable_hysteresis_deg"] < 2.0    # near-zero backlash
    assert toe["toe_tip_travel_mm"] > 10.0           # the foot tip actually moves
    mech = t["pulley_belt_mechanics"]
    assert mech["cable_safety_factor"] >= 2.0
    assert mech["backlash_deg"] == 0.0               # positive anchored cable
    foot = t["foot_position_by_leg_motors"]
    assert foot["knee_moves_foot_height_m"] > 0.1    # leg motor positions the foot


def test_rom_requirements_met(built: dict) -> None:
    r = _proof("rom-requirements")
    assert r["ok"], r["failures"]
    by_type = {row["type"]: row for row in r["joints"]}
    assert by_type["knee"]["achieved_deg"] >= 115.0          # full knee flexion
    assert by_type["hip_pitch"]["achieved_deg"] >= 100.0     # hip flexion/extension
    assert by_type["toe"]["achieved_deg"] >= 15.0            # cable-driven toe


def test_every_part_is_manifold() -> None:
    mp = assembly.manifold_proof()
    assert mp["non_manifold_parts"] == []
    assert mp["shell_mass_reconciliation_failures"] == []
    assert mp["parts_checked"] >= 70


def test_internals_housed_and_collision_free() -> None:
    ip = assembly.internal_proof()
    assert ip["fit_failures"] == []
    assert ip["internal_collisions"] == []
    assert ip["min_contained_fraction"] >= 0.98


def test_mechanical_safety_factors() -> None:
    a = analysis.mechanical_analysis()
    assert a["ok"]
    assert a["min_safety_factor"] >= 2.0


def test_bom_is_sane(built: dict) -> None:
    totals = built["bom_totals"]
    assert 5_000 < totals["cost_qty1_usd"] < 60_000
    assert totals["cost_qty1000_usd_per_unit"] < totals["cost_qty1_usd"]
    assert totals["bom_mass_kg"] >= totals["mass_model_total_kg"] - 0.01
