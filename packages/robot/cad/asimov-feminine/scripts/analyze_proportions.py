"""Analyze bounding boxes of all ASIMOV-1 STL meshes and print a report."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from stl_utils import read_stl, bbox

MESH_DIR = Path(__file__).parent.parent.parent / "assets/profiles/asimov-1/meshes"
OUT_DIR = Path(__file__).parent.parent / "reports"

# Anatomical groupings
GROUPS = {
    "head":  ["NECK_YAW.STL", "NECK_PITCH.STL"],
    "torso": ["IMU_ORIGIN.STL", "WAIST_YAW.STL"],
    "left_arm":  ["LEFT_SHOULDER_PITCH.STL", "LEFT_SHOULDER_ROLL.STL",
                  "LEFT_SHOULDER_YAW.STL", "LEFT_ELBOW.STL", "LEFT_WRIST_YAW.STL"],
    "right_arm": ["RIGHT_SHOULDER_PITCH.STL", "RIGHT_SHOULDER_ROLL.STL",
                  "RIGHT_SHOULDER_YAW.STL", "RIGHT_ELBOW.STL", "RIGHT_WRIST_YAW.STL"],
    "left_leg":  ["LEFT_HIP_PITCH.STL", "LEFT_HIP_ROLL.STL", "LEFT_HIP_YAW.STL",
                  "LEFT_KNEE.STL", "LEFT_ANKLE_A.STL", "LEFT_ANKLE_B.STL", "LEFT_TOE.STL"],
    "right_leg": ["RIGHT_HIP_PITCH.STL", "RIGHT_HIP_ROLL.STL", "RIGHT_HIP_YAW.STL",
                  "RIGHT_KNEE.STL", "RIGHT_ANKLE_A.STL", "RIGHT_ANKLE_B.STL", "RIGHT_TOE.STL"],
}


def analyze_all() -> dict:
    results = {}
    for stl_path in sorted(MESH_DIR.glob("*.STL")):
        try:
            _, verts = read_stl(str(stl_path))
            mn, mx = bbox(verts)
            size = mx - mn
            results[stl_path.name] = {
                "bbox_min": mn.tolist(),
                "bbox_max": mx.tolist(),
                "size_xyz": size.tolist(),
                "size_x_mm": round(size[0] * 1000, 1),
                "size_y_mm": round(size[1] * 1000, 1),
                "size_z_mm": round(size[2] * 1000, 1),
                "n_triangles": len(verts),
            }
        except Exception as e:
            results[stl_path.name] = {"error": str(e)}
    return results


if __name__ == "__main__":
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    data = analyze_all()

    out_path = OUT_DIR / "proportions.json"
    out_path.write_text(json.dumps(data, indent=2))
    print(f"Written → {out_path}\n")

    print(f"{'Part':<35} {'X mm':>8} {'Y mm':>8} {'Z mm':>8}  {'Tris':>7}")
    print("-" * 75)
    for group, parts in GROUPS.items():
        print(f"\n[{group.upper()}]")
        for stl in parts:
            info = data.get(stl, {})
            if "error" in info:
                print(f"  {stl:<33}  ERROR: {info['error']}")
            else:
                print(f"  {stl:<33} {info['size_x_mm']:>8.1f} {info['size_y_mm']:>8.1f} "
                      f"{info['size_z_mm']:>8.1f}  {info['n_triangles']:>7}")
