from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from compiler.runtime.e1x_wafer_model import (
    HIGH_DEFECT_SCENARIO,
    SCALED_8GB_MODEL,
    SCALED_8GB_RUN,
    E1XConfig,
    build_e1x_report,
    build_scaled_8gb_report,
    defect_map_artifact,
    deterministic_defects,
    model_execution_trace_artifact,
    model_shard_sample_artifact,
    repair_manifest_artifact,
    repair_rom_artifact,
    scaled_8gb_config,
)

ROOT = Path(__file__).resolve().parents[1]


def test_e1x_defect_repair_preserves_logical_mesh() -> None:
    config = E1XConfig()
    report = build_e1x_report(config)
    expected_edges = config.logical_rows * (config.logical_cols - 1) + config.logical_cols * (
        config.logical_rows - 1
    )

    assert report["schema"] == "eliza.e1x.wafer_mesh_model.v1"
    assert report["defect_testing"]["repaired_logical_mesh"] is True
    assert report["defect_testing"]["logical_neighbor_paths_checked"] == expected_edges
    assert report["architecture"]["spare_cores"] > report["defect_testing"]["blocked_core_count"]


def test_e1x_comparison_keeps_e1_baseline_and_e1x_separate() -> None:
    report = build_e1x_report()
    comparison = report["comparison"]

    assert comparison["e1"]["basis"] == "open_2028_sota_160tops"
    assert comparison["e1x"]["logical_cores"] == report["architecture"]["logical_cores"]
    assert comparison["ratios"]["local_sram_vs_e1"] > 0
    assert report["claim_boundary"] == "architecture_simulation_only_not_rtl_not_pdk_not_silicon"


def test_e1x_small_grid_has_deterministic_defects_in_bounds() -> None:
    config = E1XConfig(logical_rows=4, logical_cols=4, spare_rows=1, spare_cols=1)
    blocked_cores, blocked_links = deterministic_defects(config)

    assert all(core.row < config.physical_rows for core in blocked_cores)
    assert all(core.col < config.physical_cols for core in blocked_cores)
    assert all(
        link.a.row < config.physical_rows and link.b.row < config.physical_rows
        for link in blocked_links
    )
    assert all(
        link.a.col < config.physical_cols and link.b.col < config.physical_cols
        for link in blocked_links
    )


def test_e1x_evidence_generator_emits_json(tmp_path: Path) -> None:
    out = tmp_path / "e1x.json"
    result = subprocess.run(
        [
            sys.executable,
            "scripts/generate_e1x_wafer_mesh_evidence.py",
            "--out",
            str(out),
            "--logical-rows",
            "8",
            "--logical-cols",
            "8",
        ],
        cwd=ROOT,
        check=True,
        text=True,
        stdout=subprocess.PIPE,
    )

    stdout_report = json.loads(result.stdout)
    file_report = json.loads(out.read_text(encoding="utf-8"))
    assert stdout_report == file_report
    assert file_report["architecture"]["logical_cores"] == 64


def test_scaled_8gb_profile_loads_quantized_model_under_high_defects() -> None:
    report = build_scaled_8gb_report()
    config = scaled_8gb_config()

    assert report["schema"] == "eliza.e1x.scaled_model_load.v1"
    assert report["architecture"]["local_sram_mib"] >= 8192
    assert report["architecture"]["logical_cores"] == config.logical_cores
    assert report["model_loaded_under_normal_defects"] == 1
    assert report["model_loaded_under_high_failure"] == 1
    assert report["high_failure_repaired_logical_mesh"] == 1
    assert report["model_run_successful"] == 1
    assert report["high_failure_prefill_ms"] > 0
    assert report["high_failure_decode_tokens_per_second"] > 0
    assert report["high_failure_output_checksum"] > 0
    execution = report["model_execution"]["high_failure_rate_repair_stress"]
    assert execution["execution_successful"] is True
    assert execution["golden_trace_match"] is True
    assert execution["decode_tokens"] == 128
    assert len(execution["layer_trace_sample"]) == 8
    assert report["high_failure_execution_trace_sha256"]
    high = report["defect_testing"]["scenarios"][1]
    assert high["scenario"] == "high_failure_rate_repair_stress"
    assert (
        high["blocked_core_count"] > report["defect_testing"]["scenarios"][0]["blocked_core_count"]
    )
    assert high["route_check_mode"] == "sampled"
    assert high["logical_neighbor_paths_checked"] >= 4096


