"""Compute 2D cross-sectional slice of an STL mesh at a given axis position.

Outputs ASCII art showing the shape at different heights.
Useful for verifying breast shape, waist cinch, and back arch.
"""
import sys
import numpy as np
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from stl_utils import read_stl, bbox


def slice_at(vertices: np.ndarray, axis: int, value: float,
             thickness: float = 0.005) -> np.ndarray:
    """Return vertices of triangles that straddle axis=value within ±thickness."""
    verts_flat = vertices.reshape(-1, 3)
    tris = vertices  # Nx3x3
    n = len(tris)
    result = []
    for i in range(n):
        v = tris[i, :, axis]
        if v.min() <= value + thickness and v.max() >= value - thickness:
            # Find intersection points with the plane
            for j in range(3):
                result.append(tris[i, j])
    return np.array(result) if result else np.zeros((0, 3))


def ascii_cross_section(vertices: np.ndarray, stl_name: str,
                        axis_up: int = 2, axis_h: int = 0, axis_v: int = 1,
                        n_slices: int = 6, width: int = 60, height: int = 20):
    """Print ASCII cross-sections of the mesh at evenly spaced heights."""
    mn, mx = vertices.reshape(-1, 3).min(axis=0), vertices.reshape(-1, 3).max(axis=0)
    span = mx[axis_up] - mn[axis_up]

    print(f"\n{'═'*65}")
    print(f"  Cross-sections: {stl_name}  ({axis_h}=horiz  {axis_v}=vert)")
    print(f"  Z range: {mn[axis_up]*1000:.1f}mm to {mx[axis_up]*1000:.1f}mm  span={span*1000:.1f}mm")
    print(f"{'═'*65}")

    fracs = [0.15, 0.30, 0.45, 0.60, 0.75, 0.90]
    for frac in fracs:
        z = mn[axis_up] + span * frac
        pts = slice_at(vertices, axis_up, z)
        if len(pts) == 0:
            continue

        h_vals = pts[:, axis_h]
        v_vals = pts[:, axis_v]
        h_min, h_max = h_vals.min(), h_vals.max()
        v_min, v_max = v_vals.min(), v_vals.max()

        h_span = (h_max - h_min) * 1000
        v_span = (v_max - v_min) * 1000

        grid = [[' '] * width for _ in range(height)]
        for h, v in zip(h_vals, v_vals):
            col = int((h - h_min) / (h_max - h_min + 1e-9) * (width - 1))
            row = int((1 - (v - v_min) / (v_max - v_min + 1e-9)) * (height - 1))
            col = max(0, min(width-1, col))
            row = max(0, min(height-1, row))
            grid[row][col] = '█'

        pct = frac * 100
        print(f"\n  Z={z*1000:.0f}mm ({pct:.0f}% height)  W={h_span:.0f}mm × D={v_span:.0f}mm")
        print(f"  {'─'*width}")
        for row in grid:
            print(f"  {''.join(row)}")


if __name__ == "__main__":
    MESH_DIR = Path(__file__).parent.parent / "originals"
    MOD_DIR  = Path(__file__).parent.parent / "output/modified"

    for stl_name in ["WAIST_YAW.STL", "LEFT_HIP_YAW.STL", "LEFT_KNEE.STL"]:
        orig_path = MESH_DIR / stl_name
        mod_path  = MOD_DIR / stl_name

        if orig_path.exists():
            _, verts = read_stl(str(orig_path))
            ascii_cross_section(verts, f"ORIGINAL {stl_name}")

        if mod_path.exists():
            _, verts = read_stl(str(mod_path))
            ascii_cross_section(verts, f"MODIFIED {stl_name}")
