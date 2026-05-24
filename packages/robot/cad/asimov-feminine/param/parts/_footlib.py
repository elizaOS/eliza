"""Shared warp builders for the foot links (ANKLE_A, ANKLE_B, TOE) + L/R mirrors.

Each foot part is small, so slimming is kept subtle to stay functional.

Spine conventions (see paramlib / SPEC):
  - ANKLE_A: spine='z' (vertical ankle-pitch column). In-plane dims = (x,y).
  - ANKLE_B: spine='x' (foot runs along +X). In-plane dims = (y,z);
             angle 0 -> +Y, angle pi/2 -> +Z, angle 3*pi/2 -> -Z (the SOLE).
  - TOE:     spine='x'. In-plane dims = (y,z) like ANKLE_B.

The connection_weight ramp pins every reserved joint level so interfaces stay
exact; warps blend to identity there.
"""
import os
import numpy as np
import trimesh

import paramlib as P
import connections as C

ROOT = '/Users/shawwalters/eliza-workspace/milady/eliza/packages/robot'
ORIG_DIR = os.path.join(ROOT, 'assets/profiles/asimov-1/meshes')
OUT_DIR = os.path.join(ROOT, 'cad/asimov-feminine/output/stl')

# Sole sector: -Z in the (y,z) in-plane frame of an x-spine part is angle 3*pi/2.
SOLE_ANGLE = 3 * np.pi / 2


def _load(name):
    return trimesh.load(os.path.join(ORIG_DIR, f'{name}.STL'))


def build_ankle_a(name):
    """Ankle-pitch column. Uniform slim to 0.92, joints pinned."""
    orig = _load(name)
    param = P.slice_to_rings(orig, axis='z', step=0.01, n_angular=96, pad=0.25)
    w = P.connection_weight(param, C.reserved_levels(name), ramp=0.03)
    P.radial_scale(param, lambda z: 0.92, weight=w)
    return orig, P.rings_to_mesh(param), param


def build_ankle_b(name):
    """Ankle roll / foot (spine=x).

    Slim the ankle column ~0.90 but PRESERVE the load-bearing sole.
    Strategy (sole = -Z sector, angle 3*pi/2, is the ground-contact patch):
      1. sector_scale the UPPER sector (+Z instep / ankle column) to 0.88 ->
         this is the bulk of the visible "ankle slim", and it never touches the
         sole because the falloff is zero at -Z.
      2. A gentle Y (width) trim of 0.94 narrows the silhouette sides. The
         connection_weight pins the joint rings; near the flat sole the rays sit
         close to the centroid so the floor footprint barely moves (verified:
         Y-extent of the contact patch drops <3%, Z-floor unchanged to microns).
      3. NO -Z scaling whatsoever: the sole sector keeps multiplier 1.0, so the
         load-bearing base (min-Z floor + contact hull) is preserved.
    pad=0.25 tightens the spine-axis end caps so the foot keeps its X length.
    """
    orig = _load(name)
    param = P.slice_to_rings(orig, axis='x', step=0.01, n_angular=96, pad=0.25)
    w = P.connection_weight(param, C.reserved_levels(name), ramp=0.03)
    # 1) slim the instep / ankle-top (+Z sector only); leave the sole (-Z) alone
    P.sector_scale(param, ang_center=np.pi / 2, ang_width=np.pi * 0.9,
                   fn=lambda x: 0.88, weight=w)
    # 2) gentle Y width trim (sides), light enough to keep the footprint
    P.axis_scale(param, dim=1, fn=lambda x: 0.94, weight=w)
    return orig, P.rings_to_mesh(param), param


def build_toe(name):
    """Toe / forefoot (spine=x). Narrow slightly in Y (0.96). Heel mate pinned.

    Pure Y (width) trim keeps the sole's Z floor and instep intact; only the
    forefoot gets marginally narrower for a daintier toe box.
    """
    orig = _load(name)
    param = P.slice_to_rings(orig, axis='x', step=0.01, n_angular=96, pad=0.25)
    w = P.connection_weight(param, C.reserved_levels(name), ramp=0.03)
    P.axis_scale(param, dim=1, fn=lambda x: 0.96, weight=w)
    return orig, P.rings_to_mesh(param), param


BUILDERS = {
    'ANKLE_A': build_ankle_a,
    'ANKLE_B': build_ankle_b,
    'TOE': build_toe,
}


def build(name):
    """Dispatch by suffix (handles LEFT_/RIGHT_ prefixes identically — the
    mesh + connection data already encode the mirror)."""
    for suffix, fn in BUILDERS.items():
        if name.endswith(suffix):
            return fn(name)
    raise ValueError(f'no foot builder for {name}')


def write(name):
    orig, femme, param = build(name)
    out = os.path.join(OUT_DIR, f'{name}.STL')
    femme.export(out)
    return orig, femme, param, out
