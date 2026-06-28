from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from compiler.runtime.e1x3d_placement_model import (
    PEFloorplan,
    TierSplitResult,
    build_placement_report,
    evaluate_split,
    via_capacity_per_mm2,
)
from compiler.runtime.e1x3d_wafer_model import E1X3DConfig

ROOT = Path(__file__).resolve().parents[1]


def test_via_capacity_scales_with_pitch() -> None:
    # Finer pitch carries quadratically more vias; MIV is far denser than hybrid bond.
    assert via_capacity_per_mm2(6.0, 1.0e6) < via_capacity_per_mm2(1.0, 1.0e6)
    assert via_capacity_per_mm2(0.1, 30.0e6) == 30.0e6  # MIV capped at demonstrated density


def test_block_split_shrinks_xy_but_configured_bond_blocks() -> None:
    report = build_placement_report()
    block = report["tier_splits"]["block_sram_on_logic"]
    # Moving SRAM off the logic plane must shrink the XY footprint meaningfully.
    assert block["xy_footprint_shrink"] >= 0.30
    assert report["findings"]["block_fits_hybrid_bond"] is True
    assert block["configured_bonding_sufficient"] is False
    assert report["gate"]["status"] == "BLOCKED"
    assert "configured" in " ".join(report["gate"]["reasons"])


def test_fine_logic_fold_needs_finer_bonding_than_block() -> None:
    report = build_placement_report()
    block = report["tier_splits"]["block_sram_on_logic"]
    fine = report["tier_splits"]["fine_logic_fold"]
    # The research point: slicing logic across tiers explodes inter-tier via
    # density, so a fine fold needs a finer bonding pitch than a block split.
    assert fine["required_via_density_per_mm2"] > block["required_via_density_per_mm2"]
    assert fine["inter_tier_vias"] > block["inter_tier_vias"]
    assert fine["feasible_bondings"] == []
    assert fine["recommended_bonding"] is None


def test_more_memory_tiers_shrink_footprint_further() -> None:
    one: TierSplitResult = evaluate_split(
        E1X3DConfig(memory_tiers_per_core=1), _floorplan(), "block_sram_on_logic"
    )
    two: TierSplitResult = evaluate_split(
        E1X3DConfig(memory_tiers_per_core=2), _floorplan(), "block_sram_on_logic"
    )
    assert two["xy_footprint_shrink"] > one["xy_footprint_shrink"]
    assert two["inter_tier_vias"] > one["inter_tier_vias"]


def test_placement_report_records_blocked_signoff_path() -> None:
    report = build_placement_report()
    assert report["blocked_signoff_path"]["status"] == "BLOCKED"
    assert "commercial" in report["blocked_signoff_path"]["missing_dependency"].lower()
    assert report["open_prototype_path"]


def test_placement_gate_emits_blocked(tmp_path: Path) -> None:
    result = subprocess.run(
        [sys.executable, "scripts/check_e1x3d_placement.py"],
        cwd=ROOT,
        check=False,
        text=True,
        stdout=subprocess.PIPE,
    )
    assert result.returncode == 1
    assert "BLOCKED: E1X3D placement" in result.stdout
    report = json.loads((ROOT / "build/reports/e1x3d_placement.json").read_text())
    assert report["status"] == "BLOCKED"
    assert report["summary"]["failing_check_count"] == 2


def _floorplan() -> PEFloorplan:
    return PEFloorplan()
