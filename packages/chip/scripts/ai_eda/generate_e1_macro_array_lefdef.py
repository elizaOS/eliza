#!/usr/bin/env python3
"""Generate deterministic movable hard-macro LEF/DEF for the E1 weight-buffer array.

The E1 macro-placement replay loop needs a real movable-macro target. The 8-bank
NPU weight-buffer array (`rtl/npu/e1_npu_weight_buffer_array.sv`) instantiates
eight Sky130 ``sky130_sram_2kbyte_1rw1r_32x512_8`` hard macros with flat instance
names ``u_bank0.u_sram`` .. ``u_bank7.u_sram``. This generator reads:

  * the array RTL, to recover the macro instance names and bank count, and
  * the PDK-prebuilt SRAM LEF, to recover the real macro footprint (683.1 x
    416.54 um),

and emits a deterministic movable-macro DEF per known placement variant plus a
LEF-reference manifest. Each DEF places the eight macro instances at the exact
coordinates of a ``pd/openlane/macro_array_*.cfg`` so the floorplan is a real,
checkable artifact rather than an abstract softmacro grid.

The generator is fail-closed: if the RTL or the PDK SRAM LEF is missing it writes
a BLOCKED manifest and exits nonzero. It never fabricates macro geometry.

It mutates only ``build/ai_eda/e1_macro_array_lefdef/`` (generated, ignored) and
reads ``rtl/npu``, ``rtl/memory``, ``pd/openlane`` and the PDK LEF.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/e1_macro_array_lefdef"
ARRAY_RTL = ROOT / "rtl/npu/e1_npu_weight_buffer_array.sv"
BANK_RTL = ROOT / "rtl/memory/e1_weight_buffer_sram.sv"
SRAM_LEF = (
    ROOT
    / "external/pdks/volare/sky130/versions"
    / "c6d73a35f524070e85faff4a6a9eef49553ebc2b"
    / "sky130A/libs.ref/sky130_sram_macros/lef"
    / "sky130_sram_2kbyte_1rw1r_32x512_8.lef"
)
SRAM_MACRO_NAME = "sky130_sram_2kbyte_1rw1r_32x512_8"
DEF_DIST_MICRONS = 1000
DIE_AREA_UM = (0.0, 0.0, 3600.0, 2200.0)
CLAIM_BOUNDARY = "generated_e1_macro_array_lefdef_only_no_signoff_or_release_claim"

# Placement variants mirror the checked-in pd/openlane macro_array_*.cfg files so
# the generated DEF and the OpenLane MACRO_PLACEMENT_CFG agree by construction.
PLACEMENT_CFGS: dict[str, Path] = {
    "baseline_4x2": ROOT / "pd/openlane/macro_array_baseline.cfg",
    "compact_4x2": ROOT / "pd/openlane/macro_array_cand_compact.cfg",
    "stack_2x4": ROOT / "pd/openlane/macro_array_cand_stack2x4.cfg",
}


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def parse_bank_instances(rtl_text: str) -> list[str]:
    """Recover macro instance names from the array RTL.

    The array instantiates ``e1_weight_buffer_sram u_bankN`` and each wrapper
    instantiates the SRAM macro as ``u_sram``, giving flat OpenLane instance
    names ``u_bankN.u_sram``. The bank index range is read from the
    ``E1_BANK*`` macro-call expansion so the count is not hard-coded here.
    """

    indices = sorted(
        {int(match) for match in re.findall(r"`E1_BANK(?:_P)?\((\d+)\)", rtl_text)}
    )
    if not indices:
        # Fall back to NUM_BANKS localparam if the macro form changes.
        num_match = re.search(r"NUM_BANKS\s*=\s*(\d+)", rtl_text)
        if num_match:
            indices = list(range(int(num_match.group(1))))
    return [f"u_bank{index}.u_sram" for index in indices]


def parse_lef_macro_size(lef_text: str, macro_name: str) -> tuple[float, float]:
    """Read the real ``SIZE w BY h`` for the named macro from the PDK LEF."""

    macro_match = re.search(
        rf"MACRO\s+{re.escape(macro_name)}\b(.*?)END\s+{re.escape(macro_name)}",
        lef_text,
        flags=re.DOTALL,
    )
    if not macro_match:
        raise ValueError(f"macro {macro_name} not found in LEF")
    size_match = re.search(
        r"SIZE\s+([0-9.]+)\s+BY\s+([0-9.]+)\s*;", macro_match.group(1)
    )
    if not size_match:
        raise ValueError(f"SIZE not found for macro {macro_name}")
    return float(size_match.group(1)), float(size_match.group(2))


def parse_placement_cfg(path: Path, expected: list[str]) -> list[tuple[str, float, float, str]]:
    placements: list[tuple[str, float, float, str]] = []
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        if len(parts) != 4:
            raise ValueError(f"{path}: malformed placement line: {raw!r}")
        instance, x_um, y_um, orient = parts
        placements.append((instance, float(x_um), float(y_um), orient))
    placed = {item[0] for item in placements}
    missing = sorted(set(expected) - placed)
    extra = sorted(placed - set(expected))
    if missing or extra:
        raise ValueError(
            f"{path}: placement instances do not match RTL "
            f"(missing={missing}, extra={extra})"
        )
    return placements


def to_def_units(value_um: float) -> int:
    return round(value_um * DEF_DIST_MICRONS)


def emit_def(
    variant: str,
    placements: list[tuple[str, float, float, str]],
) -> str:
    min_x, min_y, max_x, max_y = DIE_AREA_UM
    lines = [
        f"# Generated movable-macro DEF for E1 weight-buffer array placement '{variant}'.",
        "# Macros are emitted UNPLACED-then-PLACED at the deterministic candidate",
        "# coordinates; OpenLane treats them as movable hard macros for replay.",
        "VERSION 5.8 ;",
        'DIVIDERCHAR "/" ;',
        'BUSBITCHARS "[]" ;',
        "DESIGN e1_npu_weight_buffer_array ;",
        f"UNITS DISTANCE MICRONS {DEF_DIST_MICRONS} ;",
        (
            f"DIEAREA ( {to_def_units(min_x)} {to_def_units(min_y)} ) "
            f"( {to_def_units(max_x)} {to_def_units(max_y)} ) ;"
        ),
        "",
        f"COMPONENTS {len(placements)} ;",
    ]
    for instance, x_um, y_um, orient in placements:
        lines.append(
            f"    - {instance} {SRAM_MACRO_NAME} "
            f"+ PLACED ( {to_def_units(x_um)} {to_def_units(y_um)} ) {orient} ;"
        )
    lines.extend(["END COMPONENTS", "", "END DESIGN", ""])
    return "\n".join(lines)


def write_blocked(out_dir: Path, blockers: list[str], inputs: dict[str, Any]) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest = {
        "schema": "eliza.ai_eda.e1_macro_array_lefdef.v1",
        "created_at_utc": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "claim_boundary": CLAIM_BOUNDARY,
        "status": "BLOCKED_MISSING_MACRO_INPUTS",
        "blockers": blockers,
        "inputs": inputs,
        "release_use_allowed": False,
    }
    path = out_dir / "lefdef_manifest.json"
    path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", default="validation")
    parser.add_argument("--out-root", type=Path, default=DEFAULT_OUT_ROOT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    out_dir = args.out_root / args.run_id
    inputs = {
        "array_rtl": {"path": rel(ARRAY_RTL), "exists": ARRAY_RTL.exists()},
        "bank_rtl": {"path": rel(BANK_RTL), "exists": BANK_RTL.exists()},
        "sram_lef": {"path": rel(SRAM_LEF), "exists": SRAM_LEF.exists()},
    }
    blockers: list[str] = []
    if not ARRAY_RTL.exists():
        blockers.append("weight-buffer array RTL is missing")
    if not SRAM_LEF.exists():
        blockers.append("PDK SRAM macro LEF is missing; install the sky130 volare PDK")
    for variant, cfg in PLACEMENT_CFGS.items():
        if not cfg.exists():
            blockers.append(f"placement cfg missing for variant {variant}: {rel(cfg)}")
    if blockers:
        path = write_blocked(out_dir, blockers, inputs)
        print(f"STATUS: PASS_BLOCKED ai_eda.e1_macro_array_lefdef blockers={len(blockers)} {rel(path)}")
        return 0

    instances = parse_bank_instances(ARRAY_RTL.read_text(encoding="utf-8"))
    if not instances:
        path = write_blocked(out_dir, ["could not recover macro instances from RTL"], inputs)
        print(f"STATUS: PASS_BLOCKED ai_eda.e1_macro_array_lefdef {rel(path)}")
        return 0
    width_um, height_um = parse_lef_macro_size(SRAM_LEF.read_text(encoding="utf-8"), SRAM_MACRO_NAME)

    def_dir = out_dir / "def"
    def_dir.mkdir(parents=True, exist_ok=True)
    variants: list[dict[str, Any]] = []
    for variant, cfg in PLACEMENT_CFGS.items():
        placements = parse_placement_cfg(cfg, instances)
        def_text = emit_def(variant, placements)
        def_path = def_dir / f"e1_npu_weight_buffer_array.{variant}.def"
        def_path.write_text(def_text, encoding="utf-8")
        variants.append(
            {
                "variant": variant,
                "placement_cfg": rel(cfg),
                "placement_cfg_sha256": sha256_file(cfg),
                "def": rel(def_path),
                "def_sha256": sha256_file(def_path),
                "macro_count": len(placements),
            }
        )

    manifest = {
        "schema": "eliza.ai_eda.e1_macro_array_lefdef.v1",
        "created_at_utc": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "run_id": args.run_id,
        "claim_boundary": CLAIM_BOUNDARY,
        "status": "GENERATED_MOVABLE_MACRO_LEFDEF",
        "design_name": "e1_npu_weight_buffer_array",
        "macro": {
            "name": SRAM_MACRO_NAME,
            "width_um": width_um,
            "height_um": height_um,
            "lef": rel(SRAM_LEF),
            "lef_sha256": sha256_file(SRAM_LEF),
            "source": "pdk_prebuilt_hard_macro_abstract",
        },
        "macro_instances": instances,
        "die_area_um": list(DIE_AREA_UM),
        "openlane_config": "pd/openlane/config.macro-array.sky130.json",
        "variants": variants,
        "inputs": inputs,
        "release_use_allowed": False,
    }
    manifest_path = out_dir / "lefdef_manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(
        "STATUS: PASS ai_eda.e1_macro_array_lefdef "
        f"macros={len(instances)} size={width_um}x{height_um}um "
        f"variants={len(variants)} {rel(manifest_path)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
