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
    SCALED_8GB_MODEL,
    SCALED_8GB_RUN,
    build_scaled_8gb_report,
    defect_map_artifact,
    model_execution_trace_artifact,
    model_shard_sample_artifact,
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
    high_scenario = next(
        scenario
        for scenario in report["defect_testing"]["scenarios"]
        if scenario["scenario"] == HIGH_DEFECT_SCENARIO.name
    )
    model_shard_sample = model_shard_sample_artifact(
        config,
        SCALED_8GB_MODEL,
        high_scenario["model_load"],
    )
    high_execution = report["model_execution"][HIGH_DEFECT_SCENARIO.name]
    model_execution_trace = model_execution_trace_artifact(
        config,
        SCALED_8GB_MODEL,
        SCALED_8GB_RUN,
        HIGH_DEFECT_SCENARIO,
        high_execution,
        repair_manifest,
        model_shard_sample,
    )
    defect_map_path = out.with_name(out.stem + ".high_failure_defect_map.json")
    repair_manifest_path = out.with_name(out.stem + ".high_failure_repair_manifest.json")
    repair_rom_path = out.with_name(out.stem + ".high_failure_repair_rom.json")
    repair_rom_hex_path = out.with_name(out.stem + ".high_failure_repair_rom.hex")
    model_shard_sample_path = out.with_name(out.stem + ".high_failure_model_shard_sample.json")
    model_execution_trace_path = out.with_name(
        out.stem + ".high_failure_model_execution_trace.json"
    )
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
    model_shard_sample_path.write_text(
        json.dumps(model_shard_sample, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    model_execution_trace_path.write_text(
        json.dumps(model_execution_trace, indent=2, sort_keys=True) + "\n",
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
    report["repair_handoff"]["high_failure_model_shard_sample"]["path"] = display_path(
        model_shard_sample_path
    )
    report["repair_handoff"]["high_failure_execution_trace"]["path"] = display_path(
        model_execution_trace_path
    )
    text = json.dumps(report, indent=2, sort_keys=True) + "\n"
    out.write_text(text, encoding="utf-8")
    print(text, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
