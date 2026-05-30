"""
Defect-visualization render: paint mesh faces by surface-quality defect so they
are obvious at a glance.

  RED      -> face touches a BOUNDARY edge (a tear / open hole)
  MAGENTA  -> face touches a NON-MANIFOLD edge (>2 faces: overlap / self-cross)
  ORANGE   -> sharp CREASE (dihedral angle to a neighbour above threshold): the
              "pitted / not-a-smooth-arc" regions
  YELLOW   -> mild crease
  GREY     -> clean, smooth

Run:  .venv/bin/python cad/asimov-feminine/param/defect_shader.py [PART ...]
Outputs /tmp/defect/<PART>.png montages + a per-part defect summary.
"""
from __future__ import annotations

import glob
import math
import os
import sys
from collections import defaultdict

import numpy as np
import pyvista as pv
import trimesh

pv.OFF_SCREEN = True
OUT = "/tmp/defect"
STL = "/Users/shawwalters/eliza-workspace/milady/eliza/packages/robot/cad/asimov-feminine/output/stl"

RED = [220, 45, 45]
MAGENTA = [220, 40, 200]
ORANGE = [245, 150, 35]
YELLOW = [240, 225, 70]
GREY = [205, 205, 212]

CREASE_HARD_DEG = 40.0   # above this dihedral = hard crease (not a smooth arc)
CREASE_SOFT_DEG = 22.0


def face_defect_colors(m: trimesh.Trimesh):
    nf = len(m.faces)
    col = np.tile(GREY, (nf, 1)).astype(np.uint8)
    summary = {"boundary_faces": 0, "nonmanifold_faces": 0, "hard_crease_faces": 0, "soft_crease_faces": 0}

    # edge -> incident face count, via sorted edges (3 per face, face order)
    edges = m.edges_sorted
    face_of_edge = np.repeat(np.arange(nf), 3)
    keys = edges.view([("", edges.dtype)] * 2).ravel()
    order = np.argsort(keys, kind="stable")
    ek = keys[order]
    fe = face_of_edge[order]
    # group identical edges
    start = 0
    for i in range(1, len(ek) + 1):
        if i == len(ek) or ek[i] != ek[start]:
            grp = fe[start:i]
            n = i - start
            if n == 1:
                col[grp] = RED
                summary["boundary_faces"] += 1
            elif n > 2:
                col[grp] = MAGENTA
                summary["nonmanifold_faces"] += len(grp)
            start = i

    # creases: dihedral angle between adjacent faces
    adj = m.face_adjacency
    ang = np.degrees(m.face_adjacency_angles)
    for (fa, fb), a in zip(adj, ang):
        if a >= CREASE_HARD_DEG:
            for fc in (fa, fb):
                if not (col[fc] == RED).all() and not (col[fc] == MAGENTA).all():
                    col[fc] = ORANGE
                    summary["hard_crease_faces"] += 1
        elif a >= CREASE_SOFT_DEG:
            for fc in (fa, fb):
                if (col[fc] == GREY).all():
                    col[fc] = YELLOW
                    summary["soft_crease_faces"] += 1
    return col, summary


def montage(nm: str):
    m = trimesh.load(f"{STL}/{nm}.STL", force="mesh")
    col, s = face_defect_colors(m)
    pl = pv.Plotter(off_screen=True, window_size=(1200, 360), shape=(1, 4))
    pl.set_background("#101014")
    faces = np.hstack([np.full((len(m.faces), 1), 3), m.faces]).ravel()
    for i, (az, el) in enumerate([(0, 0), (90, 0), (180, 0), (45, 18)]):
        pl.subplot(0, i)
        pd = pv.PolyData(m.vertices, faces)
        pd.cell_data["c"] = col
        pl.add_mesh(pd, scalars="c", rgb=True, smooth_shading=False, show_edges=False)
        vv = (math.sin(math.radians(az)) * math.cos(math.radians(el)),
              -math.cos(math.radians(az)) * math.cos(math.radians(el)),
              math.sin(math.radians(el)))
        pl.view_vector(vv, (0, 0, 1))
        pl.camera.zoom(1.35)
    os.makedirs(OUT, exist_ok=True)
    pl.screenshot(f"{OUT}/{nm}.png")
    pl.close()
    u, c = np.unique(m.edges_sorted, axis=0, return_counts=True)
    print(f"{nm:<22} bound={int((c == 1).sum()):>4} nonman={int((c > 2).sum()):>5} "
          f"hardCrease_faces={s['hard_crease_faces']:>6} ({100*s['hard_crease_faces']/max(len(m.faces),1):.1f}%)")


def main():
    names = [a.upper() for a in sys.argv[1:]] or [
        os.path.basename(p)[:-4] for p in sorted(glob.glob(f"{STL}/*.STL"))
    ]
    for nm in names:
        montage(nm)


if __name__ == "__main__":
    main()
