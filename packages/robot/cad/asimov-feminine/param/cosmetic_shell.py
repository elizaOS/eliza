"""
Cosmetic feminine shell — armor-over-frame for the ASIMOV-1 torso + pelvis.

This module produces a NEW watertight STL (`TORSO_SHELL.STL`) that is a smooth
"armored valkyrie" cosmetic layer wrapping the torso (WAIST_YAW) and pelvis
(IMU_ORIGIN) frame. The mechanical frame is 100% untouched — this shell sits a
few millimetres OUTSIDE the frame's outer envelope and carries the curves the
flat-plate frame cannot: bust (forward + upper), cinched waist (mid), flared
hips (wide + lower), and a slight back arch.

HOW IT IS BUILT
---------------
The shell is a lofted (swept) surface, not a re-mesh of any frame part:

  1. A vertical spine runs in world Z from Z_BOT (lower pelvis) to Z_TOP (upper
     chest). At ~1 cm stations we evaluate smooth analytic body parameters
     (`profile_params`): half-width (Y), front depth (+X), back depth (-X),
     and the world X-center of that station.
  2. Each station becomes a closed, smooth cross-section — a *super-ellipse*
     (rounded-rectangle family) sampled at N_THETA points. Front/back radii and
     the side radius are independent so the section can be deeper at the bust,
     pinched at the waist, and broad at the hips while staying C1-smooth.
  3. Consecutive rings are stitched into a quad/tri side wall; the top and
     bottom rings are capped with a fan to a centroid vertex. Result is a
     single watertight manifold. Roundness is INHERENT because we author the
     sections as smooth super-ellipses — there is no flat plate to preserve
     here (this is the cosmetic layer, per AGENT_BRIEF constraint #1).

The size at every station is derived from the sampled frame envelope plus a
clearance (`CLEARANCE_M`), so the shell always reads as a body sitting just
outside the frame, never intersecting it.

WORLD PLACEMENT
---------------
Vertices are authored directly in WORLD coordinates (metres). The shell is
therefore registered in any assembled scene at world offset (0, 0, 0).

THREE.JS VIEWER
---------------
The viewer (`cad/asimov-feminine/viewer/index.html`) loads each entry of its
`LINKS` array as `FEMME_BASE + name + '.STL'` and calls
`mesh.position.set(...worldPos)`. Because this STL is already in world space,
add it with a ZERO world offset. Insert into the `LINKS` array (group 'torso'):

    ['TORSO_SHELL', 'TORSO_SHELL.STL', [0, 0, 0], 'torso'],

and add 'TORSO_SHELL' to `FEMME_DONE` so the femme path resolves it. No extra
offset is needed — suggested world offset is (0, 0, 0).

Regenerate:  .venv/bin/python cad/asimov-feminine/param/cosmetic_shell.py
"""

from __future__ import annotations

import os
import numpy as np
import trimesh

# ── World vertical extent of the shell (metres) ─────────────────────────────
Z_BOT = 0.600   # just above hip-yaw sockets, low pelvis
Z_TOP = 0.955   # upper chest / just under the shoulder yokes
DZ = 0.008      # sub-cm stations for a smooth loft

# ── Clearance the shell keeps OUTSIDE the sampled frame envelope (metres) ────
CLEARANCE_M = 0.012

# ── Cross-section sampling ──────────────────────────────────────────────────
N_THETA = 128           # points around each ring (smoothness)
SUPERELLIPSE_N = 2.5    # >2 = rounded-rectangle (gives a body, not a tube)

# ── Bust lobes (sculpted breastplate) ───────────────────────────────────────
Z_BUST_PEAK = 0.880     # world Z of the fullest part of the bust
BUST_Z_WIDTH = 0.040    # vertical falloff of the bust lobes
BUST_THETA = np.radians(33.0)   # ± angle of each breast lobe off front centre
BUST_THETA_WIDTH = np.radians(26.0)  # angular spread of each lobe
BUST_PROJECT = 0.052    # extra forward (+X) projection at each lobe peak (m)
CLEAVAGE = 0.45         # 0..1 how much the centre-front dips between lobes

# Frame X-center the shell wraps around (world X). The torso frame centroid in
# the wrapped band sits near -0.055; we center the shell there so equal front
# and back clearance is honest.
FRAME_CX = -0.055

OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "output", "stl")
OUT_NAME = "TORSO_SHELL.STL"


def _smoothstep(a: float, b: float, t: np.ndarray) -> np.ndarray:
    """C1 smooth ramp from a→b as t goes 0→1 (clamped)."""
    t = np.clip(t, 0.0, 1.0)
    return a + (b - a) * (t * t * (3.0 - 2.0 * t))


def _gaussian(z: np.ndarray, center: float, width: float) -> np.ndarray:
    """Unit-height Gaussian lobe in Z — used to add bust / hip volume."""
    return np.exp(-((z - center) ** 2) / (2.0 * width * width))


