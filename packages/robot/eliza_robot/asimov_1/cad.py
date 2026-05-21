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
    cad_entries: int
    subassemblies: list[str]


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
    subassemblies = sorted(
        p.name for p in ASIMOV1_MECHANICAL_ROOT.iterdir() if p.is_dir() and p.name.isdigit()
    ) if ASIMOV1_MECHANICAL_ROOT.is_dir() else []
    cad_entries = 0
    if ASIMOV1_FABRICATION_MANIFEST.is_file():
        try:
            raw = json.loads(ASIMOV1_FABRICATION_MANIFEST.read_text(encoding="utf-8"))
            if isinstance(raw, list):
                cad_entries = len(raw)
            elif isinstance(raw, dict):
                cad_entries = len(raw.get("parts", raw))
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
        cad_entries=cad_entries or len(steps),
        subassemblies=subassemblies,
    )


def cad_inventory_dict() -> dict:
    return asdict(validate_cad_tree())
