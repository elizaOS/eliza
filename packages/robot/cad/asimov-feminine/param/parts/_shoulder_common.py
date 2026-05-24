"""Shared builder for the six shoulder links.

Each shoulder part is feminized by the standard slice -> radial_scale -> loft
pipeline.  The yoke (SHOULDER_PITCH, spine y) keeps a mild pauldron presence;
the upper-arm links (SHOULDER_ROLL / SHOULDER_YAW, spine z) are slimmed for a
slender arm.  Connection interfaces are held exact by connection_weight, which
ramps every warp to 1.0 at the reserved spine levels (self joint at 0 plus each
child joint).  We only ever slim (multiplier <= 1.0), so the femme mesh stays
inside the original bounding box.
"""
import os
import sys

import numpy as np
import trimesh

PARAM_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, PARAM_DIR)
import paramlib as P  # noqa: E402
from connections import LINKS, reserved_levels  # noqa: E402

ROBOT_DIR = os.path.abspath(os.path.join(PARAM_DIR, "..", "..", ".."))
SRC_DIR = os.path.join(ROBOT_DIR, "assets", "profiles", "asimov-1", "meshes")
OUT_DIR = os.path.join(ROBOT_DIR, "cad", "asimov-feminine", "output", "stl")

# Per-part uniform slim target (multiplier applied away from connections).
SLIM = {
    "LEFT_SHOULDER_PITCH": 0.97,
    "LEFT_SHOULDER_ROLL": 0.85,
    "LEFT_SHOULDER_YAW": 0.84,
}
for _n, _s in list(SLIM.items()):
    SLIM[_n.replace("LEFT_", "RIGHT_")] = _s


def build(part, render=False):
    """Feminize one shoulder link; write the STL; optionally write a check PNG.
    Returns (orig_mesh, femme_mesh, reserved_levels)."""
    spec = LINKS[part]
    axis = spec["spine"]
    reserved = reserved_levels(part)
    slim = SLIM[part]

    orig = trimesh.load(os.path.join(SRC_DIR, part + ".STL"))
    param = P.slice_to_rings(orig, axis=axis, step=0.01, n_angular=72)
    w = P.connection_weight(param, reserved, ramp=0.035)
    P.radial_scale(param, lambda _z: slim, weight=w)

    femme = P.rings_to_mesh(param)
    out_path = os.path.join(OUT_DIR, part + ".STL")
    femme.export(out_path)

    if render:
        _render(part, axis, orig, femme, reserved)
    return orig, femme, reserved


def _render(part, axis, orig, femme, reserved):
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    a = {"x": 0, "y": 1, "z": 2}[axis]
    # Plot the spine axis vertically against the larger in-plane dim.
    pdims = [d for d in range(3) if d != a]
    spans = (orig.bounds[1] - orig.bounds[0])
    h = pdims[0] if spans[pdims[0]] >= spans[pdims[1]] else pdims[1]
    labels = "XYZ"

    ov, fv = orig.vertices, femme.vertices
    fig, ax = plt.subplots(1, 3, figsize=(13, 7))
    ax[0].scatter(ov[:, h] * 1000, ov[:, a] * 1000, s=0.3, c="gray")
    ax[0].set_title(f"ORIG ({labels[h]}{labels[a]})")
    ax[1].scatter(fv[:, h] * 1000, fv[:, a] * 1000, s=0.4, c="orange")
    ax[1].set_title(f"FEMME ({labels[h]}{labels[a]})")
    ax[2].scatter(ov[:, h] * 1000, ov[:, a] * 1000, s=0.3, c="gray", alpha=0.4, label="orig")
    ax[2].scatter(fv[:, h] * 1000, fv[:, a] * 1000, s=0.3, c="orange", alpha=0.5, label="femme")
    for rl in reserved:
        ax[2].axhline(rl * 1000, c="g", lw=0.8, ls="--")
    ax[2].set_title("overlay (joints dashed)")
    ax[2].legend()
    for a_ in ax:
        a_.set_aspect("equal")
    plt.tight_layout()
    png = f"/tmp/{part.lower()}_check.png"
    plt.savefig(png, dpi=80)
    plt.close(fig)
    print(f"saved {png}")