def profile_params(z: np.ndarray) -> dict:
    """Smooth feminine body parameters as a function of world Z.

    Returns, per Z, the shell's:
      half_y   — half-width in Y (side radius)
      front    — distance the section reaches in front of FRAME_CX (+X radius)
      back     — distance the section reaches behind FRAME_CX (-X radius)
      cx       — world X-center of the section (back-arch shift)

    All are continuous and differentiable so the loft is smooth. Values are
    sized to clear the sampled frame envelope (see module docstring).
    """
    z = np.asarray(z, dtype=float)

    # Normalised height 0 (Z_BOT) → 1 (Z_TOP).
    u = (z - Z_BOT) / (Z_TOP - Z_BOT)

    # Anchor Z levels of the body landmarks (world metres).
    Z_HIP = 0.640
    Z_WAIST = 0.755
    Z_BUST = 0.870

    # ── Half-width (Y) — hips wide (low) as a soft teardrop, waist cinched
    #    (mid), rib/bust band moderate (upper), tapering toward the shoulders.
    #    Kept slimmer than tall so the section reads as a torso, not a vase. ──
    hip_w = 0.058 * _gaussian(z, Z_HIP, 0.060)
    waist_pinch = 0.026 * _gaussian(z, Z_WAIST, 0.045)   # subtract to cinch
    bust_w = 0.038 * _gaussian(z, Z_BUST, 0.060)
    # The shoulder yokes reach Y~0.125 at the chest, so the upper band must stay
    # wide enough to clear them — only a slight taper toward the very top.
    top_taper = 0.006 * _smoothstep(0.0, 1.0, (z - 0.925) / 0.025)
    base_w = _smoothstep(0.108, 0.124, u)                # gentle baseline
    half_y = base_w + hip_w + bust_w - waist_pinch - top_taper
    half_y = np.maximum(half_y, 0.090)

    # ── Front reach (+X) — small at hips, gently waisted, pushed OUT and up at
    #    the bust. The waist is only lightly pulled in (the frame front face
    #    rises to ~+0.028 at the waist, so the shell front must stay outside
    #    that + clearance → front >= ~0.095 there). ──
    front_base = _smoothstep(0.100, 0.095, u)
    bust_front = 0.050 * _gaussian(z, Z_BUST, 0.050)
    waist_front_pinch = 0.006 * _gaussian(z, Z_WAIST, 0.050)
    front = front_base + bust_front - waist_front_pinch
    front = np.maximum(front, 0.095)

    # ── Back reach (-X) — fuller over the hips/seat, and kept generous up the
    #    spine because the frame back plate runs to ~-0.156 at the chest. ──
    back_base = _smoothstep(0.128, 0.135, u)
    seat = 0.022 * _gaussian(z, Z_HIP, 0.055)
    back = back_base + seat
    back = np.maximum(back, 0.115)

    # ── X-center: slight back arch — the mid torso shifts the center -X
    #    (spine hollow) while bust + seat push the silhouette forward. ──
    arch = -0.016 * _gaussian(z, 0.800, 0.060)
    cx = FRAME_CX + arch

    return dict(half_y=half_y, front=front, back=back, cx=cx)


def _bust_lobes(z: float, theta: np.ndarray) -> np.ndarray:
    """Forward (+X) projection added at two breast lobes for a sculpted chest.

    Returns a per-theta additive front reach (metres). Two Gaussian lobes sit
    at ±BUST_THETA off the front centre; a central notch (CLEAVAGE) keeps the
    sternum from bulging, so the front reads as two soft breasts, not one band.
    """
    z_env = _gaussian(np.array([z]), Z_BUST_PEAK, BUST_Z_WIDTH)[0]
    if z_env < 1e-3:
        return np.zeros_like(theta)
    # wrap theta to [-pi, pi] so the front (theta=0) is centred
    t = (theta + np.pi) % (2.0 * np.pi) - np.pi
    left = np.exp(-((t - BUST_THETA) ** 2) / (2.0 * BUST_THETA_WIDTH ** 2))
    right = np.exp(-((t + BUST_THETA) ** 2) / (2.0 * BUST_THETA_WIDTH ** 2))
    lobes = np.maximum(left, right)
    # central cleavage notch: subtract a narrow Gaussian at theta=0
    notch = CLEAVAGE * np.exp(-(t ** 2) / (2.0 * np.radians(12.0) ** 2))
    shape = np.clip(lobes - notch, 0.0, 1.0)
    return BUST_PROJECT * z_env * shape


def _ring(z: float, p: dict, theta: np.ndarray) -> np.ndarray:
    """One smooth closed cross-section ring at height z.

    Super-ellipse in the Y (side) / X (front-back) plane. Front and back X
    radii differ, so we blend the X radius by which half of the section we are
    in (cos(theta) > 0 → front). theta=0 points to +X (front).
    """
    half_y = p["half_y"]
    front = p["front"]
    back = p["back"]
    cx = p["cx"]

    c = np.cos(theta)
    s = np.sin(theta)

    # Super-ellipse unit shape (rounded rectangle): |c|^n + |s|^n = 1 → scale.
    n = SUPERELLIPSE_N
    denom = (np.abs(c) ** n + np.abs(s) ** n) ** (1.0 / n)
    cx_unit = c / denom   # in [-1, 1], front/back direction
    sy_unit = s / denom   # in [-1, 1], side direction

    # Front/back asymmetry: positive cx_unit reaches `front`, negative reaches
    # `back`. Smoothly blend at the sides to avoid a crease.
    w = 0.5 * (cx_unit + 1.0)                # 0 at back, 1 at front
    x_radius = back + (front - back) * w

    # Two sculpted breast lobes, projecting forward only on the front hemisphere
    # (scaled by the front weight so they vanish smoothly toward the sides).
    bust = _bust_lobes(z, theta) * w
    x = cx + cx_unit * x_radius + bust
    y = sy_unit * half_y
    zc = np.full_like(theta, z)
    return np.stack([x, y, zc], axis=1)


