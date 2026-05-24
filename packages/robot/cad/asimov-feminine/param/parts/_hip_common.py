"""
Shared hip-feminization builder for the six hip links:
LEFT/RIGHT_HIP_PITCH, _HIP_ROLL, _HIP_YAW.

Each link is sliced along its spine axis (see connections.py), warped to add a
feminine hip line, and lofted back to a watertight mesh. Connection interfaces
are held exact by connection_weight, which ramps every warp to 0 at the
reserved joint levels.

Axis facts that drive the warp choice (in each link's local frame):
- HIP_PITCH: spine='y'. In-plane dims are (x,z); Y is the SLICE axis, so a Y
  flare cannot be an axis_scale(dim=1). Widening the whole XZ cross-section via
  radial_scale grows the yoke outward — that is the hip-width gesture here.
- HIP_ROLL: spine='z'. In-plane dims (x,y); Y is in-plane → axis_scale(dim=1).
- HIP_YAW: spine='z'. In-plane dims (x,y); Y is in-plane → axis_scale(dim=1)
  for an outer-thigh Y flare that tapers toward the knee.

LEFT and RIGHT share identical warp magnitudes. The geometry is mirrored across
Y in the source STLs and the reserved levels mirror automatically in
connections.py, so the same recipe applied to each side's own STL produces a
symmetric result without any per-side sign flips (the flares used are symmetric
in Y about the section centroid).
"""
import os
import sys

import numpy as np
import trimesh

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
PARAM_DIR = os.path.dirname(HERE)
sys.path.insert(0, PARAM_DIR)

import paramlib as P  # noqa: E402
import connections as C  # noqa: E402
import warp2 as W  # noqa: E402

ROBOT_ROOT = os.path.abspath(os.path.join(PARAM_DIR, "..", "..", ".."))
MESH_DIR = os.path.join(ROBOT_ROOT, "assets/profiles/asimov-1/meshes")
OUT_DIR = os.path.join(ROBOT_ROOT, "cad/asimov-feminine/output/stl")


def _gauss(z, center, sigma):
    return np.exp(-(((z - center) / sigma) ** 2))


def build_hip_pitch(name):
    """Small hip yoke, spine='y'. The intent asks for a Y flare, but Y is the
    SLICE axis here, so the pipeline cannot grow the part along Y (slicing only
    samples existing Y extent). The honest feminine gesture for this little yoke
    is a gentle ~1.06 in-plane swell (X/Z roundness) in the mid-body, blended to
    0 at both joints. Intended flare delta on X/Z: up to +6% of original bbox."""
    spec = C.LINKS[name]
    orig = trimesh.load(os.path.join(MESH_DIR, name + ".STL"))
    param = P.slice_to_rings(orig, axis=spec["spine"], step=0.005, n_angular=96)
    reserved = C.reserved_levels(name)
    w = P.connection_weight(param, reserved, ramp=0.02)

    lv = param.levels[param.valid]
    mid = 0.5 * (lv.min() + lv.max())  # body center along the y-spine

    def flare(y):
        return 1.0 + 0.06 * _gauss(y, mid, 0.025)

    P.radial_scale(param, flare, weight=w)
    return orig, param, reserved, spec


def build_hip_roll(name):
    """Hip link, spine='z'. Modest ~1.05 Y flare (axis_scale dim=1).
    Intended flare delta on Y: up to +5% of original bbox."""
    spec = C.LINKS[name]
    orig = trimesh.load(os.path.join(MESH_DIR, name + ".STL"))
    param = P.slice_to_rings(orig, axis=spec["spine"], step=0.005, n_angular=96)
    reserved = C.reserved_levels(name)
    w = P.connection_weight(param, reserved, ramp=0.02)

    lv = param.levels[param.valid]
    mid = 0.5 * (lv.min() + lv.max())

    def flare(z):
        return 1.0 + 0.06 * _gauss(z, mid, 0.022)

    P.axis_scale(param, dim=1, fn=flare, weight=w)
    return orig, param, reserved, spec


def build_hip_yaw(name):
    """Upper thigh, spine='z'. The main hip-shaping link. Flare Y ~1.10 in the
    upper thigh (Z near the hip end) for hips, taper to ~1.0 toward the knee.
    Intended flare delta on Y: up to +10% of original bbox (upper thigh only)."""
    spec = C.LINKS[name]
    orig = trimesh.load(os.path.join(MESH_DIR, name + ".STL"))
    param = P.slice_to_rings(orig, axis=spec["spine"], step=0.01, n_angular=96)
    reserved = C.reserved_levels(name)  # [hip Z=0, knee Z=-0.19564]
    w = P.connection_weight(param, reserved, ramp=0.045)

    # Upper thigh bulk sits Z ~ -0.07..+0.03 (hip end ~Z=0). Knee end at Z=-0.196.
    # Flare peaks just below the hip and decays well before the knee taper.
    # Coefficient 0.13 lands the in-band outer-Y widening near the +10% intent
    # once the connection_weight ramp at the hip (Z=0) is accounted for.
    def flare(z):
        return 1.0 + 0.13 * _gauss(z, -0.030, 0.050)

    P.axis_scale(param, dim=1, fn=flare, weight=w)
    return orig, param, reserved, spec


