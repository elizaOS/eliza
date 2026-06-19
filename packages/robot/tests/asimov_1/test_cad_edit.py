from __future__ import annotations

import json
import xml.etree.ElementTree as ET
from pathlib import Path

from eliza_robot.asimov_1.cad_edit import (
    apply_asimov1_mjcf_patch,
    create_asimov1_edit_workspace,
    promote_asimov1_workspace,
    regenerate_asimov1_workspace,
)
from eliza_robot.asimov_1.constants import ASIMOV1_FULL_ACTION_DIM


def test_asimov_cad_edit_workspace_patch_regenerate_promote_contract(tmp_path: Path) -> None:
    workspace = tmp_path / "edit"
    meta = create_asimov1_edit_workspace(workspace, force=True)

    assert Path(meta["source_xml"]).is_file()
    assert Path(meta["mesh_dir"]).is_dir()
    assert Path(meta["main_step"]).is_file()
    assert Path(meta["fabrication_manifest"]).is_file()
    assert meta["cad_inventory"]["cad_entries"] == 170
    assert meta["cad_inventory"]["source_xml"] == meta["source_xml"]
    assert meta["cad_inventory"]["main_step"] == meta["main_step"]
    assert meta["cad_inventory"]["main_step_sha256"]

    patch_report = apply_asimov1_mjcf_patch(
        workspace,
        {
            "joints": {
                "left_ankle_roll_joint": {
                    "range": [-0.12, 0.12],
                    "armature": 0.057,
                }
            },
            "comment": "pytest ASIMOV edit",
        },
    )
    assert patch_report["before_sha256"] != patch_report["after_sha256"]
    assert len(patch_report["changes"]) == 3

    source_tree = ET.parse(meta["source_xml"])
    joint = source_tree.getroot().find(".//joint[@name='left_ankle_roll_joint']")
    assert joint is not None
    assert joint.get("range") == "-0.120000 0.120000"
    assert joint.get("armature") == "0.057"

    regeneration = regenerate_asimov1_workspace(workspace)
    generated_mjcf = Path(regeneration["generated_mjcf"])
    generated_urdf = Path(regeneration["generated_urdf"])
    generated_manifest = Path(meta["generated_manifest"])
    assert generated_mjcf.is_file()
    assert generated_urdf.is_file()
    assert generated_manifest.is_file()

    manifest = json.loads(generated_manifest.read_text(encoding="utf-8"))
    assert manifest["model"]["nu"] == ASIMOV1_FULL_ACTION_DIM
    assert Path(manifest["generated_urdf"]).is_file()
    assert manifest["cad"]["mesh_count"] == 28
    assert manifest["cad"]["source_xml"] == meta["source_xml"]
    assert manifest["cad"]["main_step"] == meta["main_step"]
    assert manifest["cad"]["fabrication_manifest"] == meta["fabrication_manifest"]
    assert manifest["cad"]["main_step_sha256"] == meta["cad_inventory"]["main_step_sha256"]

    generated_tree = ET.parse(generated_mjcf)
    actuator = generated_tree.getroot().find(".//actuator/position[@joint='left_ankle_roll_joint']")
    assert actuator is not None
    assert actuator.get("ctrlrange") == "-0.120000 0.120000"

    promotion = promote_asimov1_workspace(workspace, dry_run=True)
    assert promotion["dry_run"] is True
    assert promotion["cad_inventory"]["main_step"] == meta["main_step"]
    assert len(promotion["copies"]) == 31
    assert all(item["source_sha256"] for item in promotion["copies"])
    assert Path(workspace / "asimov_promotion_plan.json").is_file()
