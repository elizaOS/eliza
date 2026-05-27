from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from compiler.runtime.e1x_wafer_model import E1XConfig, build_e1x_report, deterministic_defects

ROOT = Path(__file__).resolve().parents[1]


def test_e1x_defect_repair_preserves_logical_mesh() -> None:
    config = E1XConfig()
    report = build_e1x_report(config)

    assert report["schema"] == "eliza.e1x.wafer_mesh_model.v1"
    assert report["defect_testing"]["repaired_logical_mesh"] is True
    assert report["defect_testing"]["logical_neighbor_paths_checked"] == (
        config.logical_rows * (config.logical_cols - 1)
        + config.logical_cols * (config.logical_rows - 1)
    )
    assert report["defect_testing"]["max_repaired_neighbor_hops"] >= 1
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
    assert all(link.a.row < config.physical_rows and link.b.row < config.physical_rows for link in blocked_links)
    assert all(link.a.col < config.physical_cols and link.b.col < config.physical_cols for link in blocked_links)


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
