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
    source_xml: str
    mesh_dir: str
    fabrication_manifest: str
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


def validate_cad_tree() -> AsimovCadInventory:
    steps = sorted(ASIMOV1_MECHANICAL_ROOT.rglob("*.STEP")) + sorted(
        ASIMOV1_MECHANICAL_ROOT.rglob("*.step")
    )
    stls = sorted(ASIMOV1_SOURCE_MESH_DIR.glob("*.STL"))
    mesh_files = sorted(p for p in ASIMOV1_SOURCE_MESH_DIR.iterdir() if p.is_file()) if ASIMOV1_SOURCE_MESH_DIR.is_dir() else []
    subassemblies = sorted(
        p.name for p in ASIMOV1_MECHANICAL_ROOT.iterdir() if p.is_dir() and p.name.isdigit()
    ) if ASIMOV1_MECHANICAL_ROOT.is_dir() else []
    cad_entries = 0
    fabrication_classes: dict[str, int] = {}
    if ASIMOV1_FABRICATION_MANIFEST.is_file():
        try:
            raw = json.loads(ASIMOV1_FABRICATION_MANIFEST.read_text(encoding="utf-8"))
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
        ASIMOV1_MAIN_STEP.is_file()
        and ASIMOV1_SOURCE_XML.is_file()
        and ASIMOV1_FABRICATION_MANIFEST.is_file()
        and len(steps) > 0
        and len(stls) > 0
    )
    return AsimovCadInventory(
        ok=ok,
        main_step=str(ASIMOV1_MAIN_STEP),
        source_xml=str(ASIMOV1_SOURCE_XML),
        mesh_dir=str(ASIMOV1_SOURCE_MESH_DIR),
        fabrication_manifest=str(ASIMOV1_FABRICATION_MANIFEST),
        step_count=len(steps),
        stl_count=len(stls),
        mesh_count=len(mesh_files),
        cad_entries=cad_entries or len(steps),
        fabrication_classes=fabrication_classes,
        subassemblies=subassemblies,
        step_files=[str(p.relative_to(ASIMOV1_MECHANICAL_ROOT)) for p in steps],
        stl_files=[p.name for p in stls],
    )


def cad_inventory_dict() -> dict:
    return asdict(validate_cad_tree())
