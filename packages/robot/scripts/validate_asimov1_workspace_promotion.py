#!/usr/bin/env python3
"""Validate ASIMOV-1 CAD/MJCF workspace promotion evidence."""

from __future__ import annotations

import argparse
import json
import sys
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from eliza_robot.asimov_1.cad import sha256_file  # noqa: E402
from eliza_robot.asimov_1.cad_edit import WORKSPACE_META  # noqa: E402
from eliza_robot.asimov_1.constants import ASIMOV1_FULL_ACTION_DIM  # noqa: E402


def _load(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {}


def _manifest_hashes_ok(manifest: dict[str, Any]) -> bool:
    fields = (
        ("generated_mjcf", "generated_mjcf_sha256"),
        ("generated_urdf", "generated_urdf_sha256"),
    )
    for path_key, hash_key in fields:
        path = Path(str(manifest.get(path_key, "")))
        if not path.is_file() or manifest.get(hash_key) != sha256_file(path):
            return False
    return True


def _urdf_ok(path: Path) -> bool:
    if not path.is_file():
        return False
    root = ET.parse(path).getroot()
    return (
        root.get("name") == "asimov-1"
        and len(root.findall("link")) == 28
        and len(root.findall(".//mesh")) == 28
    )


def validate_workspace_promotion(workspace: Path, *, require_applied: bool = False) -> dict[str, Any]:
    workspace = workspace.resolve()
    meta = _load(workspace / WORKSPACE_META)
    patch = _load(workspace / "asimov_mjcf_patch_report.json")
    regen = _load(workspace / "asimov_regeneration_report.json")
    promotion = _load(workspace / "asimov_promotion_plan.json")
    manifest_path = Path(str(regen.get("generated_manifest", meta.get("generated_manifest", ""))))
    manifest = _load(manifest_path)
    copies = promotion.get("copies", [])
    copy_names = {Path(str(item.get("dest", ""))).name for item in copies if isinstance(item, dict)}
    source_hashes_ok = all(
        isinstance(item, dict)
        and Path(str(item.get("source", ""))).is_file()
        and item.get("source_sha256") == sha256_file(Path(str(item["source"])))
        for item in copies
    ) if isinstance(copies, list) and copies else False
    applied_hashes_ok = all(
        isinstance(item, dict)
        and item.get("dest_exists") is True
        and item.get("hash_match") is True
        and Path(str(item.get("dest", ""))).is_file()
        and item.get("dest_sha256") == sha256_file(Path(str(item["dest"])))
        for item in copies
    ) if isinstance(copies, list) and copies else False
    checks = {
        "workspace_meta": bool(meta) and Path(str(meta.get("source_xml", ""))).is_file(),
        "patch_report": bool(patch)
        and patch.get("before_sha256") != patch.get("after_sha256")
        and bool(patch.get("changes")),
        "regeneration_report": bool(regen)
        and Path(str(regen.get("generated_mjcf", ""))).is_file()
        and Path(str(regen.get("generated_urdf", ""))).is_file()
        and manifest_path.is_file(),
        "manifest_profile": manifest.get("profile_id") == "asimov-1",
        "manifest_model": manifest.get("model", {}).get("nu") == ASIMOV1_FULL_ACTION_DIM,
        "manifest_hashes": _manifest_hashes_ok(manifest),
        "urdf": _urdf_ok(Path(str(manifest.get("generated_urdf", "")))),
        "promotion_report": bool(promotion) and isinstance(copies, list) and len(copies) == 31,
        "promotion_targets": {
            "asimov_eliza.xml",
            "asimov.urdf",
            "asimov_asset_manifest.json",
        }.issubset(copy_names),
        "promotion_source_hashes": source_hashes_ok,
        "promotion_applied_hashes": applied_hashes_ok if require_applied else True,
    }
    return {
        "ok": all(checks.values()),
        "profile_id": "asimov-1",
        "workspace": str(workspace),
        "require_applied": require_applied,
        "checks": checks,
        "promotion": {
            "dry_run": promotion.get("dry_run"),
            "copy_count": len(copies) if isinstance(copies, list) else 0,
        },
        "generated": {
            "mjcf": manifest.get("generated_mjcf"),
            "urdf": manifest.get("generated_urdf"),
            "manifest": str(manifest_path),
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--require-applied", action="store_true")
    args = parser.parse_args()
    report = validate_workspace_promotion(args.workspace, require_applied=args.require_applied)
    print(json.dumps(report, indent=2))
    return 0 if report["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
