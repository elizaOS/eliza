from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from compiler.runtime.e1x3d_wafer_model import (
    DEAD_TIER_SCENARIO_3D,
    DIR_DOWN,
    DIR_UP,
    HIGH_DEFECT_SCENARIO_3D,
    E1X3DConfig,
    build_e1x3d_report,
    build_scaled_e1x3d_report,
    defect_map_artifact,
    generated_defects,
    repair_manifest_artifact,
    repair_map,
    repair_rom_artifact,
    scaled_e1x3d_config,
    stack_yield_model,
    thermal_model,
)

ROOT = Path(__file__).resolve().parents[1]


def test_e1x3d_base_repairs_3d_mesh_with_z_routes() -> None:
    config = E1X3DConfig()
    report = build_e1x3d_report(config)
    assert report["schema"] == "eliza.e1x3d.stacked_mesh_model.v1"
    assert report["architecture"]["logical_tiers"] == 2
    assert report["architecture"]["local_sram_kib_per_core"] == 96
    assert report["defect_testing"]["repaired_logical_mesh"] is True
    # The 3D mesh must actually validate inter-tier (Z) neighbor routes.
    assert report["defect_testing"]["z_neighbor_paths_checked"] > 0
    assert report["architecture"]["spare_cores"] > report["defect_testing"]["blocked_core_count"]
    assert report["claim_boundary"] == "architecture_simulation_only_not_rtl_not_pdk_not_silicon"


def test_e1x3d_repair_routes_use_vertical_directions() -> None:
    config = E1X3DConfig()
    manifest = repair_manifest_artifact(config, HIGH_DEFECT_SCENARIO_3D)
    dirs = {route["first_hop_dir"] for route in manifest["sampled_routes"]}
    # Inter-tier neighbor pairs must produce UP/DOWN first hops, proving the
    # fabric routes in Z and that the repair ROM carries 3D directions.
    assert dirs & {DIR_UP, DIR_DOWN}
    assert all(0 <= int(route["first_hop_dir"]) <= 6 for route in manifest["sampled_routes"])


def test_e1x3d_packing_density_beats_planar() -> None:
    config = E1X3DConfig()
    # Two logic tiers plus ~45% XY footprint shrink must pack cores tighter than
    # a planar single-tier mesh.
    assert config.packing_density_ratio > 2.0
    assert config.core_xy_area_mm2 < config.base_core_area_mm2


def test_e1x3d_thermal_gate_fails_closed_past_ceiling() -> None:
    assert thermal_model(E1X3DConfig(logical_tiers=2))["status"] == "PASS"
    over_tiers = thermal_model(E1X3DConfig(logical_tiers=6))
    assert over_tiers["status"] == "BLOCKED"
    reasons = over_tiers["reasons"]
    assert isinstance(reasons, list)
    assert any("logic tiers" in reason for reason in reasons)
    over_density = thermal_model(E1X3DConfig(tier_power_density_w_per_mm2=2.0))
    assert over_density["status"] == "BLOCKED"


def test_e1x3d_stack_yield_gate_fails_closed_on_low_bond_yield() -> None:
    assert stack_yield_model(E1X3DConfig(), HIGH_DEFECT_SCENARIO_3D)["status"] == "PASS"
    weak = stack_yield_model(
        E1X3DConfig(bond_yield_per_interface=0.5, memory_tiers_per_core=2),
        HIGH_DEFECT_SCENARIO_3D,
    )
    assert weak["status"] == "BLOCKED"
    assert weak["stack_bond_yield"] < weak["target_stack_bond_yield"]


def test_e1x3d_dead_tier_region_reroutes_and_remaps() -> None:
    config = E1X3DConfig()
    blocked_cores, _ = generated_defects(config, DEAD_TIER_SCENARIO_3D)
    dead_tier_hits = [c for c in blocked_cores if c.tier == DEAD_TIER_SCENARIO_3D.dead_tier]
    assert dead_tier_hits, "dead-tier scenario produced no blocked cores on the target tier"
    # The localized dead-tier region must be repairable by bounded spares.
    mapping = repair_map(config, blocked_cores)
    assert len(mapping) == config.logical_cores


