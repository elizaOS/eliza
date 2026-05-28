#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from compiler.runtime.e1x_wafer_model import (  # noqa: E402
    HIGH_DEFECT_SCENARIO,
    build_scaled_8gb_report,
    defect_map_artifact,
    repair_manifest_artifact,
    repair_rom_artifact,
    scaled_8gb_config,
)

DEFAULT_OUT = ROOT / "benchmarks/results/e1x-scaled-8gb-model-load.json"


def display_path(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    report = build_scaled_8gb_report()
    out = args.out if args.out.is_absolute() else ROOT / args.out
    out.parent.mkdir(parents=True, exist_ok=True)
    config = scaled_8gb_config()
    defect_map = defect_map_artifact(config, HIGH_DEFECT_SCENARIO)
    repair_manifest = repair_manifest_artifact(config, HIGH_DEFECT_SCENARIO, defect_map)
    repair_rom = repair_rom_artifact(repair_manifest)
    defect_map_path = out.with_name(out.stem + ".high_failure_defect_map.json")
    repair_manifest_path = out.with_name(out.stem + ".high_failure_repair_manifest.json")
    repair_rom_path = out.with_name(out.stem + ".high_failure_repair_rom.json")
    repair_rom_hex_path = out.with_name(out.stem + ".high_failure_repair_rom.hex")
    defect_map_path.write_text(
        json.dumps(defect_map, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    repair_manifest_path.write_text(
        json.dumps(repair_manifest, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    repair_rom_path.write_text(
        json.dumps(repair_rom, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    repair_rom_hex_path.write_text("\n".join(repair_rom["words"]) + "\n", encoding="utf-8")
    report["repair_handoff"]["high_failure_defect_map"]["path"] = display_path(defect_map_path)
    report["repair_handoff"]["high_failure_repair_manifest"]["path"] = display_path(
        repair_manifest_path
    )
    report["repair_handoff"]["high_failure_repair_rom"]["path"] = display_path(repair_rom_path)
    report["repair_handoff"]["high_failure_repair_rom"]["hex_path"] = display_path(
        repair_rom_hex_path
    )
    text = json.dumps(report, indent=2, sort_keys=True) + "\n"
    out.write_text(text, encoding="utf-8")
    print(text, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