def test_scaled_8gb_defect_map_and_repair_manifest_handoff() -> None:
    config = scaled_8gb_config()
    defect_map = defect_map_artifact(config, HIGH_DEFECT_SCENARIO)
    repair_manifest = repair_manifest_artifact(config, HIGH_DEFECT_SCENARIO, defect_map)

    assert defect_map["schema"] == "eliza.e1x.wafer_sort_defect_map.v1"
    assert repair_manifest["schema"] == "eliza.e1x.repair_manifest.v1"
    assert repair_manifest["source_defect_map_sha256"] == defect_map["artifact_sha256"]
    assert defect_map["blocked_core_count"] > 0
    assert defect_map["blocked_link_count"] > 0
    assert repair_manifest["remapped_core_count"] > 0
    assert repair_manifest["validation"]["repaired_logical_mesh"] is True
    assert len(repair_manifest["sampled_routes"]) == 64
    assert repair_manifest["sampled_routes"][0]["hops"] >= 1
    assert 0 <= int(repair_manifest["sampled_routes"][0]["first_hop_dir"]) <= 4
    repair_rom = repair_rom_artifact(repair_manifest)
    assert repair_rom["schema"] == "eliza.e1x.repair_rom.v1"
    assert repair_rom["source_repair_manifest_sha256"] == repair_manifest["artifact_sha256"]
    assert repair_rom["word_bits"] == 64
    assert repair_rom["remap_word_count"] == repair_manifest["remapped_core_count"]
    assert repair_rom["route_sample_word_count"] == len(repair_manifest["sampled_routes"])
    assert (
        repair_rom["total_word_count"]
        == 8 + repair_rom["remap_word_count"] + repair_rom["route_sample_word_count"]
    )


def test_scaled_execution_trace_links_repair_and_model_shard() -> None:
    config = scaled_8gb_config()
    report = build_scaled_8gb_report()
    defect_map = defect_map_artifact(config, HIGH_DEFECT_SCENARIO)
    repair_manifest = repair_manifest_artifact(config, HIGH_DEFECT_SCENARIO, defect_map)
    high = report["defect_testing"]["scenarios"][1]
    model_shard = model_shard_sample_artifact(config, SCALED_8GB_MODEL, high["model_load"])
    execution = report["model_execution"][HIGH_DEFECT_SCENARIO.name]

    trace = model_execution_trace_artifact(
        config,
        SCALED_8GB_MODEL,
        SCALED_8GB_RUN,
        HIGH_DEFECT_SCENARIO,
        execution,
        repair_manifest,
        model_shard,
    )

    assert trace["schema"] == "eliza.e1x.quantized_model_execution_trace.v1"
    assert trace["source_repair_manifest_sha256"] == repair_manifest["artifact_sha256"]
    assert trace["source_model_shard_sample_sha256"] == model_shard["artifact_sha256"]
    assert trace["output_checksum"] == report["high_failure_output_checksum"]
    assert trace["artifact_sha256"] == report["high_failure_execution_trace_sha256"]


