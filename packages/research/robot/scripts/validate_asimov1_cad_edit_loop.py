#!/usr/bin/env python3
from __future__ import annotations

import json
import sys
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from eliza_robot.asimov_1.cad_edit import (  # noqa: E402
    apply_asimov1_mjcf_patch,
    create_asimov1_edit_workspace,
    promote_asimov1_workspace,
    regenerate_asimov1_workspace,
)


def validate_cad_edit_loop() -> dict:
    with tempfile.TemporaryDirectory(prefix="asimov-cad-edit-") as tmp:
        workspace = Path(tmp) / "workspace"
        edit = create_asimov1_edit_workspace(workspace, force=True)
        source = Path(edit["source_xml"])
        patch = {
            "joints": {
                "left_ankle_roll_joint": {
                    "range": [-0.12, 0.12],
                    "armature": 0.057,
                }
            },
            "comment": "eliza structured cad edit marker",
        }
        patch_report = apply_asimov1_mjcf_patch(workspace, patch)
        regen = regenerate_asimov1_workspace(workspace)
        promotion = promote_asimov1_workspace(workspace, dry_run=True)
        generated = Path(regen["generated_mjcf"])
        generated_urdf = Path(regen["generated_urdf"])
        manifest = Path(regen["generated_manifest"])
        root = ET.parse(generated).getroot()
        urdf_root = ET.parse(generated_urdf).getroot()
        actuator = root.find(".//position[@name='left_ankle_roll_joint']")
        joint = root.find(".//joint[@name='left_ankle_roll_joint']")
        manifest_data = json.loads(manifest.read_text(encoding="utf-8"))
        ctrlrange_changed = (
            actuator is not None and actuator.get("ctrlrange") == "-0.120000 0.120000"
        )
        joint_changed = (
            joint is not None
            and joint.get("range") == "-0.120000 0.120000"
            and joint.get("armature") == "0.057"
        )
        promotion_targets = {Path(item["dest"]).name for item in promotion["copies"]}
        urdf_ok = (
            urdf_root.get("name") == "asimov-1"
            and len(urdf_root.findall("link")) == 28
            and len(urdf_root.findall(".//mesh")) == 28
        )
        return {
            "ok": (
                generated.is_file()
                and generated_urdf.is_file()
                and manifest.is_file()
                and patch_report["before_sha256"] != patch_report["after_sha256"]
                and ctrlrange_changed
                and joint_changed
                and urdf_ok
                and manifest_data["model"]["nu"] == 25
                and "asimov_eliza.xml" in promotion_targets
                and "asimov.urdf" in promotion_targets
                and "asimov_asset_manifest.json" in promotion_targets
            ),
            "workspace": str(workspace),
            "source_xml": str(source),
            "generated_mjcf": str(generated),
            "generated_urdf": str(generated_urdf),
            "generated_manifest": str(manifest),
            "source_changed": patch_report["before_sha256"] != patch_report["after_sha256"],
            "structured_patch": patch_report,
            "ctrlrange_changed": ctrlrange_changed,
            "joint_changed": joint_changed,
            "urdf_ok": urdf_ok,
            "compiled_model": manifest_data["model"],
            "cad_entries": manifest_data["cad"]["cad_entries"],
            "promotion_dry_run": promotion,
        }


if __name__ == "__main__":
    report = validate_cad_edit_loop()
    print(json.dumps(report, indent=2))
    raise SystemExit(0 if report["ok"] else 2)
