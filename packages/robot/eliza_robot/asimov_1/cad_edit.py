"""Programmatic edit-workspace helpers for ASIMOV-1 CAD and MuJoCo assets."""

from __future__ import annotations

import json
import shutil
import subprocess
import xml.etree.ElementTree as ET
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from eliza_robot.asimov_1.cad import cad_inventory_dict, sha256_file
from eliza_robot.asimov_1.constants import (
    ASIMOV1_GENERATED_MANIFEST,
    ASIMOV1_GENERATED_MJCF,
    ASIMOV1_GENERATED_URDF,
    ASIMOV1_PROFILE_ASSET_ROOT,
    ASIMOV1_SUBMODULE_ROOT,
)
from eliza_robot.asimov_1.mujoco_assets import generate_asimov1_mjcf

WORKSPACE_META = "ASIMOV_EDIT_WORKSPACE.json"


@dataclass(frozen=True)
class AsimovEditWorkspace:
    workspace: str
    source_xml: str
    mesh_dir: str
    generated_mjcf: str
    generated_urdf: str
    generated_manifest: str
    vendor_commit: str
    cad_inventory: dict[str, Any]


def _run(args: list[str], cwd: Path) -> str:
    proc = subprocess.run(args, cwd=cwd, text=True, capture_output=True, check=False)
    return proc.stdout.strip()


def _copytree(src: Path, dst: Path, *, force: bool) -> None:
    if dst.exists():
        if not force:
            raise FileExistsError(f"{dst} already exists; pass --force to replace it")
        shutil.rmtree(dst)
    shutil.copytree(src, dst)


def create_asimov1_edit_workspace(workspace: Path, *, force: bool = False) -> dict[str, Any]:
    """Create a self-contained ASIMOV edit workspace from the pinned submodule.

    The workspace keeps CAD, mesh, electrical, and source MuJoCo files together
    so CAD-derived changes can be made outside the vendored gitlink and then
    regenerated/promoted intentionally.
    """
    workspace = workspace.resolve()
    workspace.mkdir(parents=True, exist_ok=True)
    _copytree(ASIMOV1_SUBMODULE_ROOT / "mechanical", workspace / "mechanical", force=force)
    _copytree(ASIMOV1_SUBMODULE_ROOT / "sim-model", workspace / "sim-model", force=force)
    if (ASIMOV1_SUBMODULE_ROOT / "electrical").is_dir():
        _copytree(ASIMOV1_SUBMODULE_ROOT / "electrical", workspace / "electrical", force=force)

    source_xml = workspace / "sim-model" / "xmls" / "asimov.xml"
    mesh_dir = workspace / "sim-model" / "assets" / "meshes"
    generated_mjcf = workspace / "generated" / "asimov-1" / "mjcf" / "asimov_eliza.xml"
    generated_urdf = workspace / "generated" / "asimov-1" / "asimov.urdf"
    generated_manifest = workspace / "generated" / "asimov-1" / "asimov_asset_manifest.json"
    vendor_commit = _run(["git", "rev-parse", "HEAD"], ASIMOV1_SUBMODULE_ROOT)
    meta = AsimovEditWorkspace(
        workspace=str(workspace),
        source_xml=str(source_xml),
        mesh_dir=str(mesh_dir),
        generated_mjcf=str(generated_mjcf),
        generated_urdf=str(generated_urdf),
        generated_manifest=str(generated_manifest),
        vendor_commit=vendor_commit,
        cad_inventory=cad_inventory_dict(),
    )
    meta_path = workspace / WORKSPACE_META
    meta_path.write_text(json.dumps(asdict(meta), indent=2) + "\n", encoding="utf-8")
    return asdict(meta)


def load_asimov1_edit_workspace(workspace: Path) -> dict[str, Any]:
    meta_path = workspace.resolve() / WORKSPACE_META
    if not meta_path.is_file():
        raise FileNotFoundError(f"{meta_path} is missing; create the workspace first")
    return json.loads(meta_path.read_text(encoding="utf-8"))


