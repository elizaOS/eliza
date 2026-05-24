"""Wave 4 — Head / Neck sub-assembly feminisation.

NECK_PITCH (head assembly):
  - Lateral narrowing (Y axis): uniform 8% compression starting from original.
  - Lower jaw taper (bottom 20% of Z height): X compressed 12%, Y compressed 15%.
    Applied as a smooth blend so the taper feathers into the middle section rather
    than hard-cutting at 20%.
  - Top-of-head (Z > 80%): left untouched (sensor/camera array).

NECK_YAW (neck column):
  - Same 22% cross-section thinning as Wave 3, applied fresh from original.
    (X and Y both scaled to 0.78 about their individual midpoints.)

Both read from originals/, write to output/modified/.
"""

import sys
from pathlib import Path

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(Path(__file__).parent))

import numpy as np
from stl_utils import read_stl, write_stl, recalc_normals, bbox


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def compress_lateral(vertices: np.ndarray, scale_y: float) -> np.ndarray:
    """Uniform lateral (Y) compression about the Y centroid.

    Used for the global 8% lateral narrowing of the head.
    """
    verts = vertices.reshape(-1, 3).copy()
    mid_y = (verts[:, 1].max() + verts[:, 1].min()) / 2.0
    verts[:, 1] = mid_y + (verts[:, 1] - mid_y) * scale_y
    return verts.reshape(vertices.shape)


def jaw_taper(vertices: np.ndarray,
              jaw_frac: float = 0.20,
              feather_frac: float = 0.10,
              scale_x: float = 0.88,
              scale_y: float = 0.85) -> np.ndarray:
    """Taper the lower jaw area with a smooth feathered blend.

    Vertices in the bottom jaw_frac of Z get full scale_x / scale_y compression.
    Vertices in the feather_frac band above that get a smooth linear blend from
    full taper down to 1.0 (no change).
    Vertices above jaw_frac + feather_frac are unchanged.

    This avoids a hard crease at the 20% cut line.
    """
    verts = vertices.reshape(-1, 3).copy()
    z_min = verts[:, 2].min()
    z_max = verts[:, 2].max()
    span = z_max - z_min

    jaw_hi = z_min + span * jaw_frac          # top of full taper zone
    feather_hi = jaw_hi + span * feather_frac  # top of feather zone

    # Mid-points for X and Y compression (per-axis centroid of entire mesh)
    mid_x = (verts[:, 0].max() + verts[:, 0].min()) / 2.0
    mid_y = (verts[:, 1].max() + verts[:, 1].min()) / 2.0

    # Per-vertex blend weight: 1 in jaw zone, linearly 0 at feather_hi
    w = np.zeros(len(verts))
    in_jaw = verts[:, 2] <= jaw_hi
    in_feather = (verts[:, 2] > jaw_hi) & (verts[:, 2] <= feather_hi)

    w[in_jaw] = 1.0
    if in_feather.any():
        t = (verts[in_feather, 2] - jaw_hi) / (feather_hi - jaw_hi + 1e-9)
        w[in_feather] = 1.0 - t  # 1 at jaw_hi, 0 at feather_hi

    # Weighted scale: actual_scale = 1.0 - w * (1.0 - target_scale)
    sx = 1.0 - w * (1.0 - scale_x)
    sy = 1.0 - w * (1.0 - scale_y)

    verts[:, 0] = mid_x + (verts[:, 0] - mid_x) * sx
    verts[:, 1] = mid_y + (verts[:, 1] - mid_y) * sy

    return verts.reshape(vertices.shape)


def thin_neck_yaw(vertices: np.ndarray, scale: float = 0.78) -> np.ndarray:
    """Compress X and Y by scale about their individual midpoints (22% reduction)."""
    verts = vertices.reshape(-1, 3).copy()
    for ax in (0, 1):
        mid = (verts[:, ax].max() + verts[:, ax].min()) / 2.0
        verts[:, ax] = mid + (verts[:, ax] - mid) * scale
    return verts.reshape(vertices.shape)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def process_neck_pitch():
    src = ROOT / "originals" / "NECK_PITCH.STL"
    dst = ROOT / "output" / "modified" / "NECK_PITCH.STL"
    dst.parent.mkdir(parents=True, exist_ok=True)

    normals, verts = read_stl(str(src))
    mn0, mx0 = bbox(verts)
    sz0 = (mx0 - mn0) * 1000

    # Step 1: 8% lateral (Y) narrowing — global, applied from original
    verts = compress_lateral(verts, scale_y=0.92)

    # Step 2: Lower-jaw taper (bottom 20% + 10% feather), X-12%, Y-15%
    #         Applied AFTER the global Y narrowing so percentages are on the
    #         already-narrowed mesh (which is what the visual target requires).
    verts = jaw_taper(verts,
                      jaw_frac=0.20,
                      feather_frac=0.10,
                      scale_x=0.88,
                      scale_y=0.85)

    normals = recalc_normals(verts)
    write_stl(str(dst), normals, verts)

    mn1, mx1 = bbox(verts)
    sz1 = (mx1 - mn1) * 1000
    return sz0, sz1


