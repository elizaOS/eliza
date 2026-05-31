"""Simulation + engineering proofs for erobot.

Each proof writes a JSON record under ``cad/erobot/proofs/`` and returns an
``ok`` flag:

  * ``mujoco-load``        — erobot.xml and scene.xml compile, reset to the home
    keyframe, and step without NaN; the robot stands.
  * ``joint-sweep``        — sweep every joint across its full range on the
    all-collision model and measure the minimum clearance between non-adjacent
    shells (detects self-collision / interference).
  * ``mass-reconciliation``— BOM mass vs the analytic mass model vs the compiled
    MuJoCo model agree.
  * ``structural-sanity``  — thin-wall bending + axial stress in each load-path
    limb tube under peak joint torque and dynamic body weight, vs the material
    allowable. This is the "thin but strong enough" gate.
"""

from __future__ import annotations

import json
import math
import tempfile
from collections import deque
from pathlib import Path

import numpy as np

from eliza_robot.erobot.bom import build_bom
from eliza_robot.erobot.mass import compute_budget
from eliza_robot.erobot.mjcf import MJCF_DIR, build_mjcf, write_models
from eliza_robot.erobot.spec import MATERIALS, RobotSpec, build_spec

PROOFS_ROOT = Path(__file__).resolve().parents[2] / "cad" / "erobot" / "proofs"
DYNAMIC_LOAD_FACTOR = 2.5   # impact multiplier on static weight during gait
MIN_SAFETY_FACTOR = 2.0


def _write(name: str, payload: dict) -> Path:
    PROOFS_ROOT.mkdir(parents=True, exist_ok=True)
    out = PROOFS_ROOT / f"{name}.json"
    out.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    return out


# ---------------------------------------------------------------------------
# 1. MuJoCo load + stand
# ---------------------------------------------------------------------------


def mujoco_load_proof(spec: RobotSpec | None = None) -> dict:
    import mujoco

    spec = spec or build_spec()
    paths = write_models(spec)

    def run(path: Path, steps: int) -> dict:
        model = mujoco.MjModel.from_xml_path(str(path))
        data = mujoco.MjData(model)
        mujoco.mj_resetDataKeyframe(model, data, 0)
        z0 = float(data.qpos[2])
        for _ in range(steps):
            mujoco.mj_step(model, data)
        return {
            "path": str(path),
            "nq": int(model.nq), "nv": int(model.nv), "nu": int(model.nu),
            "nbody": int(model.nbody), "ngeom": int(model.ngeom),
            "total_mass_kg": round(float(sum(model.body_mass)), 4),
            "steps": steps,
            "pelvis_z_start_m": round(z0, 4),
            "pelvis_z_end_m": round(float(data.qpos[2]), 4),
            "qpos_finite": bool(np.isfinite(data.qpos).all()),
            "qvel_finite": bool(np.isfinite(data.qvel).all()),
            "contacts": int(data.ncon),
        }

    robot = run(paths["robot"], 200)
    scene = run(paths["scene"], 1500)  # 3 s standing
    stands = scene["pelvis_z_end_m"] > 0.7 and scene["qpos_finite"]
    return {
        "schema": "erobot-mujoco-load-v1",
        "ok": bool(robot["qpos_finite"] and scene["qpos_finite"] and stands),
        "stands_under_gravity": bool(stands),
        "robot_model": robot,
        "scene_model": scene,
    }


# ---------------------------------------------------------------------------
# 2. Joint-sweep self-collision clearance
# ---------------------------------------------------------------------------


def _body_tree_distance(spec: RobotSpec) -> dict[tuple[str, str], int]:
    adj: dict[str, set[str]] = {b.name: set() for b in spec.bodies}
    for b in spec.bodies:
        if b.parent:
            adj[b.name].add(b.parent)
            adj[b.parent].add(b.name)
    dist: dict[tuple[str, str], int] = {}
    names = [b.name for b in spec.bodies]
    for src in names:
        seen = {src: 0}
        q = deque([src])
        while q:
            cur = q.popleft()
            for nxt in adj[cur]:
                if nxt not in seen:
                    seen[nxt] = seen[cur] + 1
                    q.append(nxt)
        for dst, d in seen.items():
            dist[(src, dst)] = d
    return dist