def test_e1x3d_scaled_profile_exceeds_planar_e1x() -> None:
    config = scaled_e1x3d_config()
    report = build_scaled_e1x3d_report(config)
    assert report["schema"] == "eliza.e1x3d.scaled_model_load.v1"
    assert report["architecture"]["logical_cores"] == config.logical_cores
    assert report["model_loaded_under_normal_defects"] == 1
    assert report["model_loaded_under_high_failure"] == 1
    assert report["model_loaded_under_dead_tier"] == 1
    assert report["high_failure_repaired_logical_mesh"] == 1
    assert report["dead_tier_repaired_logical_mesh"] == 1
    assert report["model_run_successful"] == 1
    assert report["thermal_status"] == "PASS"
    assert report["stack_yield_status"] == "PASS"
    assert report["comparison"]["ratios"]["cores_vs_e1x_planar"] >= 2.0
    assert report["comparison"]["ratios"]["sram_vs_e1x_planar"] >= 2.0


def test_e1x3d_repair_rom_uses_3d_magic_and_layout() -> None:
    config = scaled_e1x3d_config()
    defect_map = defect_map_artifact(config, HIGH_DEFECT_SCENARIO_3D)
    manifest = repair_manifest_artifact(config, HIGH_DEFECT_SCENARIO_3D, defect_map)
    rom = repair_rom_artifact(manifest)
    assert rom["schema"] == "eliza.e1x3d.repair_rom.v1"
    assert rom["magic"] == "4531334452455052"  # "E13DREPR"
    assert rom["source_repair_manifest_sha256"] == manifest["artifact_sha256"]
    assert rom["remap_word_count"] == manifest["remapped_core_count"]
    assert rom["route_sample_word_count"] == len(manifest["sampled_routes"])
    assert rom["total_word_count"] == 8 + rom["remap_word_count"] + rom["route_sample_word_count"]


def test_e1x3d_scaled_generator_writes_sidecars(tmp_path: Path) -> None:
    out = tmp_path / "scaled3d.json"
    result = subprocess.run(
        [sys.executable, "scripts/generate_e1x3d_scaled_model_evidence.py", "--out", str(out)],
        cwd=ROOT,
        check=True,
        text=True,
        stdout=subprocess.PIPE,
    )
    stdout_report = json.loads(result.stdout)
    file_report = json.loads(out.read_text(encoding="utf-8"))
    assert stdout_report == file_report

    handoff = file_report["repair_handoff"]
    defect_map_path = ROOT / handoff["high_failure_defect_map"]["path"]
    repair_rom_path = ROOT / handoff["high_failure_repair_rom"]["path"]
    repair_rom_hex_path = ROOT / handoff["high_failure_repair_rom"]["hex_path"]
    thermal_path = ROOT / file_report["thermal"]["path"]
    stack_yield_path = ROOT / file_report["stack_yield"]["path"]

    defect_map = json.loads(defect_map_path.read_text(encoding="utf-8"))
    repair_rom = json.loads(repair_rom_path.read_text(encoding="utf-8"))
    thermal = json.loads(thermal_path.read_text(encoding="utf-8"))
    stack_yield = json.loads(stack_yield_path.read_text(encoding="utf-8"))

    assert defect_map["artifact_sha256"] == file_report["high_failure_defect_map_sha256"]
    assert repair_rom["artifact_sha256"] == file_report["high_failure_repair_rom_sha256"]
    assert repair_rom_hex_path.read_text(encoding="utf-8").splitlines() == repair_rom["words"]
    assert thermal["status"] == "PASS"
    assert stack_yield["status"] == "PASS"
