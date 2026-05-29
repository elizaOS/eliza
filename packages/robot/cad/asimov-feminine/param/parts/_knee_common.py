"""Shared builder for the two knee links (thigh+calf shaft, spine z).

Feminization: a slender leg with a soft calf curve, not a uniform stick.
The radial profile fn(z) slims the whole shaft but is slimmest at the shin and
ankle approach and slightly fuller across the calf belly (Z ~ -0.12..-0.18), so
the silhouette swells gently at the muscle and tapers smoothly to the ankle. A
mild sector_scale on the back (-X) over the same band adds the calf-muscle
bulge. connection_weight ramps every warp to 1.0 at the reserved knee (0) and
ankle (-0.2947) levels, so both mating rings stay exact.

The global shaft multiplier stays below 1.0, while the localized back-only
sector gain is allowed to push the calf belly slightly past the original -X
envelope. That makes the calf-back morphology parameter measurable instead of
only implied by catalog intent. LEFT and RIGHT use the identical profile
mirrored across Y by the source meshes themselves (the knee shaft is
Y-symmetric), so no extra mirroring math is needed.
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

# Calf-curve shaping constants (metres along the local Z spine).
SHAFT_SLIM = 0.80        # slimmest target (shin front + ankle approach)
BELLY_SLIM = 0.90        # fuller target across the calf belly
BELLY_Z = -0.15          # centre of the calf muscle belly
BELLY_SIGMA = 0.045      # gaussian half-spread of the belly swell
BACK_BULGE = 1.70        # extra -X (calf) sector multiplier at the belly peak
BACK_BULGE_WIDTH = np.pi * 0.45


def _bell(z, centre, sigma):
    """Unit gaussian bump in [0,1], peak 1.0 at `centre`."""
    return float(np.exp(-0.5 * ((z - centre) / sigma) ** 2))


def calf_profile(z):
    """Radial multiplier fn(z): slim shaft that rises to a soft calf belly.

    Interpolates from SHAFT_SLIM up toward BELLY_SLIM following a gaussian bump
    centred on the calf muscle, giving a slender shin/ankle with a gentle swell
    mid-shin.  connection_weight still blends this to 1.0 at the joints.
    """
    return SHAFT_SLIM + (BELLY_SLIM - SHAFT_SLIM) * _bell(z, BELLY_Z, BELLY_SIGMA)


def calf_back_bulge(z):
    """Back (-X) sector multiplier fn(z): a localized calf-muscle bulge."""
    return 1.0 + (BACK_BULGE - 1.0) * _bell(z, BELLY_Z, BELLY_SIGMA)


def build(part, render=False):
    """Feminize one knee link; write the STL; optionally write a check PNG.
    Returns (orig_mesh, femme_mesh, reserved_levels)."""
    spec = LINKS[part]
    axis = spec["spine"]
    reserved = reserved_levels(part)

    orig = trimesh.load(os.path.join(SRC_DIR, part + ".STL"))
    param = P.slice_to_rings(orig, axis=axis, step=0.01, n_angular=96)
    w = P.connection_weight(param, reserved, ramp=0.04)

    # Slim the whole shaft with a calf-belly swell, then add a back-only bulge
    # for the calf muscle.  Angle 0 = +X (shin front); pi = -X (calf back).
    P.radial_scale(param, calf_profile, weight=w)
    P.sector_scale(param, ang_center=np.pi, ang_width=BACK_BULGE_WIDTH,
                   fn=calf_back_bulge, weight=w)

    femme = P.rings_to_mesh(param)
    out_path = os.path.join(OUT_DIR, part + ".STL")
    femme.export(out_path)

    if render:
        _render(part, orig, femme, reserved)
    return orig, femme, reserved


def _render(part, orig, femme, reserved):
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    ov, fv = orig.vertices, femme.vertices
    fig, ax = plt.subplots(1, 3, figsize=(14, 7))
    # Side view (XZ): shin front (+X) vs calf back (-X) — shows the calf curve.
    ax[0].scatter(ov[:, 0] * 1000, ov[:, 2] * 1000, s=0.3, c="gray", alpha=0.4, label="orig")
    ax[0].scatter(fv[:, 0] * 1000, fv[:, 2] * 1000, s=0.3, c="orange", alpha=0.6, label="femme")
    ax[0].set_title(f"{part} side (XZ): +X shin / -X calf")
    ax[0].legend()
    # Back-on view (YZ): symmetry + overall slim.
    ax[1].scatter(ov[:, 1] * 1000, ov[:, 2] * 1000, s=0.3, c="gray", alpha=0.4)
    ax[1].scatter(fv[:, 1] * 1000, fv[:, 2] * 1000, s=0.3, c="orange", alpha=0.6)
    ax[1].set_title(f"{part} back-on (YZ)")
    # Overlay XZ with joint planes.
    ax[2].scatter(ov[:, 0] * 1000, ov[:, 2] * 1000, s=0.3, c="gray", alpha=0.35)
    ax[2].scatter(fv[:, 0] * 1000, fv[:, 2] * 1000, s=0.3, c="orange", alpha=0.5)
    for rl in reserved:
        ax[2].axhline(rl * 1000, c="g", lw=0.8, ls="--")
    ax[2].axhline(BELLY_Z * 1000, c="purple", lw=0.8, ls=":", label="belly")
    ax[2].set_title("overlay (joints dashed, belly dotted)")
    ax[2].legend()
    for a_ in ax:
        a_.set_aspect("equal")
    plt.tight_layout()
    png = f"/tmp/{part.lower()}_check.png"
    plt.savefig(png, dpi=80)
    plt.close(fig)
    print(f"saved {png}")
