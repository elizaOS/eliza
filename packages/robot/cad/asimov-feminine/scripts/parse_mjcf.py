"""Parse ASIMOV-1 MJCF kinematic tree → world transforms JSON for Three.js viewer."""
import json
import xml.etree.ElementTree as ET
import numpy as np
from pathlib import Path

ROBOT_PKG = Path(__file__).parent.parent.parent.parent
MJCF_PATH = ROBOT_PKG / "assets/profiles/asimov-1/mjcf/asimov_eliza.xml"
MESH_DIR = ROBOT_PKG / "assets/profiles/asimov-1/meshes"

# STL file → visual mesh name map (from MJCF asset declarations)
VISUAL_GEOM_SUFFIX = "_visual"


def quat_to_matrix(q):
    """Convert quaternion (w,x,y,z) to 3x3 rotation matrix."""
    w, x, y, z = q
    return np.array([
        [1-2*(y*y+z*z),   2*(x*y-w*z),   2*(x*z+w*y)],
        [  2*(x*y+w*z), 1-2*(x*x+z*z),   2*(y*z-w*x)],
        [  2*(x*z-w*y),   2*(y*z+w*x), 1-2*(x*x+y*y)],
    ])


def parse_pos(s: str | None) -> np.ndarray:
    if not s:
        return np.zeros(3)
    return np.array([float(v) for v in s.split()])


def parse_quat(s: str | None) -> np.ndarray:
    if not s:
        return np.array([1.0, 0.0, 0.0, 0.0])
    return np.array([float(v) for v in s.split()])


def walk_bodies(elem, parent_pos: np.ndarray, parent_rot: np.ndarray,
                mesh_map: dict, results: list):
    """Recursively walk body elements, accumulate world transforms."""
    for body in elem.findall("body"):
        local_pos = parse_pos(body.get("pos"))
        local_quat = parse_quat(body.get("quat"))
        local_rot = quat_to_matrix(local_quat)

        world_rot = parent_rot @ local_rot
        world_pos = parent_pos + parent_rot @ local_pos

        # Find visual geom mesh reference
        stl_file = None
        for geom in body.findall("geom"):
            if geom.get("class") == "visual":
                mesh_name = geom.get("mesh")
                if mesh_name and mesh_name in mesh_map:
                    stl_file = mesh_map[mesh_name]
                    break

        results.append({
            "name": body.get("name", ""),
            "stl": stl_file,
            "world_pos": world_pos.tolist(),
            "world_rot": world_rot.tolist(),
        })

        walk_bodies(body, world_pos, world_rot, mesh_map, results)


def build_kinematic_tree() -> dict:
    tree = ET.parse(MJCF_PATH)
    root = tree.getroot()

    # Build mesh name → STL filename map
    mesh_map = {}
    asset = root.find("asset")
    if asset:
        for mesh in asset.findall("mesh"):
            name = mesh.get("name", "")
            file = mesh.get("file", "")
            mesh_map[name] = file

    worldbody = root.find("worldbody")
    results = []
    identity = np.eye(3)

    for body in worldbody.findall("body"):
        local_pos = parse_pos(body.get("pos"))
        local_quat = parse_quat(body.get("quat"))
        local_rot = quat_to_matrix(local_quat)

        world_pos = local_pos
        world_rot = local_rot

        stl_file = None
        for geom in body.findall("geom"):
            if geom.get("class") == "visual":
                mesh_name = geom.get("mesh")
                if mesh_name and mesh_name in mesh_map:
                    stl_file = mesh_map[mesh_name]
                    break

        results.append({
            "name": body.get("name", ""),
            "stl": stl_file,
            "world_pos": world_pos.tolist(),
            "world_rot": world_rot.tolist(),
        })

        walk_bodies(body, world_pos, world_rot, mesh_map, results)

    return {
        "links": results,
        "mesh_dir": "../../assets/profiles/asimov-1/meshes/",
        "units": "metres",
    }


if __name__ == "__main__":
    out = Path(__file__).parent.parent / "kinematic_tree.json"
    data = build_kinematic_tree()
    out.write_text(json.dumps(data, indent=2))
    print(f"Written {len(data['links'])} links → {out}")
    for link in data["links"]:
        pos = link["world_pos"]
        print(f"  {link['name']:40s} stl={link['stl'] or 'none':30s} z={pos[2]:.3f}")