def apply_asimov1_mjcf_patch(workspace: Path, patch: dict[str, Any]) -> dict[str, Any]:
    """Apply a structured MJCF patch to the workspace source XML.

    Supported patch keys:
      - joints: {joint_name: {range: [lo, hi], damping, armature, stiffness, frictionloss}}
      - geoms: {geom_name: {pos: [x, y, z], quat: [w, x, y, z], rgba: [r, g, b, a]}}
      - comment: optional XML comment inserted before the closing mujoco tag
    """
    meta = load_asimov1_edit_workspace(workspace)
    source_xml = Path(meta["source_xml"])
    before_hash = sha256_file(source_xml)
    tree = ET.parse(source_xml)
    root = tree.getroot()
    changes: list[dict[str, Any]] = []

    for joint_name, attrs in dict(patch.get("joints", {})).items():
        joint = root.find(f".//joint[@name='{joint_name}']")
        if joint is None:
            raise ValueError(f"joint {joint_name!r} not found in ASIMOV source MJCF")
        if "range" in attrs:
            lo, hi = attrs["range"]
            joint.set("range", f"{float(lo):.6f} {float(hi):.6f}")
            changes.append(
                {
                    "type": "joint",
                    "name": joint_name,
                    "attribute": "range",
                    "value": [float(lo), float(hi)],
                }
            )
        for key in ("damping", "armature", "stiffness", "frictionloss"):
            if key in attrs:
                joint.set(key, f"{float(attrs[key]):.8g}")
                changes.append(
                    {
                        "type": "joint",
                        "name": joint_name,
                        "attribute": key,
                        "value": float(attrs[key]),
                    }
                )

    for geom_name, attrs in dict(patch.get("geoms", {})).items():
        geom = root.find(f".//geom[@name='{geom_name}']")
        if geom is None:
            raise ValueError(f"geom {geom_name!r} not found in ASIMOV source MJCF")
        for key in ("pos", "quat", "rgba"):
            if key in attrs:
                values = [float(v) for v in attrs[key]]
                geom.set(key, " ".join(f"{v:.8g}" for v in values))
                changes.append(
                    {"type": "geom", "name": geom_name, "attribute": key, "value": values}
                )

    if patch.get("comment"):
        root.append(ET.Comment(str(patch["comment"])))
        changes.append({"type": "comment", "value": str(patch["comment"])})

    ET.indent(tree, space="  ")
    tree.write(source_xml, encoding="utf-8", xml_declaration=False)
    patch_report = {
        "workspace": str(Path(meta["workspace"])),
        "source_xml": str(source_xml),
        "before_sha256": before_hash,
        "after_sha256": sha256_file(source_xml),
        "changes": changes,
    }
    (Path(meta["workspace"]) / "asimov_mjcf_patch_report.json").write_text(
        json.dumps(patch_report, indent=2) + "\n",
        encoding="utf-8",
    )
    return patch_report


def regenerate_asimov1_workspace(workspace: Path) -> dict[str, Any]:
    meta = load_asimov1_edit_workspace(workspace)
    generated = generate_asimov1_mjcf(
        source_xml=Path(meta["source_xml"]),
        output_xml=Path(meta["generated_mjcf"]),
        output_urdf=Path(meta["generated_urdf"]),
        manifest_path=Path(meta["generated_manifest"]),
        mesh_dir=Path(meta["mesh_dir"]),
    )
    report = {
        "workspace": str(Path(meta["workspace"])),
        "generated_mjcf": str(generated),
        "generated_urdf": meta["generated_urdf"],
        "generated_manifest": meta["generated_manifest"],
        "generated_mjcf_sha256": sha256_file(Path(meta["generated_mjcf"])),
        "generated_urdf_sha256": sha256_file(Path(meta["generated_urdf"])),
        "generated_manifest_sha256": sha256_file(Path(meta["generated_manifest"])),
    }
    (Path(meta["workspace"]) / "asimov_regeneration_report.json").write_text(
        json.dumps(report, indent=2) + "\n",
        encoding="utf-8",
    )
    return report


def promote_asimov1_workspace(workspace: Path, *, dry_run: bool = True) -> dict[str, Any]:
    """Promote generated workspace outputs into package profile assets."""
    meta = load_asimov1_edit_workspace(workspace)
    src_mjcf = Path(meta["generated_mjcf"])
    src_urdf = Path(meta["generated_urdf"])
    src_manifest = Path(meta["generated_manifest"])
    if not src_mjcf.is_file() or not src_urdf.is_file() or not src_manifest.is_file():
        raise FileNotFoundError("workspace outputs are missing; run regeneration first")
    copies = [
        {"source": str(src_mjcf), "dest": str(ASIMOV1_GENERATED_MJCF)},
        {"source": str(src_urdf), "dest": str(ASIMOV1_GENERATED_URDF)},
        {"source": str(src_manifest), "dest": str(ASIMOV1_GENERATED_MANIFEST)},
    ]
    for mesh in sorted(Path(meta["mesh_dir"]).glob("*.STL")):
        copies.append(
            {"source": str(mesh), "dest": str(ASIMOV1_PROFILE_ASSET_ROOT / "meshes" / mesh.name)}
        )
    if not dry_run:
        for item in copies:
            dest = Path(item["dest"])
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(item["source"], dest)
    report = {"dry_run": dry_run, "workspace": str(Path(meta["workspace"])), "copies": copies}
    (Path(meta["workspace"]) / "asimov_promotion_plan.json").write_text(
        json.dumps(report, indent=2) + "\n",
        encoding="utf-8",
    )
    return report
