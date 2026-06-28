#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from compiler.runtime.e1x_graph_mapper import (  # noqa: E402
    map_graph,
    parse_manifest,
    placement_to_model_spec,
)
from compiler.runtime.e1x_wafer_model import (  # noqa: E402
    HIGH_DEFECT_SCENARIO,
    NORMAL_DEFECT_SCENARIO,
    SCALED_8GB_MODEL,
    SCALED_8GB_RUN,
    build_real_graph_report,
    build_scaled_8gb_report,
    defect_map_artifact,
    model_execution_trace_artifact,
    model_shard_sample_artifact,
    real_graph_execution_trace_artifact,
    repair_manifest_artifact,
    repair_rom_artifact,
    scaled_8gb_config,
)
from scripts.chip_utils import load_json_object  # noqa: E402

DEFAULT_OUT = ROOT / "benchmarks/results/e1x-scaled-8gb-model-load.json"
DEFAULT_MANIFEST = ROOT / "benchmarks/models/llama13b-w4a8-manifest.json"
DEFAULT_REAL_GRAPH_OUT = ROOT / "benchmarks/results/e1x-real-graph-model-load.json"


def display_path(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--real-graph-out", type=Path, default=DEFAULT_REAL_GRAPH_OUT)
    return parser.parse_args()


def repair_validation_from_report(report: dict, scenario_name: str) -> dict[str, int | float | str]:
    scenario = report["defect_testing"][scenario_name]
    return repair_validation_from_scenario(scenario)


def repair_validation_from_scenario(scenario: dict) -> dict[str, int | float | str]:
    return {
        "logical_neighbor_paths_checked": int(scenario["logical_neighbor_paths_checked"]),
        "logical_neighbor_paths_total": int(scenario["logical_neighbor_paths_total"]),
        "route_check_mode": str(scenario["route_check_mode"]),
        "extra_repair_hops": int(scenario["extra_repair_hops"]),
        "max_repaired_neighbor_hops": int(scenario["max_repaired_neighbor_hops"]),
        "average_extra_hops_per_neighbor": float(scenario["average_extra_hops_per_neighbor"]),
    }


def write_real_graph_evidence(manifest_path: Path, out: Path) -> dict:
    manifest = parse_manifest(load_json_object(manifest_path))
    config = scaled_8gb_config()
    placement = map_graph(manifest, config)
    spec = placement_to_model_spec(
        manifest, placement, activation_mib=512, runtime_mib=256, metadata_mib=96
    )
    report = build_real_graph_report(placement, spec, config)
    placement_path = out.with_name(out.stem + ".placement.json")
    normal_defect_map_path = out.with_name(out.stem + ".normal_defect_map.json")
    normal_repair_manifest_path = out.with_name(out.stem + ".normal_repair_manifest.json")
    normal_repair_rom_path = out.with_name(out.stem + ".normal_repair_rom.json")
    normal_repair_rom_hex_path = out.with_name(out.stem + ".normal_repair_rom.hex")
    high_defect_map_path = out.with_name(out.stem + ".high_failure_defect_map.json")
    high_repair_manifest_path = out.with_name(out.stem + ".high_failure_repair_manifest.json")
    high_repair_rom_path = out.with_name(out.stem + ".high_failure_repair_rom.json")
    high_repair_rom_hex_path = out.with_name(out.stem + ".high_failure_repair_rom.hex")
    normal_trace_path = out.with_name(out.stem + ".normal_execution_trace.json")
    high_trace_path = out.with_name(out.stem + ".high_failure_execution_trace.json")
    normal_defect_map = defect_map_artifact(config, NORMAL_DEFECT_SCENARIO)
    high_defect_map = defect_map_artifact(config, HIGH_DEFECT_SCENARIO)
    normal_repair_manifest = repair_manifest_artifact(
        config,
        NORMAL_DEFECT_SCENARIO,
        normal_defect_map,
        validation=repair_validation_from_report(report, NORMAL_DEFECT_SCENARIO.name),
    )
    high_repair_manifest = repair_manifest_artifact(
        config,
        HIGH_DEFECT_SCENARIO,
        high_defect_map,
        validation=repair_validation_from_report(report, HIGH_DEFECT_SCENARIO.name),
    )
    normal_repair_rom = repair_rom_artifact(normal_repair_manifest)
    high_repair_rom = repair_rom_artifact(high_repair_manifest)
    normal_execution = report["model_execution_by_scenario"][NORMAL_DEFECT_SCENARIO.name]
    high_execution = report["model_execution_by_scenario"][HIGH_DEFECT_SCENARIO.name]
    normal_trace = real_graph_execution_trace_artifact(
        config,
        placement,
        spec,
        SCALED_8GB_RUN,
        NORMAL_DEFECT_SCENARIO,
        normal_execution,
        repair_hop_penalty=float(report["normal_repair_hop_penalty"]),
        route_checks=int(
            report["defect_testing"][NORMAL_DEFECT_SCENARIO.name]["logical_neighbor_paths_checked"]
        ),
    )
    high_trace = real_graph_execution_trace_artifact(
        config,
        placement,
        spec,
        SCALED_8GB_RUN,
        HIGH_DEFECT_SCENARIO,
        high_execution,
        repair_hop_penalty=float(report["high_failure_repair_hop_penalty"]),
        route_checks=int(report["high_failure_route_checks"]),
    )
    placement_path.parent.mkdir(parents=True, exist_ok=True)
    placement_path.write_text(
        json.dumps(placement, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    normal_defect_map_path.write_text(
        json.dumps(normal_defect_map, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    normal_repair_manifest_path.write_text(
        json.dumps(normal_repair_manifest, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    normal_repair_rom_path.write_text(
        json.dumps(normal_repair_rom, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    normal_repair_rom_hex_path.write_text(
        "\n".join(normal_repair_rom["words"]) + "\n",
        encoding="utf-8",
    )
    high_defect_map_path.write_text(
        json.dumps(high_defect_map, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    high_repair_manifest_path.write_text(
        json.dumps(high_repair_manifest, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    high_repair_rom_path.write_text(
        json.dumps(high_repair_rom, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    high_repair_rom_hex_path.write_text(
        "\n".join(high_repair_rom["words"]) + "\n",
        encoding="utf-8",
    )
    normal_trace_path.write_text(
        json.dumps(normal_trace, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    high_trace_path.write_text(
        json.dumps(high_trace, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    report["source_manifest"] = display_path(manifest_path)
    report["placement_artifact"] = display_path(placement_path)
    report["repair_audit_artifacts"] = {
        NORMAL_DEFECT_SCENARIO.name: {
            "defect_map": {
                "path": display_path(normal_defect_map_path),
                "schema": normal_defect_map["schema"],
                "artifact_sha256": normal_defect_map["artifact_sha256"],
                "blocked_core_count": normal_defect_map["blocked_core_count"],
                "blocked_link_count": normal_defect_map["blocked_link_count"],
            },
            "repair_manifest": {
                "path": display_path(normal_repair_manifest_path),
                "schema": normal_repair_manifest["schema"],
                "artifact_sha256": normal_repair_manifest["artifact_sha256"],
                "source_defect_map_sha256": normal_repair_manifest["source_defect_map_sha256"],
                "remapped_core_count": normal_repair_manifest["remapped_core_count"],
                "sampled_route_count": len(normal_repair_manifest["sampled_routes"]),
            },
            "repair_rom": {
                "path": display_path(normal_repair_rom_path),
                "hex_path": display_path(normal_repair_rom_hex_path),
                "schema": normal_repair_rom["schema"],
                "artifact_sha256": normal_repair_rom["artifact_sha256"],
                "source_repair_manifest_sha256": normal_repair_rom["source_repair_manifest_sha256"],
                "total_word_count": normal_repair_rom["total_word_count"],
                "rom_words_sha256": normal_repair_rom["rom_words_sha256"],
            },
        },
        HIGH_DEFECT_SCENARIO.name: {
            "defect_map": {
                "path": display_path(high_defect_map_path),
                "schema": high_defect_map["schema"],
                "artifact_sha256": high_defect_map["artifact_sha256"],
                "blocked_core_count": high_defect_map["blocked_core_count"],
                "blocked_link_count": high_defect_map["blocked_link_count"],
            },
            "repair_manifest": {
                "path": display_path(high_repair_manifest_path),
                "schema": high_repair_manifest["schema"],
                "artifact_sha256": high_repair_manifest["artifact_sha256"],
                "source_defect_map_sha256": high_repair_manifest["source_defect_map_sha256"],
                "remapped_core_count": high_repair_manifest["remapped_core_count"],
                "sampled_route_count": len(high_repair_manifest["sampled_routes"]),
            },
            "repair_rom": {
                "path": display_path(high_repair_rom_path),
                "hex_path": display_path(high_repair_rom_hex_path),
                "schema": high_repair_rom["schema"],
                "artifact_sha256": high_repair_rom["artifact_sha256"],
                "source_repair_manifest_sha256": high_repair_rom["source_repair_manifest_sha256"],
                "total_word_count": high_repair_rom["total_word_count"],
                "rom_words_sha256": high_repair_rom["rom_words_sha256"],
            },
        },
    }
    report["normal_execution_trace_artifact"] = {
        "path": display_path(normal_trace_path),
        "schema": normal_trace["schema"],
        "artifact_sha256": normal_trace["artifact_sha256"],
        "output_checksum": normal_trace["output_checksum"],
        "total_cycles": normal_trace["total_cycles"],
    }
    report["high_failure_execution_trace_artifact"] = {
        "path": display_path(high_trace_path),
        "schema": high_trace["schema"],
        "artifact_sha256": high_trace["artifact_sha256"],
        "output_checksum": high_trace["output_checksum"],
        "total_cycles": high_trace["total_cycles"],
    }
    out.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return report


def main() -> int:
    args = parse_args()
    report = build_scaled_8gb_report()
    out = args.out if args.out.is_absolute() else ROOT / args.out
    out.parent.mkdir(parents=True, exist_ok=True)
    config = scaled_8gb_config()
    defect_map = defect_map_artifact(config, HIGH_DEFECT_SCENARIO)
    high_scenario = next(
        scenario
        for scenario in report["defect_testing"]["scenarios"]
        if scenario["scenario"] == HIGH_DEFECT_SCENARIO.name
    )
    repair_manifest = repair_manifest_artifact(
        config,
        HIGH_DEFECT_SCENARIO,
        defect_map,
        validation=repair_validation_from_scenario(high_scenario),
    )
    repair_rom = repair_rom_artifact(repair_manifest)
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

    manifest_path = args.manifest if args.manifest.is_absolute() else ROOT / args.manifest
    real_graph_out = (
        args.real_graph_out if args.real_graph_out.is_absolute() else ROOT / args.real_graph_out
    )
    write_real_graph_evidence(manifest_path, real_graph_out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