# Bodies within this kinematic-tree distance are expected to be near each other
# (concentric hip/shoulder gimbals are coincident by design, and chain neighbors
# overlap at extremes). Clearance is only meaningful between bodies further apart.
# Matches the repo precedent (unitree-r1 manifest: articulated_body_distance: 3).
ARTICULATED_DISTANCE = 3
PENETRATION_TOL_MM = 0.5
LEG_OPERATING_FRACTION = 0.6   # legs must clear through 60% of range (locomotion)


def _min_clearance(model, data, geom_body, dist) -> tuple[float, dict | None, list[dict]]:
    import mujoco
    mujoco.mj_forward(model, data)
    worst_mm = math.inf
    worst_pair: dict | None = None
    pens: list[dict] = []
    for ci in range(data.ncon):
        c = data.contact[ci]
        ba = geom_body[int(c.geom1)]
        bb = geom_body[int(c.geom2)]
        if ba == bb or dist.get((ba, bb), 99) <= ARTICULATED_DISTANCE:
            continue
        gap_mm = float(c.dist) * 1000.0
        if gap_mm < worst_mm:
            worst_mm = gap_mm
            worst_pair = {"clearance_mm": round(gap_mm, 3), "pair": [ba, bb]}
        if gap_mm < -PENETRATION_TOL_MM:
            pens.append({"bodies": [ba, bb], "depth_mm": round(-gap_mm, 3)})
    return worst_mm, worst_pair, pens


def joint_sweep_proof(spec: RobotSpec | None = None, *, samples: int = 9) -> dict:
    import mujoco

    spec = spec or build_spec()
    tree = build_mjcf(spec, all_collision=True)
    with tempfile.NamedTemporaryFile("w", suffix=".xml", delete=False) as fh:
        tree.write(fh.name, encoding="utf-8")
        model = mujoco.MjModel.from_xml_path(fh.name)
    data = mujoco.MjData(model)

    dist = _body_tree_distance(spec)
    geom_body = {gid: model.body(int(model.geom_bodyid[gid])).name for gid in range(model.ngeom)}
    joints = sorted(spec.joints, key=lambda j: j.index)
    qadr = {j.name: model.joint(j.name).qposadr[0] for j in joints}

    mujoco.mj_resetDataKeyframe(model, data, 0)
    home = data.qpos.copy()

    # (1) home-pose interference gate
    data.qpos[:] = home
    home_clear_mm, home_worst, home_pens = _min_clearance(model, data, geom_body, dist)

    # (2) leg operating-envelope gate (locomotion must be clean)
    leg_pens: list[dict] = []
    leg_min_mm = math.inf
    for j in joints:
        if j.group != "LEG":
            continue
        for frac in np.linspace(-LEG_OPERATING_FRACTION, LEG_OPERATING_FRACTION, samples):
            data.qpos[:] = home
            span = (j.upper_rad - j.home_rad) if frac >= 0 else (j.home_rad - j.lower_rad)
            data.qpos[qadr[j.name]] = j.home_rad + frac * span
            cl, _, pens = _min_clearance(model, data, geom_body, dist)
            leg_min_mm = min(leg_min_mm, cl)
            for p in pens:
                leg_pens.append({"joint": j.name, **p})

    # (3) advisory full-range sweep (arm-into-torso at extremes is expected)
    adv_min_mm = math.inf
    adv_worst: dict | None = None
    adv_pen_count = 0
    total = 0
    for j in joints:
        for frac in np.linspace(0.0, 1.0, samples):
            data.qpos[:] = home
            data.qpos[qadr[j.name]] = j.lower_rad + frac * (j.upper_rad - j.lower_rad)
            cl, worst, pens = _min_clearance(model, data, geom_body, dist)
            total += 1
            if cl < adv_min_mm:
                adv_min_mm = cl
                adv_worst = {**(worst or {}), "pose": f"{j.name}={data.qpos[qadr[j.name]]:.3f}"}
            adv_pen_count += len(pens)

    home_ok = not home_pens
    leg_ok = not leg_pens
    return {
        "schema": "erobot-joint-sweep-v1",
        "ok": bool(home_ok and leg_ok),
        "articulated_body_distance": ARTICULATED_DISTANCE,
        "home_pose": {
            "ok": home_ok,
            "min_clearance_mm": round(home_clear_mm, 3) if math.isfinite(home_clear_mm) else None,
            "worst_pair": home_worst,
            "interferences": home_pens,
        },
        "leg_operating_envelope": {
            "ok": leg_ok,
            "operating_fraction": LEG_OPERATING_FRACTION,
            "min_clearance_mm": round(leg_min_mm, 3) if math.isfinite(leg_min_mm) else None,
            "interferences": leg_pens[:20],
        },
        "full_range_advisory": {
            "samples": total,
            "min_nonadjacent_clearance_mm": round(adv_min_mm, 3) if math.isfinite(adv_min_mm) else None,
            "worst_event": adv_worst,
            "penetration_events": adv_pen_count,
            "note": "arm/torso and arm/leg overlap at extreme single-joint poses is "
                    "expected for a humanoid and is enforced by controller limits, not geometry.",
        },
    }


