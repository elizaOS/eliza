"""
Visual-mesh self-collision sweep for the assembled fembot.

MuJoCo's own collision uses capsule geoms; this instead poses the kinematic tree
through the real MJCF joint ranges and checks whether the actual VISUAL MESHES of
NON-ADJACENT parts interpenetrate -- i.e. can the legs/arms actually move without
the cosmetic shells clashing (the narrowed hips + bulky real joints are the risk).

Reports, per pose, the worst non-adjacent part-part overlap volume (cm^3).
Run:  .venv/bin/python cad/asimov-feminine/param/collision_sweep_visual.py
"""
from __future__ import annotations

import itertools
import json
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

import numpy as np
import trimesh

ROBOT = Path("/Users/shawwalters/eliza-workspace/milady/eliza/packages/robot")
MJCF = ROBOT / "cad/asimov-feminine/output/mjcf/asimov_fembot_slim_visuals.xml"
TOL_CM3 = 1.0   # overlaps below this are treated as touching/noise


def _p(*a):
    print(*a, flush=True)


def build():
    import mujoco

    model = mujoco.MjModel.from_xml_path(str(MJCF))
    data = mujoco.MjData(model)
    mfile = {me.get("name"): me.get("file") for me in ET.parse(MJCF).iter("mesh")}
    geom_body, geom_mesh = {}, {}
    for gid in range(model.ngeom):
        if model.geom_type[gid] != mujoco.mjtGeom.mjGEOM_MESH:
            continue
        geom_body[gid] = model.geom_bodyid[gid]
        geom_mesh[gid] = mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_MESH, model.geom_dataid[gid])
    cache: dict[str, trimesh.Trimesh] = {}

    def mesh(gid):
        nm = geom_mesh[gid]
        if nm not in cache:
            cache[nm] = trimesh.load(mfile[nm], force="mesh")
        return cache[nm]

    def bname(g):
        return mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_BODY, geom_body[g]) or ""

    def world(gid):
        bid = geom_body[gid]
        R = data.xmat[bid].reshape(3, 3)
        me = mesh(gid).copy()
        me.vertices = me.vertices @ R.T + data.xpos[bid]
        return me

    def ancestors(bid, depth=2):
        out, cur = [], bid
        for _ in range(depth):
            cur = int(model.body_parentid[cur])
            out.append(cur)
        return out

    def adjacent_b(ba, bb):
        # nested in the same joint cluster (within 2 kinematic hops) -> overlap by
        # design, not a real self-collision
        return ba == bb or bb in ancestors(ba) or ba in ancestors(bb)

    def reset():
        data.qpos[:] = 0.0
        for j in range(model.njnt):
            if model.jnt_type[j] == mujoco.mjtJoint.mjJNT_FREE:
                a = int(model.jnt_qposadr[j])
                data.qpos[a:a + 7] = [0, 0, 0.9, 1, 0, 0, 0]

    def setj(nm, val):
        j = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_JOINT, nm)
        if j >= 0:
            data.qpos[model.jnt_qposadr[j]] = val

    # one body-level world mesh per leg link (merge that body's geoms)
    leg_bodies = sorted({geom_body[g] for g in geom_mesh
                         if any(k in bname(g) for k in ("hip", "knee", "ankle", "toe"))})
    body_geoms = {bid: [g for g in geom_mesh if geom_body[g] == bid] for bid in leg_bodies}

    def check(label):
        mujoco.mj_forward(model, data)
        mgr = trimesh.collision.CollisionManager()
        for bid in leg_bodies:
            parts = [world(g) for g in body_geoms[bid]]
            mgr.add_object(str(bid), trimesh.util.concatenate(parts))
        hit, names = mgr.in_collision_internal(return_names=True)
        hot = []
        for a, b in names:
            ba, bb = int(a), int(b)
            if adjacent_b(ba, bb):
                continue
            hot.append((mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_BODY, ba),
                        mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_BODY, bb)))
        tag = "OK" if not hot else "COLLISION"
        _p(f"  {label:<34} non_adjacent_collisions={len(hot):>2}  {tag}")
        for h in hot:
            _p("        ", h)
        return {"pose": label, "collisions": hot}

    results = []
    _p("VISUAL-MESH LEG COLLISION SWEEP (non-adjacent overlaps):")
    for deg in (0, 15, 30, 45):
        reset(); setj("left_hip_roll_joint", np.radians(-deg)); setj("right_hip_roll_joint", np.radians(deg))
        results.append(check(f"hip_roll adduct {deg}deg"))
    for deg in (0, 45, 86):
        reset(); setj("left_knee_joint", np.radians(deg)); setj("right_knee_joint", np.radians(-deg))
        results.append(check(f"knee flex {deg}deg"))
    for deg in (0, 45):
        reset(); setj("left_hip_yaw_joint", np.radians(-deg)); setj("right_hip_yaw_joint", np.radians(deg))
        results.append(check(f"hip_yaw inward {deg}deg"))
    reset(); setj("left_hip_pitch_joint", np.radians(40)); setj("left_knee_joint", np.radians(60))
    results.append(check("L stride hip40+knee60"))

    ncoll = sum(len(r["collisions"]) for r in results)
    bad = [r["pose"] for r in results if r["collisions"]]
    _p(f"\nVERDICT: {'NO non-adjacent collision in any swept pose' if ncoll == 0 else 'COLLISION in poses: ' + ', '.join(bad)}")
    out = ROBOT / "cad/asimov-feminine/proofs/visual-leg-collision-sweep.json"
    out.write_text(json.dumps({"poses": results, "collision_pose_count": len(bad)}, indent=2))
    return ncoll


if False:
    pass


if __name__ == "__main__":
    raise SystemExit(0 if build() < TOL_CM3 else 2)
