from __future__ import annotations

import json
import xml.etree.ElementTree as ET

from eliza_robot.asimov_1.constants import (
    ASIMOV1_FIRMWARE_JOINT_ORDER,
    ASIMOV1_GENERATED_MANIFEST,
    ASIMOV1_GENERATED_MJCF,
    ASIMOV1_GENERATED_URDF,
)
from eliza_robot.asimov_1.urdf_assets import generate_asimov1_urdf


def test_asimov_generated_urdf_is_real_kinematic_visual_asset() -> None:
    path = generate_asimov1_urdf(source_xml=ASIMOV1_GENERATED_MJCF, output_urdf=ASIMOV1_GENERATED_URDF)
    root = ET.parse(path).getroot()

    assert root.tag == "robot"
    assert root.get("name") == "asimov-1"
    assert root.findall("link")
    assert len(root.findall("link")) == 28
    assert len(root.findall("joint")) == 27
    assert len(root.findall(".//visual")) == 28
    assert len(root.findall(".//mesh")) == 28

    joints = {joint.get("name"): joint for joint in root.findall("joint")}
    for name in ASIMOV1_FIRMWARE_JOINT_ORDER:
        joint = joints[name]
        assert joint.get("type") == "revolute"
        assert joint.find("parent") is not None
        assert joint.find("child") is not None
        assert joint.find("axis") is not None
        assert joint.find("limit") is not None

    mesh_refs = [mesh.get("filename") for mesh in root.findall(".//mesh")]
    assert all(ref is not None and ref.startswith("meshes/") and ref.endswith(".STL") for ref in mesh_refs)


def test_asimov_asset_manifest_tracks_generated_urdf() -> None:
    manifest = json.loads(ASIMOV1_GENERATED_MANIFEST.read_text(encoding="utf-8"))
    assert manifest["generated_urdf"] == str(ASIMOV1_GENERATED_URDF)
    assert manifest["generated_urdf_sha256"]
