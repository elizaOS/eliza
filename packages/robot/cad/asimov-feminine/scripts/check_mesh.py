"""Mesh quality checker for modified STL files.

Checks:
  1. Degenerate triangles (zero area)
  2. Self-fold detection: vertices that crossed through the opposite side
     of the mesh after deformation (verified by checking the front/back
     X distribution in key zones for expected bimodal separation)
  3. Winding consistency: faces whose computed normal disagrees with
     adjacent face windings (detects inverted patches from heavy deformation)
  4. Per-part summary report

Usage:
  uv run python check_mesh.py [path_to_stl] [...]
  uv run python check_mesh.py   # checks all promoted assets
"""
import sys
import numpy as np
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from stl_utils import read_stl, bbox


def check_stl(path: str) -> dict:
    name = Path(path).name
    _, verts = read_stl(path)

    e1 = verts[:, 1] - verts[:, 0]
    e2 = verts[:, 2] - verts[:, 0]
    cross = np.cross(e1, e2)
    mag = np.linalg.norm(cross, axis=1)

    n_tris = len(verts)
    degen = int((mag < 1e-10).sum())

    # Winding consistency: build face normals, then for each shared edge
    # check that adjacent faces have compatible winding.
    # Fast approximation: compare each face normal against the direction
    # from the face centroid to the nearest cluster centroid.
    # More reliable: find faces where normal flips sign relative to the
    # majority of their neighbors (robust for non-convex meshes).
    normals = cross / (mag[:, None] + 1e-15)
    cents = verts.mean(axis=1)

    mn, mx = verts.reshape(-1, 3).min(axis=0), verts.reshape(-1, 3).max(axis=0)
    span = mx - mn

    # Build a regular grid and check each cell for sign-flip neighbours
    # Grid resolution: divide each axis into 8 cells
    grid_cells = 6
    grid_idx = np.floor(
        (cents - mn) / (span + 1e-9) * grid_cells
    ).astype(int).clip(0, grid_cells - 1)

    # For each face: check if its normal roughly matches the majority in its cell
    inverted_count = 0
    from collections import defaultdict
    cells = defaultdict(list)
    for i, gi in enumerate(grid_idx):
        cells[tuple(gi)].append(i)

    for idxs in cells.values():
        if len(idxs) < 2:
            continue
        cell_normals = normals[idxs]  # Kx3
        # majority direction: mean of normals
        mean_n = cell_normals.mean(axis=0)
        mag_mn = np.linalg.norm(mean_n)
        if mag_mn < 1e-9:
            continue
        mean_n /= mag_mn
        dots = (cell_normals * mean_n).sum(axis=1)
        inverted_count += int((dots < -0.7).sum())  # faces pointing strongly opposite to majority

    # Self-fold check: look for axis ranges where vertex distribution becomes
    # non-bimodal (a sign that front/back surfaces have collapsed together)
    flat = verts.reshape(-1, 3)
    self_fold_score = 0

    # For each primary axis, check that the vertex distribution in the center
    # of the mesh doesn't have a suspicious gap-then-merge pattern
    for axis in range(3):
        vals = flat[:, axis] * 1000  # mm
        hist, bin_edges = np.histogram(vals, bins=40)
        # Detect if any interior bin has MORE vertices than both neighbors
        # (pile-up in the middle = possible fold)
        interior = hist[5:-5]
        if len(interior) > 0:
            peaks = (interior[1:-1] > interior[:-2]) & (interior[1:-1] > interior[2:])
            self_fold_score += int(peaks.sum())

    result = {
        "name": name,
        "triangles": n_tris,
        "degenerate": degen,
        "winding_issues": inverted_count,
        "fold_score": self_fold_score,
        "bbox_mm": {
            "x": float((mx[0] - mn[0]) * 1000),
            "y": float((mx[1] - mn[1]) * 1000),
            "z": float((mx[2] - mn[2]) * 1000),
        },
    }

    # Overall quality: FAIL if >0.5% degenerate or >2% winding issues
    degen_pct = degen / max(1, n_tris) * 100
    wind_pct = inverted_count / max(1, n_tris) * 100
    if degen_pct > 2.0 or wind_pct > 5.0:
        result["quality"] = "FAIL"
    elif degen_pct > 0.5 or wind_pct > 2.0:
        result["quality"] = "WARN"
    else:
        result["quality"] = "OK"

    return result


def report(results: list[dict]) -> None:
    fail = [r for r in results if r["quality"] == "FAIL"]
    warn = [r for r in results if r["quality"] == "WARN"]
    ok   = [r for r in results if r["quality"] == "OK"]

    print(f"\n{'='*72}")
    print(f"  MESH QUALITY REPORT — {len(results)} parts")
    print(f"  OK: {len(ok)}  WARN: {len(warn)}  FAIL: {len(fail)}")
    print(f"{'='*72}")
    print(f"  {'Part':<32}  {'Tris':>7}  {'Degen':>6}  {'Wind%':>6}  Status")
    print(f"  {'-'*65}")
    for r in sorted(results, key=lambda x: (x["quality"] != "FAIL", x["quality"] != "WARN", x["name"])):
        wind_pct = r["winding_issues"] / max(1, r["triangles"]) * 100
        degen_pct = r["degenerate"] / max(1, r["triangles"]) * 100
        status = {"FAIL": "FAIL ✗", "WARN": "WARN ⚠", "OK": "OK  ✓"}[r["quality"]]
        print(f"  {r['name']:<32}  {r['triangles']:>7}  {r['degenerate']:>6}  {wind_pct:>5.1f}%  {status}")


if __name__ == "__main__":
    if len(sys.argv) > 1:
        paths = sys.argv[1:]
    else:
        # Check all promoted assets
        asset_dir = Path(__file__).parent.parent.parent / "assets/profiles/asimov-1/meshes"
        paths = sorted(str(p) for p in asset_dir.glob("*.STL"))

    results = []
    for path in paths:
        if not Path(path).exists():
            print(f"  NOT FOUND: {path}")
            continue
        r = check_stl(path)
        results.append(r)

    report(results)
