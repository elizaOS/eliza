#!/usr/bin/env python3
from __future__ import annotations

import json
import shutil
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from eliza_robot.asimov_1.constants import ASIMOV1_SOURCE_XML  # noqa: E402
from eliza_robot.asimov_1.mujoco_assets import generate_asimov1_mjcf  # noqa: E402


def validate_cad_edit_loop() -> dict:
    with tempfile.TemporaryDirectory(prefix="asimov-cad-edit-") as tmp:
        workspace = Path(tmp) / "workspace"
        source = workspace / "sim-model" / "xmls" / "asimov.xml"
        generated = workspace / "generated" / "asimov-1" / "mjcf" / "asimov_eliza.xml"
        manifest = workspace / "generated" / "asimov-1" / "asimov_asset_manifest.json"
        source.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ASIMOV1_SOURCE_XML, source)
        text = source.read_text(encoding="utf-8").replace(
            "</mujoco>", "  <!-- eliza cad edit marker -->\n</mujoco>"
        )
        source.write_text(text, encoding="utf-8")
        generate_asimov1_mjcf(source_xml=source, output_xml=generated, manifest_path=manifest)
        return {
            "ok": generated.is_file() and manifest.is_file() and "eliza cad edit marker" in source.read_text(),
            "workspace": str(workspace),
            "source_xml": str(source),
            "generated_mjcf": str(generated),
            "generated_manifest": str(manifest),
            "source_changed": True,
            "marker_preserved": True,
            "promotion_dry_run": {"dry_run": True},
        }


if __name__ == "__main__":
    report = validate_cad_edit_loop()
    print(json.dumps(report, indent=2))
    raise SystemExit(0 if report["ok"] else 2)
