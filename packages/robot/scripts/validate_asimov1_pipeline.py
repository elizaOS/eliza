#!/usr/bin/env python3
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from eliza_robot.asimov_1.cad import validate_cad_tree  # noqa: E402
from eliza_robot.asimov_1.mujoco_assets import generate_asimov1_mjcf  # noqa: E402
from eliza_robot.asimov_1.source_inventory import collect_asimov1_source_inventory  # noqa: E402
from eliza_robot.profiles.schema import load_profile  # noqa: E402
from eliza_robot.sim.mujoco.asimov_training import default_asimov_training_contract  # noqa: E402


def validate_pipeline() -> dict:
    import mujoco

    mjcf = generate_asimov1_mjcf()
    model = mujoco.MjModel.from_xml_path(str(mjcf))
    profile = load_profile("asimov-1")
    contract = default_asimov_training_contract()
    cad = validate_cad_tree()
    report = {
        "ok": int(model.nu) == 25 and profile.kinematics.dof == 25 and cad.ok,
        "profile_id": "asimov-1",
        "source_inventory": collect_asimov1_source_inventory(),
        "cad_entries": cad.cad_entries,
        "subassemblies": cad.subassemblies,
        "mjcf": str(mjcf),
        "mjcf_nq": int(model.nq),
        "mjcf_nv": int(model.nv),
        "mjcf_nu": int(model.nu),
        "training_action_dim": contract.leg_action_dim,
        "training_observation_dim": contract.actor_observation_dim,
        "gym_observation_dim": contract.actor_observation_dim + 8,
        "gym_action_dim": contract.leg_action_dim,
    }
    return report


if __name__ == "__main__":
    report = validate_pipeline()
    print(json.dumps(report, indent=2))
    raise SystemExit(0 if report["ok"] else 2)