def test_scaled_generator_writes_repair_handoff_sidecars(tmp_path: Path) -> None:
    out = tmp_path / "scaled.json"
    result = subprocess.run(
        [
            sys.executable,
            "scripts/generate_e1x_scaled_model_evidence.py",
            "--out",
            str(out),
        ],
        cwd=ROOT,
        check=True,
        text=True,
        stdout=subprocess.PIPE,
    )
    stdout_report = json.loads(result.stdout)
    file_report = json.loads(out.read_text(encoding="utf-8"))
    assert stdout_report == file_report

    defect_map_path = Path(file_report["repair_handoff"]["high_failure_defect_map"]["path"])
    repair_manifest_path = Path(
        file_report["repair_handoff"]["high_failure_repair_manifest"]["path"]
    )
    repair_rom_path = Path(file_report["repair_handoff"]["high_failure_repair_rom"]["path"])
    repair_rom_hex_path = Path(file_report["repair_handoff"]["high_failure_repair_rom"]["hex_path"])
    model_shard_path = Path(
        file_report["repair_handoff"]["high_failure_model_shard_sample"]["path"]
    )
    execution_trace_path = Path(
        file_report["repair_handoff"]["high_failure_execution_trace"]["path"]
    )
    if not defect_map_path.is_absolute():
        defect_map_path = ROOT / defect_map_path
    if not repair_manifest_path.is_absolute():
        repair_manifest_path = ROOT / repair_manifest_path
    if not repair_rom_path.is_absolute():
        repair_rom_path = ROOT / repair_rom_path
    if not repair_rom_hex_path.is_absolute():
        repair_rom_hex_path = ROOT / repair_rom_hex_path
    if not model_shard_path.is_absolute():
        model_shard_path = ROOT / model_shard_path
    if not execution_trace_path.is_absolute():
        execution_trace_path = ROOT / execution_trace_path
    defect_map = json.loads(defect_map_path.read_text(encoding="utf-8"))
    repair_manifest = json.loads(repair_manifest_path.read_text(encoding="utf-8"))
    repair_rom = json.loads(repair_rom_path.read_text(encoding="utf-8"))
    model_shard = json.loads(model_shard_path.read_text(encoding="utf-8"))
    execution_trace = json.loads(execution_trace_path.read_text(encoding="utf-8"))

    assert defect_map["artifact_sha256"] == file_report["high_failure_defect_map_sha256"]
    assert repair_manifest["artifact_sha256"] == file_report["high_failure_repair_manifest_sha256"]
    assert repair_manifest["source_defect_map_sha256"] == defect_map["artifact_sha256"]
    assert repair_rom["artifact_sha256"] == file_report["high_failure_repair_rom_sha256"]
    assert repair_rom["source_repair_manifest_sha256"] == repair_manifest["artifact_sha256"]
    assert repair_rom_hex_path.read_text(encoding="utf-8").splitlines() == repair_rom["words"]
    assert model_shard["artifact_sha256"] == file_report["high_failure_model_shard_sample_sha256"]
    assert execution_trace["artifact_sha256"] == file_report["high_failure_execution_trace_sha256"]
    assert execution_trace["source_repair_manifest_sha256"] == repair_manifest["artifact_sha256"]
    assert execution_trace["source_model_shard_sample_sha256"] == model_shard["artifact_sha256"]
    assert execution_trace["output_checksum"] == file_report["high_failure_output_checksum"]


def test_repair_rom_compiler_round_trips_manifest(tmp_path: Path) -> None:
    config = scaled_8gb_config()
    defect_map = defect_map_artifact(config, HIGH_DEFECT_SCENARIO)
    repair_manifest = repair_manifest_artifact(config, HIGH_DEFECT_SCENARIO, defect_map)
    manifest_path = tmp_path / "repair_manifest.json"
    out_json = tmp_path / "repair_rom.json"
    out_hex = tmp_path / "repair_rom.hex"
    manifest_path.write_text(json.dumps(repair_manifest), encoding="utf-8")

    result = subprocess.run(
        [
            sys.executable,
            "scripts/compile_e1x_repair_rom.py",
            "--manifest",
            str(manifest_path),
            "--out-json",
            str(out_json),
            "--out-hex",
            str(out_hex),
        ],
        cwd=ROOT,
        check=True,
        text=True,
        stdout=subprocess.PIPE,
    )
    stdout_rom = json.loads(result.stdout)
    file_rom = json.loads(out_json.read_text(encoding="utf-8"))

    assert stdout_rom == file_rom
    assert file_rom["source_repair_manifest_sha256"] == repair_manifest["artifact_sha256"]
    assert out_hex.read_text(encoding="utf-8").splitlines() == file_rom["words"]
