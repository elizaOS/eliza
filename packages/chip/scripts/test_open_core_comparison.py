#!/usr/bin/env python3
"""Tests for the E1-vs-open-RISC-V comparison dataset and its gate."""

from __future__ import annotations

from pathlib import Path

import yaml
from check_open_core_comparison import COMPARISON_PATH, check

ROOT = Path(__file__).resolve().parents[1]


def _data() -> dict:
    return yaml.safe_load(COMPARISON_PATH.read_text())


def test_checker_passes_on_real_dataset() -> None:
    assert check(COMPARISON_PATH) == []


def test_little_core_is_cva6() -> None:
    cores = _data()["cores"]
    assert cores["e1_pro"]["identical_to"] == "cva6"
    assert cores["e1_pro"]["isa"] == cores["cva6"]["isa"] == "RV64GC"


def test_bpu_axis_is_a_measured_win() -> None:
    verdict = _data()["e1_vs_ariane_verdict"]["branch_prediction"]
    assert verdict["verdict"] == "win"
    # The BPU axis is backed by both the behavioural head-to-head model and its
    # RTL corroboration, so the evidence is a list of paths.
    evidence = verdict["evidence"]
    assert isinstance(evidence, list)
    assert "docs/evidence/cpu_ap/bpu-vs-cva6-mpki.json" in evidence
    assert "docs/evidence/cpu_ap/bpu-vs-cva6-mpki-rtl.json" in evidence
    for path in evidence:
        assert (ROOT / path).exists()


def test_silicon_axis_stays_an_honest_loss() -> None:
    # E1 has no silicon; this axis must not be claimed as a win/parity until tapeout.
    assert _data()["e1_vs_ariane_verdict"]["silicon_proven_frequency"]["verdict"] == "loss"


def test_improved_axes_cite_measured_evidence() -> None:
    # Axes that moved off "loss"/"unproven" must point at an evidence file on disk.
    verdicts = _data()["e1_vs_ariane_verdict"]
    for axis in (
        "verification_maturity",
        "peak_single_thread",
        "linux_boot_readiness",
        "area_energy_efficiency",
        "vector_ai",
        "scalar_integer_throughput",
    ):
        v = verdicts[axis]
        if v["verdict"] in ("win", "parity"):
            assert v.get("evidence"), f"{axis} claims {v['verdict']} without evidence"
            assert (ROOT / v["evidence"]).exists(), f"{axis} evidence missing: {v['evidence']}"


def test_cohort_has_the_open_ceiling_core() -> None:
    cores = _data()["cores"]
    assert cores["xiangshan_kunminghu"]["open_source"] is True
    assert cores["xiangshan_kunminghu"]["microarch"]["ordering"] == "out-of-order"


def test_checker_rejects_unbacked_measured_claim(tmp_path: Path) -> None:
    data = _data()
    data["cores"]["cva6"]["metrics"]["coremark_per_mhz"] = {
        "value": 2.83,
        "claim": "measured",
        "evidence": "docs/evidence/cpu_ap/does-not-exist.json",
    }
    bad = tmp_path / "bad.yaml"
    bad.write_text(yaml.safe_dump(data))
    errors = check(bad)
    assert any("evidence file not found" in e for e in errors)


if __name__ == "__main__":
    import sys

    import pytest

    sys.exit(pytest.main([__file__, "-q"]))
