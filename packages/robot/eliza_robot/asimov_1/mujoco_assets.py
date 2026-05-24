"""Generate the elizaOS ASIMOV-1 MuJoCo asset from the vendored model."""

from __future__ import annotations

import json
import shutil
import xml.etree.ElementTree as ET
from pathlib import Path

import mujoco

from eliza_robot.asimov_1.cad import sha256_file, validate_cad_tree
from eliza_robot.asimov_1.constants import (
    ASIMOV1_FIRMWARE_JOINT_ORDER,
    ASIMOV1_GENERATED_MANIFEST,
    ASIMOV1_GENERATED_MJCF,
    ASIMOV1_GENERATED_URDF,
    ASIMOV1_PROFILE_ASSET_ROOT,
    ASIMOV1_SOURCE_MESH_DIR,
    ASIMOV1_SOURCE_XML,
)
from eliza_robot.asimov_1.urdf_assets import generate_asimov1_urdf


def _cad_root_for_source(source_xml: Path) -> Path:
    return source_xml.resolve().parents[2]


def _joint_ranges(root: ET.Element) -> dict[str, tuple[float, float]]:
    ranges: dict[str, tuple[float, float]] = {}
    for joint in root.findall(".//joint"):
        name = joint.get("name")
        raw = joint.get("range")
        if not name or not raw:
            continue
        parts = raw.split()
        if len(parts) == 2:
            ranges[name] = (float(parts[0]), float(parts[1]))
    return ranges


def _ensure_actuators(root: ET.Element) -> None:
    old = root.find("actuator")
    if old is not None:
        root.remove(old)
    actuator = ET.SubElement(root, "actuator")
    ranges = _joint_ranges(root)
    for name in ASIMOV1_FIRMWARE_JOINT_ORDER:
        lo, hi = ranges.get(name, (-1.0, 1.0))
        ET.SubElement(
            actuator,
            "position",
            {
                "name": name,
                "joint": name,
                "kp": "80",
                "kv": "2",
                "ctrlrange": f"{lo:.6f} {hi:.6f}",
            },
        )


def generate_asimov1_mjcf(
    *,
    source_xml: Path = ASIMOV1_SOURCE_XML,
    output_xml: Path = ASIMOV1_GENERATED_MJCF,
    output_urdf: Path | None = None,
    manifest_path: Path = ASIMOV1_GENERATED_MANIFEST,
    mesh_dir: Path = ASIMOV1_SOURCE_MESH_DIR,
) -> Path:
    """Generate a compile-checked MJCF with elizaOS position actuators."""
    output_xml.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    tree = ET.parse(source_xml)
    root = tree.getroot()
    compiler = root.find("compiler")
    if compiler is None:
        compiler = ET.SubElement(root, "compiler")
    compiler.set("meshdir", str(mesh_dir.resolve()))
    _ensure_actuators(root)
    ET.indent(tree, space="  ")
    tree.write(output_xml, encoding="utf-8", xml_declaration=False)
    model = mujoco.MjModel.from_xml_path(str(output_xml))
    if int(model.nu) != len(ASIMOV1_FIRMWARE_JOINT_ORDER):
        raise ValueError(f"expected {len(ASIMOV1_FIRMWARE_JOINT_ORDER)} actuators, got {model.nu}")
    urdf_path = output_urdf or (
        ASIMOV1_GENERATED_URDF if output_xml == ASIMOV1_GENERATED_MJCF else output_xml.parent.parent / "asimov.urdf"
    )
    generate_asimov1_urdf(source_xml=output_xml, output_urdf=urdf_path)
    cad_root = _cad_root_for_source(source_xml)
    inventory = validate_cad_tree(
        mechanical_root=cad_root / "mechanical" / "ASV1",
        main_step=cad_root / "mechanical" / "ASV1" / "ASIMOV_V1.STEP",
        source_xml=source_xml,
        mesh_dir=mesh_dir,
        fabrication_manifest=cad_root / "mechanical" / "FABRICATION_MANIFEST.json",
    )
    manifest = {
        "profile_id": "asimov-1",
        "source_xml": str(source_xml),
        "generated_mjcf": str(output_xml),
        "generated_urdf": str(urdf_path),
        "mesh_dir": str(mesh_dir),
        "source_xml_sha256": sha256_file(source_xml),
        "generated_mjcf_sha256": sha256_file(output_xml),
        "generated_urdf_sha256": sha256_file(urdf_path),
        "joint_order": list(ASIMOV1_FIRMWARE_JOINT_ORDER),
        "model": {"nq": int(model.nq), "nv": int(model.nv), "nu": int(model.nu)},
        "cad": inventory.__dict__,
    }
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return output_xml


def copy_profile_meshes() -> None:
    dest = ASIMOV1_PROFILE_ASSET_ROOT / "meshes"
    dest.mkdir(parents=True, exist_ok=True)
    for mesh in ASIMOV1_SOURCE_MESH_DIR.glob("*.STL"):
        shutil.copy2(mesh, dest / mesh.name)


if __name__ == "__main__":
    print(generate_asimov1_mjcf())