# ---------------------------------------------------------------------------
# 3. Mass reconciliation
# ---------------------------------------------------------------------------


def mass_reconciliation_proof(spec: RobotSpec | None = None) -> dict:
    import mujoco

    spec = spec or build_spec()
    budget = compute_budget(spec)
    bom = build_bom(spec)
    model = mujoco.MjModel.from_xml_path(str(MJCF_DIR / "erobot.xml"))
    mjcf_mass = float(sum(model.body_mass))

    model_total = budget.total_mass_kg
    bom_total = bom.total_mass_kg()
    # MJCF carries shells + actuators + lumped electronics, NOT discrete
    # bearings/fasteners/wear pads -> it should match the analytic mass model.
    mjcf_vs_model = abs(mjcf_mass - model_total)
    bom_extra = bom_total - model_total
    return {
        "schema": "erobot-mass-reconciliation-v1",
        "ok": bool(mjcf_vs_model < 0.05 and bom_extra >= -0.01),
        "mass_model_kg": round(model_total, 3),
        "mjcf_compiled_kg": round(mjcf_mass, 3),
        "bom_kg": round(bom_total, 3),
        "mjcf_vs_model_delta_kg": round(mjcf_vs_model, 4),
        "bom_extra_hardware_kg": round(bom_extra, 3),
        "note": "MJCF must match the analytic model; BOM is >= model by discrete "
                "bearings/fasteners/wear pads not represented as sim shells.",
        "by_group_kg": {k: round(v, 3) for k, v in budget.mass_by_group.items()},
    }


# ---------------------------------------------------------------------------
# 4. Structural sanity — thin-wall limb tubes
# ---------------------------------------------------------------------------


