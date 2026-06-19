"""CAD inventory helpers for the vendored ASIMOV-1 assets."""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass
from pathlib import Path

from eliza_robot.asimov_1.constants import (
    ASIMOV1_FABRICATION_MANIFEST,
    ASIMOV1_MAIN_STEP,
    ASIMOV1_MECHANICAL_ROOT,
    ASIMOV1_SOURCE_MESH_DIR,
    ASIMOV1_SOURCE_XML,
)


@dataclass(frozen=True)
class AsimovCadInventory:
    ok: bool
    main_step: str
    main_step_sha256: str | None
    source_xml: str
    source_xml_sha256: str | None
    mesh_dir: str
    fabrication_manifest: str
    fabrication_manifest_sha256: str | None
    step_count: int
    stl_count: int
    mesh_count: int
    cad_entries: int
    fabrication_classes: dict[str, int]
    subassemblies: list[str]
    step_files: list[str]
    stl_files: list[str]


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def validate_cad_tree(
    *,
    mechanical_root: Path = ASIMOV1_MECHANICAL_ROOT,
    main_step: Path = ASIMOV1_MAIN_STEP,
    source_xml: Path = ASIMOV1_SOURCE_XML,
    mesh_dir: Path = ASIMOV1_SOURCE_MESH_DIR,
    fabrication_manifest: Path = ASIMOV1_FABRICATION_MANIFEST,
) -> AsimovCadInventory:
    steps = sorted(mechanical_root.rglob("*.STEP")) + sorted(
        mechanical_root.rglob("*.step")
    )
    stls = sorted(mesh_dir.glob("*.STL"))
    mesh_files = sorted(p for p in mesh_dir.iterdir() if p.is_file()) if mesh_dir.is_dir() else []
    subassemblies = sorted(
        p.name for p in mechanical_root.iterdir() if p.is_dir() and p.name.isdigit()
    ) if mechanical_root.is_dir() else []
    cad_entries = 0
    fabrication_classes: dict[str, int] = {}
    if fabrication_manifest.is_file():
        try:
            raw = json.loads(fabrication_manifest.read_text(encoding="utf-8"))
            if isinstance(raw, list):
                cad_entries = len(raw)
            elif isinstance(raw, dict):
                entries = raw.get("entries")
                if isinstance(entries, list):
                    cad_entries = int(raw.get("entry_count") or len(entries))
                    for entry in entries:
                        if not isinstance(entry, dict):
                            continue
                        klass = str(entry.get("fabrication_class") or entry.get("class") or "unknown")
                        fabrication_classes[klass] = fabrication_classes.get(klass, 0) + 1
                else:
                    parts = raw.get("parts")
                    cad_entries = len(parts) if isinstance(parts, list | dict) else len(raw)
                declared_classes = raw.get("fabrication_classes")
                if isinstance(declared_classes, dict):
                    fabrication_classes.update({str(k): int(v) for k, v in declared_classes.items()})
        except Exception:
            cad_entries = 0
    ok = (
        main_step.is_file()
        and source_xml.is_file()
        and fabrication_manifest.is_file()
        and len(steps) > 0
        and len(stls) > 0
    )
    return AsimovCadInventory(
        ok=ok,
        main_step=str(main_step),
        main_step_sha256=sha256_file(main_step) if main_step.is_file() else None,
        source_xml=str(source_xml),
        source_xml_sha256=sha256_file(source_xml) if source_xml.is_file() else None,
        mesh_dir=str(mesh_dir),
        fabrication_manifest=str(fabrication_manifest),
        fabrication_manifest_sha256=sha256_file(fabrication_manifest)
        if fabrication_manifest.is_file()
        else None,
        step_count=len(steps),
        stl_count=len(stls),
        mesh_count=len(mesh_files),
        cad_entries=cad_entries or len(steps),
        fabrication_classes=fabrication_classes,
        subassemblies=subassemblies,
        step_files=[str(p.relative_to(mechanical_root)) for p in steps],
        stl_files=[p.name for p in stls],
    )


def cad_inventory_dict(**kwargs) -> dict:
    return asdict(validate_cad_tree(**kwargs))