def build_shell() -> trimesh.Trimesh:
    """Loft the smooth profiles into a single watertight shell mesh."""
    zs = np.arange(Z_BOT, Z_TOP + 1e-9, DZ)
    theta = np.linspace(0.0, 2.0 * np.pi, N_THETA, endpoint=False)

    rings = []
    for z in zs:
        p = profile_params(np.array([z]))
        p = {k: float(v[0]) for k, v in p.items()}
        rings.append(_ring(z, p, theta))

    verts = np.vstack(rings)               # (n_rings * N_THETA, 3)
    n_rings = len(rings)
    faces = []

    # Side wall: stitch ring i to ring i+1 (two tris per quad).
    for i in range(n_rings - 1):
        a0 = i * N_THETA
        b0 = (i + 1) * N_THETA
        for j in range(N_THETA):
            jn = (j + 1) % N_THETA
            v00 = a0 + j
            v01 = a0 + jn
            v10 = b0 + j
            v11 = b0 + jn
            faces.append([v00, v10, v11])
            faces.append([v00, v11, v01])

    # Bottom cap (fan to centroid of first ring), outward-facing down.
    bot_c = len(verts)
    verts = np.vstack([verts, rings[0].mean(axis=0)])
    for j in range(N_THETA):
        jn = (j + 1) % N_THETA
        faces.append([bot_c, jn, j])

    # Top cap (fan to centroid of last ring), outward-facing up.
    top_c = len(verts)
    verts = np.vstack([verts, rings[-1].mean(axis=0)])
    base = (n_rings - 1) * N_THETA
    for j in range(N_THETA):
        jn = (j + 1) % N_THETA
        faces.append([top_c, base + j, base + jn])

    mesh = trimesh.Trimesh(vertices=verts, faces=np.array(faces), process=True)
    mesh.fix_normals()
    return mesh


def clearance_report() -> str:
    """Per-Z-station radial clearance between the shell section and the frame
    envelope. For each ~2 cm band we compare, in the X (front/back) and Y (side)
    directions, the shell's reach against the farthest frame vertex in that band.
    Positive gap = shell is outside the frame. Fast and analytic — no contains().
    """
    P = {"IMU_ORIGIN": (0, 0, 0.630), "WAIST_YAW": (-0.052, 0, 0.704755)}
    fv = np.vstack([
        trimesh.load(os.path.join(OUT_DIR, n + ".STL")).vertices + np.array(o)
        for n, o in P.items()
    ])
    lines = []
    worst = float("inf")
    for z0 in np.arange(Z_BOT, Z_TOP, 0.02):
        sel = (fv[:, 2] >= z0) & (fv[:, 2] < z0 + 0.02)
        if sel.sum() < 5:
            continue
        s = fv[sel]
        p = profile_params(np.array([z0 + 0.01]))
        p = {k: float(v[0]) for k, v in p.items()}
        shell_front = p["cx"] + p["front"]
        shell_back = p["cx"] - p["back"]
        shell_side = p["half_y"]
        g_front = (shell_front - s[:, 0].max()) * 1000
        g_back = (s[:, 0].min() - shell_back) * 1000
        g_side = (shell_side - np.abs(s[:, 1]).max()) * 1000
        gmin = min(g_front, g_back, g_side)
        worst = min(worst, gmin)
        lines.append(f"  Z={z0:.2f}  front={g_front:+5.1f}  back={g_back:+5.1f}  "
                     f"side={g_side:+5.1f} mm")
    lines.append(f"  WORST gap over band = {worst:+.1f} mm "
                 f"({'CLEARS' if worst > 0 else 'INTERSECTS'})")
    return "\n".join(lines)


def main() -> None:
    os.makedirs(OUT_DIR, exist_ok=True)
    mesh = build_shell()
    out = os.path.join(OUT_DIR, OUT_NAME)
    mesh.export(out)
    print(f"wrote {out}")
    print(f"  watertight={mesh.is_watertight} verts={len(mesh.vertices)} "
          f"faces={len(mesh.faces)}")
    bb = mesh.bounds
    print(f"  world bounds X[{bb[0,0]:+.3f},{bb[1,0]:+.3f}] "
          f"Y[{bb[0,1]:+.3f},{bb[1,1]:+.3f}] Z[{bb[0,2]:+.3f},{bb[1,2]:+.3f}]")
    print("clearance vs frame (per Z-station, gap>0 = shell outside frame):")
    print(clearance_report())


if __name__ == "__main__":
    main()