BUILDERS = {
    "HIP_PITCH": build_hip_pitch,
    "HIP_ROLL": build_hip_roll,
    "HIP_YAW": build_hip_yaw,
}


def process(name, render=False):
    """Build, validate, write the femme STL for one hip link. Returns a report."""
    kind = name.replace("LEFT_", "").replace("RIGHT_", "")
    orig, param, reserved, spec = BUILDERS[kind](name)

    # Identity reconstruction (same slicing, no warp) isolates the inherent
    # loft/cap loss from the warp's own effect, so joint preservation is
    # measured against what the pipeline would produce with NO warp.
    ident_param = P.slice_to_rings(orig, axis=spec["spine"],
                                   step=param.levels[1] - param.levels[0],
                                   n_angular=len(param.angles))
    ident = P.rings_to_mesh(ident_param)

    if kind == "HIP_ROLL":
        rebuilt = W.warp_similarity(
            orig,
            axis=spec["spine"],
            scale_fn=lambda _z: 0.97,
            reserved=reserved,
            ramp=0.03,
            step=0.0025,
            smooth_m=5,
        )
    else:
        rebuilt = P.rings_to_mesh(param)
    out_path = os.path.join(OUT_DIR, name + ".STL")
    rebuilt.export(out_path)

    ob, rb = orig.bounds, rebuilt.bounds
    ratios = {}
    for i, ax in enumerate("XYZ"):
        osp = (ob[1][i] - ob[0][i]) * 1000
        rsp = (rb[1][i] - rb[0][i]) * 1000
        ratios[ax] = (osp, rsp, rsp / osp if osp else float("nan"))

    # Joint preservation: at each reserved spine level compare femme vs the
    # no-warp reconstruction (weight ramps the warp to 0 there → should match).
    a = P.AXIS_IDX[spec["spine"]]
    pdims = [d for d in range(3) if d != a]
    joint_dev = {}
    for rl in reserved:
        normal = np.zeros(3); normal[a] = 1.0
        org = np.zeros(3); org[a] = rl
        dev = _section_span_dev(ident, rebuilt, org, normal, pdims)
        joint_dev[round(rl, 4)] = dev

    if render:
        _render(name, orig, rebuilt, spec, reserved)

    return dict(name=name, spine=spec["spine"], ratios=ratios,
                watertight=bool(rebuilt.is_watertight), reserved=reserved,
                joint_dev_mm=joint_dev, out=out_path)


def _section_span_dev(ident, rebuilt, origin, normal, pdims):
    """Max in-plane bbox-span deviation (mm) between the no-warp reconstruction
    and the femme mesh at a spine plane. The connection_weight ramp drives the
    warp to 0 at reserved levels, so this should be ~0 there."""
    def span(mesh):
        s = mesh.section(plane_origin=origin, plane_normal=normal)
        if s is None:
            return None
        pts = s.vertices[:, pdims]
        return pts.max(axis=0) - pts.min(axis=0)
    si, sr = span(ident), span(rebuilt)
    if si is None or sr is None:
        return None
    return float(np.max(np.abs(sr - si)) * 1000)


def _render(name, orig, rebuilt, spec, reserved):
    ov, rv = orig.vertices, rebuilt.vertices
    a = P.AXIS_IDX[spec["spine"]]
    # Show the front-ish view that best reveals the Y flare:
    # plot (Y horizontal vs spine vertical) so hip width is visible.
    spine_i = a
    y_i = 1
    if y_i == spine_i:  # HIP_PITCH: spine is Y, show X horizontal vs Y(spine) vert
        h_i = 0
    else:
        h_i = y_i
    fig, ax = plt.subplots(1, 3, figsize=(14, 8))
    ax[0].scatter(ov[:, h_i] * 1000, ov[:, spine_i] * 1000, s=0.3, c="gray")
    ax[0].set_title(f"ORIG ({'XYZ'[h_i]} vs spine {'XYZ'[spine_i]})")
    ax[0].set_aspect("equal")
    ax[1].scatter(rv[:, h_i] * 1000, rv[:, spine_i] * 1000, s=0.4, c="orange")
    ax[1].set_title("FEMME")
    ax[1].set_aspect("equal")
    ax[2].scatter(ov[:, h_i] * 1000, ov[:, spine_i] * 1000, s=0.3, c="gray", alpha=0.4, label="orig")
    ax[2].scatter(rv[:, h_i] * 1000, rv[:, spine_i] * 1000, s=0.3, c="orange", alpha=0.5, label="femme")
    for rl in reserved:
        ax[2].axhline(rl * 1000, c="g", lw=0.8, ls="--")
    ax[2].set_title("overlay (joints dashed)")
    ax[2].set_aspect("equal")
    ax[2].legend()
    plt.tight_layout()
    out = f"/tmp/{name.lower()}_check.png"
    plt.savefig(out, dpi=80)
    plt.close(fig)
    return out
