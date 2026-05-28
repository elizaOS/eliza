#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from compiler.runtime.e1x3d_wafer_model import (  # noqa: E402
    HIGH_DEFECT_SCENARIO_3D,
    SCALED_8GB_MODEL,
    build_scaled_e1x3d_report,
    defect_map_artifact,
    model_shard_sample_artifact,
    repair_manifest_artifact,
    repair_rom_artifact,
    scaled_e1x3d_config,
    stack_yield_model,
    thermal_model,
)

DEFAULT_OUT = ROOT / "benchmarks/results/e1x3d-scaled-16gb-model-load.json"


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
    config = scaled_e1x3d_config()
    report = build_scaled_e1x3d_report(config)

    defect_map = defect_map_artifact(config, HIGH_DEFECT_SCENARIO_3D)
    repair_manifest = repair_manifest_artifact(config, HIGH_DEFECT_SCENARIO_3D, defect_map)
    repair_rom = repair_rom_artifact(repair_manifest)
    high_scenario = next(
        scenario
        for scenario in report["defect_testing"]["scenarios"]
        if scenario["scenario"] == HIGH_DEFECT_SCENARIO_3D.name
    )
    model_shard_sample = model_shard_sample_artifact(
        config, SCALED_8GB_MODEL, high_scenario["model_load"]
    )
    thermal = thermal_model(config)
    stack_yield = stack_yield_model(config, HIGH_DEFECT_SCENARIO_3D)

    out = args.out if args.out.is_absolute() else ROOT / args.out
    out.parent.mkdir(parents=True, exist_ok=True)
    defect_map_path = out.with_name(out.stem + ".high_failure_defect_map.json")
    repair_manifest_path = out.with_name(out.stem + ".high_failure_repair_manifest.json")
    repair_rom_path = out.with_name(out.stem + ".high_failure_repair_rom.json")
    repair_rom_hex_path = out.with_name(out.stem + ".high_failure_repair_rom.hex")
    model_shard_sample_path = out.with_name(out.stem + ".high_failure_model_shard_sample.json")
    thermal_path = out.with_name(out.stem + ".thermal_model.json")
    stack_yield_path = out.with_name(out.stem + ".stack_yield_model.json")

    for path, artifact in (
        (defect_map_path, defect_map),
        (repair_manifest_path, repair_manifest),
        (repair_rom_path, repair_rom),
        (model_shard_sample_path, model_shard_sample),
        (thermal_path, thermal),
        (stack_yield_path, stack_yield),
    ):
        path.write_text(json.dumps(artifact, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    repair_rom_hex_path.write_text("\n".join(repair_rom["words"]) + "\n", encoding="utf-8")

    report["repair_handoff"]["high_failure_defect_map"]["path"] = display_path(defect_map_path)
    report["repair_handoff"]["high_failure_repair_manifest"]["path"] = display_path(
        repair_manifest_path
    )
    report["repair_handoff"]["high_failure_repair_rom"]["path"] = display_path(repair_rom_path)
    report["repair_handoff"]["high_failure_repair_rom"]["hex_path"] = display_path(
        repair_rom_hex_path
    )
    report["repair_handoff"]["high_failure_model_shard_sample"]["path"] = display_path(
        model_shard_sample_path
    )
    report["thermal"]["path"] = display_path(thermal_path)
    report["stack_yield"]["path"] = display_path(stack_yield_path)

    text = json.dumps(report, indent=2, sort_keys=True) + "\n"
    out.write_text(text, encoding="utf-8")
    print(text, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