def process_neck_yaw():
    src = ROOT / "originals" / "NECK_YAW.STL"
    dst = ROOT / "output" / "modified" / "NECK_YAW.STL"
    dst.parent.mkdir(parents=True, exist_ok=True)

    normals, verts = read_stl(str(src))
    mn0, mx0 = bbox(verts)
    sz0 = (mx0 - mn0) * 1000

    verts = thin_neck_yaw(verts, scale=0.78)

    normals = recalc_normals(verts)
    write_stl(str(dst), normals, verts)

    mn1, mx1 = bbox(verts)
    sz1 = (mx1 - mn1) * 1000
    return sz0, sz1


def cross_section_summary(stl_path: str, label: str):
    """Print Y-span (lateral width) at 15% and 85% of Z height."""
    from stl_utils import read_stl, bbox

    _, verts = read_stl(stl_path)
    flat = verts.reshape(-1, 3)
    z_min = flat[:, 2].min()
    z_max = flat[:, 2].max()
    span = z_max - z_min

    thickness = span * 0.035  # ±3.5% band

    results = {}
    for frac, name in [(0.15, "jaw (15%)"), (0.85, "forehead (85%)")]:
        z_val = z_min + span * frac
        mask = (flat[:, 2] >= z_val - thickness) & (flat[:, 2] <= z_val + thickness)
        pts = flat[mask]
        if len(pts) < 3:
            results[name] = None
            continue
        y_width = (pts[:, 1].max() - pts[:, 1].min()) * 1000
        x_depth = (pts[:, 0].max() - pts[:, 0].min()) * 1000
        results[name] = (y_width, x_depth)

    print(f"\n  {label}")
    for name, vals in results.items():
        if vals is None:
            print(f"    {name}: insufficient geometry")
        else:
            print(f"    {name}: lateral Y={vals[0]:.1f}mm  fore-aft X={vals[1]:.1f}mm")

    # Taper ratio: jaw Y / forehead Y
    if results.get("jaw (15%)") and results.get("forehead (85%)"):
        jaw_y = results["jaw (15%)"][0]
        fore_y = results["forehead (85%)"][0]
        ratio = jaw_y / fore_y
        print(f"    Jaw/Forehead Y ratio: {ratio:.3f}  ({ratio*100:.1f}% — ", end="")
        if ratio < 0.80:
            print("strong taper, believable feminine shape)")
        elif ratio < 0.88:
            print("moderate taper, believable feminine shape)")
        elif ratio < 0.94:
            print("subtle taper, borderline feminine)")
        else:
            print("minimal taper, not yet feminine)")

    return results


if __name__ == "__main__":
    print("=" * 60)
    print("  Wave 4 — Head / Neck Feminisation")
    print("=" * 60)

    # --- NECK_PITCH ---
    sz0, sz1 = process_neck_pitch()
    print(f"\nNECK_PITCH (head assembly):")
    print(f"  Before: X={sz0[0]:.1f}mm  Y={sz0[1]:.1f}mm  Z={sz0[2]:.1f}mm")
    print(f"  After:  X={sz1[0]:.1f}mm  Y={sz1[1]:.1f}mm  Z={sz1[2]:.1f}mm")
    print(f"  DeltaX={sz1[0]-sz0[0]:+.1f}mm ({(sz1[0]-sz0[0])/sz0[0]*100:+.1f}%)")
    print(f"  DeltaY={sz1[1]-sz0[1]:+.1f}mm ({(sz1[1]-sz0[1])/sz0[1]*100:+.1f}%)")
    print(f"  Z unchanged: {sz1[2]:.1f}mm")

    # --- NECK_YAW ---
    sz0y, sz1y = process_neck_yaw()
    print(f"\nNECK_YAW (neck column):")
    print(f"  Before: X={sz0y[0]:.1f}mm  Y={sz0y[1]:.1f}mm  Z={sz0y[2]:.1f}mm")
    print(f"  After:  X={sz1y[0]:.1f}mm  Y={sz1y[1]:.1f}mm  Z={sz1y[2]:.1f}mm")
    print(f"  DeltaX={sz1y[0]-sz0y[0]:+.1f}mm ({(sz1y[0]-sz0y[0])/sz0y[0]*100:+.1f}%)")
    print(f"  DeltaY={sz1y[1]-sz0y[1]:+.1f}mm ({(sz1y[1]-sz0y[1])/sz0y[1]*100:+.1f}%)")

    # --- Cross-section analysis on modified NECK_PITCH ---
    mod_pitch = str(ROOT / "output" / "modified" / "NECK_PITCH.STL")
    orig_pitch = str(ROOT / "originals" / "NECK_PITCH.STL")

    print(f"\n{'─'*60}")
    print("  Cross-section analysis — NECK_PITCH lateral width")
    print(f"{'─'*60}")
    cross_section_summary(orig_pitch, "ORIGINAL")
    cross_section_summary(mod_pitch, "MODIFIED (Wave 4)")