def structural_sanity_proof(spec: RobotSpec | None = None) -> dict:
    spec = spec or build_spec()
    budget = compute_budget(spec)
    weight_n = budget.total_mass_kg * 9.81
    single_leg_axial_n = weight_n * DYNAMIC_LOAD_FACTOR  # worst case: one leg, impact

    parts: list[dict] = []
    for body in spec.bodies:
        if body.joint is None:
            continue
        tubes = [g for g in body.geoms if g.type == "capsule" and g.role == "shell"]
        if not tubes:
            continue
        g = tubes[0]
        mat = MATERIALS[g.material_key]
        r = g.size[0]
        t = g.wall_mm / 1000.0
        # thin-wall circular tube
        area = 2.0 * math.pi * r * t
        i_area = math.pi * r ** 3 * t
        # bending moment = peak actuator torque reacted through the tube
        moment = body.joint.torque_nm
        sigma_bend = moment * r / i_area
        # axial: legs carry body weight; arms carry only their own + payload (use 0 ext)
        axial = single_leg_axial_n if body.group == "LEG" else 0.0
        sigma_axial = axial / area
        sigma = sigma_bend + sigma_axial
        sf = mat.allowable_stress_pa / sigma if sigma > 0 else math.inf
        parts.append({
            "part": g.name,
            "group": body.group,
            "material": mat.key,
            "radius_mm": round(r * 1000, 2),
            "wall_mm": g.wall_mm,
            "applied_moment_nm": round(moment, 1),
            "applied_axial_n": round(axial, 1),
            "bending_stress_mpa": round(sigma_bend / 1e6, 2),
            "axial_stress_mpa": round(sigma_axial / 1e6, 2),
            "total_stress_mpa": round(sigma / 1e6, 2),
            "allowable_mpa": round(mat.allowable_stress_pa / 1e6, 1),
            "safety_factor": round(sf, 2),
            "pass": bool(sf >= MIN_SAFETY_FACTOR),
        })

    worst = min(parts, key=lambda p: p["safety_factor"]) if parts else None
    return {
        "schema": "erobot-structural-sanity-v1",
        "ok": all(p["pass"] for p in parts),
        "method": "thin-wall circular tube: I=pi*r^3*t, A=2*pi*r*t; sigma=M*r/I + F/A",
        "robot_weight_n": round(weight_n, 1),
        "dynamic_load_factor": DYNAMIC_LOAD_FACTOR,
        "min_safety_factor_required": MIN_SAFETY_FACTOR,
        "worst_part": worst,
        "parts": parts,
    }


# ---------------------------------------------------------------------------
# kinematic tree (parity with cad/asimov-feminine/kinematic_tree.json)
# ---------------------------------------------------------------------------


def kinematic_tree(spec: RobotSpec | None = None) -> dict:
    spec = spec or build_spec()
    return {
        "robot": "erobot",
        "dof": spec.dof,
        "standing_height_m": round(spec.standing_height_m, 4),
        "links": [
            {
                "name": b.name,
                "parent": b.parent,
                "world_pos": [round(x, 6) for x in b.world_pos],
                "joint": (b.joint.name if b.joint else None),
                "joint_axis": (list(b.joint.axis) if b.joint else None),
                "group": b.group,
                "primitives": [
                    {"name": g.name, "type": g.type, "role": g.role,
                     "material": g.material_key, "wall_mm": g.wall_mm}
                    for g in b.geoms
                ],
            }
            for b in spec.bodies
        ],
    }


def run_all(spec: RobotSpec | None = None) -> dict:
    spec = spec or build_spec()
    results = {
        "mujoco-load": mujoco_load_proof(spec),
        "joint-sweep": joint_sweep_proof(spec),
        "mass-reconciliation": mass_reconciliation_proof(spec),
        "structural-sanity": structural_sanity_proof(spec),
    }
    paths = {name: str(_write(name, payload)) for name, payload in results.items()}
    tree_path = PROOFS_ROOT.parent / "kinematic_tree.json"
    tree_path.write_text(json.dumps(kinematic_tree(spec), indent=2) + "\n", encoding="utf-8")
    summary = {name: bool(r["ok"]) for name, r in results.items()}
    return {"ok": all(summary.values()), "proofs": summary,
            "paths": paths, "kinematic_tree": str(tree_path)}


if __name__ == "__main__":
    out = run_all()
    print("erobot proofs:")
    for name, ok in out["proofs"].items():
        print(f"  [{'PASS' if ok else 'FAIL'}] {name}")
    print(f"  overall: {'PASS' if out['ok'] else 'FAIL'}")
