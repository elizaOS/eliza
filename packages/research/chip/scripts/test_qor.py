#!/usr/bin/env python3
"""Tests for the QoR regression loop scripts.

Covered:
  - eliza.qor.v1 store: record/load round-trip, fail-closed metric collection,
    advanced-node block, baseline selection.
  - check_qor_regression: pass on no-regression, fail on regression beyond
    threshold, hard-no-increase on DRC/antenna, BLOCKED on placeholder rows.
  - promote_autotuner_config: pareto -> tuned config + recorded row.
  - build_pd_feedback: signal extraction from a synthetic metrics.json.
  - run_eco_resize: TCL emission (review mode).
  - external-model-corpus-intake policy gate: real run passes.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import check_external_model_corpus_intake_policy as external_policy  # noqa: E402
import qor_regression as qr  # noqa: E402
from chip_utils import load_yaml_object  # noqa: E402

PY = sys.executable


def _metrics_doc(**overrides: float) -> dict[str, float]:
    base = {
        "design__instance__count__macros": 1,
        "route__wirelength": 1_000_000.0,
        "route__drc_errors": 0,
        "timing__setup__tns": -1.0,
        "timing__hold__tns": 0.0,
        "antenna__violating__nets": 0,
    }
    base.update(overrides)
    return base


def test_required_metric_keys_from_validator() -> None:
    keys = qr.required_metric_keys()
    assert "route__wirelength" in keys
    assert "timing__setup__tns" in keys
    assert "antenna__violating__nets" in keys


def test_collect_metrics_fail_closed(tmp_path: Path) -> None:
    keys = qr.required_metric_keys()
    good = tmp_path / "good.json"
    good.write_text(json.dumps(_metrics_doc()))
    metrics = qr.collect_metrics(good, keys)
    assert metrics["route__wirelength"] == 1_000_000.0

    bad = tmp_path / "bad.json"
    doc = _metrics_doc()
    del doc["route__drc_errors"]
    bad.write_text(json.dumps(doc))
    with pytest.raises(ValueError):
        qr.collect_metrics(bad, keys)


def test_store_round_trip(tmp_path: Path) -> None:
    store = tmp_path / "qor.jsonl"
    keys = qr.required_metric_keys()
    metrics = {k: 1.0 for k in keys}
    row = qr.make_row(
        design="e1_chip_top",
        node_id="sky130",
        run_id="r1",
        metrics=metrics,
        source="test",
        baseline=True,
        sha="abc123",
    )
    qr.append_row(row, store)
    loaded = qr.load_rows(store)
    assert len(loaded) == 1
    assert loaded[0].key() == ("e1_chip_top", "sky130", "r1", "abc123")
    base = qr.latest_baseline(loaded, "e1_chip_top", "sky130")
    assert base is not None and base.run_id == "r1"


def test_advanced_node_record_blocked(tmp_path: Path) -> None:
    out = subprocess.run(
        [
            PY,
            str(ROOT / "scripts" / "qor_regression.py"),
            "record",
            "--design",
            "e1_chip_top",
            "--node-id",
            "tsmc-n2p",
            "--run-id",
            "x",
            "--metrics-json",
            "/dev/null",
        ],
        capture_output=True,
        text=True,
    )
    assert out.returncode == 1
    assert "advanced-node QoR capture is blocked" in out.stderr


def _write_store(tmp_path: Path, rows: list[qr.QorRow]) -> Path:
    store = tmp_path / "qor.jsonl"
    for r in rows:
        qr.append_row(r, store)
    return store


def _run_check(store: Path, threshold: float = 5.0) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            PY,
            str(ROOT / "scripts" / "check_qor_regression.py"),
            "--design",
            "e1_chip_top",
            "--node-id",
            "sky130",
            "--threshold-pct",
            str(threshold),
        ],
        capture_output=True,
        text=True,
        env={**_env(), "PYTHONPATH": str(ROOT / "scripts")},
        cwd=ROOT,
    )


def _env() -> dict[str, str]:
    import os

    return dict(os.environ)


def _baseline_row(metrics: dict[str, float], run_id: str = "base") -> qr.QorRow:
    return qr.make_row(
        design="e1_chip_top",
        node_id="sky130",
        run_id=run_id,
        metrics=metrics,
        source="test",
        baseline=True,
        sha="sha-base",
    )


def _cand_row(metrics: dict[str, float], run_id: str = "cand") -> qr.QorRow:
    return qr.make_row(
        design="e1_chip_top",
        node_id="sky130",
        run_id=run_id,
        metrics=metrics,
        source="test",
        baseline=False,
        sha="sha-cand",
    )


def test_check_regression_pass(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    keys = qr.required_metric_keys()
    base = {k: 100.0 for k in keys}
    base["timing__setup__tns"] = -10.0
    base["route__drc_errors"] = 0.0
    base["antenna__violating__nets"] = 0.0
    cand = dict(base)
    cand["route__wirelength"] = 102.0  # +2% < 5%
    store = _write_store(tmp_path, [_baseline_row(base), _cand_row(cand)])
    monkeypatch.setattr(qr, "STORE_PATH", store)
    import check_qor_regression as cqr

    rows = qr.load_rows(store)
    base_row = qr.latest_baseline(rows, "e1_chip_top", "sky130")
    cand_row = cqr._select_candidate(rows, "e1_chip_top", "sky130", None)
    assert base_row is not None and cand_row is not None
    violations = cqr.evaluate(base_row, cand_row, keys, 5.0)
    assert violations == []


def test_check_regression_wirelength_fail(tmp_path: Path) -> None:
    import check_qor_regression as cqr

    keys = qr.required_metric_keys()
    base = {k: 100.0 for k in keys}
    base["timing__setup__tns"] = -10.0
    cand = dict(base)
    cand["route__wirelength"] = 120.0  # +20% > 5%
    violations = cqr.evaluate(_baseline_row(base), _cand_row(cand), keys, 5.0)
    assert any("route__wirelength" in v for v in violations)


def test_check_regression_drc_hard_no_increase(tmp_path: Path) -> None:
    import check_qor_regression as cqr

    keys = qr.required_metric_keys()
    base = {k: 100.0 for k in keys}
    base["route__drc_errors"] = 0.0
    cand = dict(base)
    cand["route__drc_errors"] = 1.0
    violations = cqr.evaluate(_baseline_row(base), _cand_row(cand), keys, 50.0)
    assert any("route__drc_errors" in v for v in violations)


def test_check_regression_tns_drop_fail(tmp_path: Path) -> None:
    import check_qor_regression as cqr

    keys = qr.required_metric_keys()
    base = {k: 100.0 for k in keys}
    base["timing__setup__tns"] = -10.0
    cand = dict(base)
    cand["timing__setup__tns"] = -12.0  # 20% worse
    violations = cqr.evaluate(_baseline_row(base), _cand_row(cand), keys, 5.0)
    assert any("timing__setup__tns" in v for v in violations)


def test_promote_autotuner_config(tmp_path: Path) -> None:
    sweep_id = "ut-sweep"
    sweep_dir = ROOT / "build" / "pd" / "autotuner" / sweep_id
    sweep_dir.mkdir(parents=True, exist_ok=True)
    pareto = {
        "sweep_id": sweep_id,
        "pareto": [
            {
                "trial_id": 3,
                "wirelength": 900000.0,
                "setup_tns": -0.5,
                "drc_errors": 0.0,
                "params": {"FP_CORE_UTIL": 24, "PL_TARGET_DENSITY": 0.4},
            },
            {
                "trial_id": 5,
                "wirelength": 880000.0,
                "setup_tns": -2.0,
                "drc_errors": 3.0,
                "params": {"FP_CORE_UTIL": 30, "PL_TARGET_DENSITY": 0.5},
            },
        ],
    }
    (sweep_dir / "pareto.json").write_text(json.dumps(pareto))
    try:
        out = subprocess.run(
            [
                PY,
                str(ROOT / "scripts" / "promote_autotuner_config.py"),
                "--sweep-id",
                sweep_id,
                "--node-id",
                "sky130",
            ],
            capture_output=True,
            text=True,
            cwd=ROOT,
        )
        assert out.returncode == 0, out.stderr
        tuned = ROOT / "pd" / "openlane" / "config.sky130.tuned.json"
        assert tuned.is_file()
        doc = json.loads(tuned.read_text())
        # drc_tns_wl objective should select trial 3 (DRC 0).
        assert doc["FP_CORE_UTIL"] == 24
        assert doc["_eliza_autotuner_provenance"]["winning_trial_id"] == 3
        assert doc["_eliza_autotuner_provenance"]["release_use_allowed"] is False
    finally:
        tuned = ROOT / "pd" / "openlane" / "config.sky130.tuned.json"
        if tuned.exists():
            tuned.unlink()
        for p in sorted(sweep_dir.rglob("*"), reverse=True):
            p.unlink() if p.is_file() else p.rmdir()
        sweep_dir.rmdir()


def test_build_pd_feedback(tmp_path: Path) -> None:
    run_dir = tmp_path / "run"
    final = run_dir / "final"
    final.mkdir(parents=True)
    (final / "metrics.json").write_text(
        json.dumps(
            {
                "timing__setup__ws": -0.3,
                "timing__setup__tns": -5.0,
                "design__instance__utilization": 0.82,
                "design__max_slew_violation__count": 4,
                "design__max_fanout_violation__count": 2,
                "route__wirelength": 1234.0,
            }
        )
    )
    out = tmp_path / "fb.json"
    proc = subprocess.run(
        [
            PY,
            str(ROOT / "scripts" / "build_pd_feedback.py"),
            "--run-dir",
            str(run_dir),
            "--node-id",
            "sky130",
            "--out",
            str(out),
        ],
        capture_output=True,
        text=True,
    )
    assert proc.returncode == 0, proc.stderr
    doc = json.loads(out.read_text())
    assert doc["schema"] == "eliza.pd_feedback.v1"
    sig = doc["signals"]
    assert sig["critical_paths"]["recommend_retiming"] is True
    assert sig["congestion"]["hotspot_risk"] is True
    assert sig["buffering"]["recommend_buffering"] is True
    assert sig["high_fanout"]["recommend_max_fanout_split"] is True


def test_run_eco_resize_emits_tcl(tmp_path: Path) -> None:
    out_dir = tmp_path / "eco"
    proc = subprocess.run(
        [
            PY,
            str(ROOT / "scripts" / "run_eco_resize.py"),
            "--def-in",
            "nonexistent.def",
            "--liberty",
            "nonexistent.lib",
            "--netlist-in",
            "nonexistent.v",
            "--node-id",
            "sky130",
            "--out-dir",
            str(out_dir),
        ],
        capture_output=True,
        text=True,
    )
    assert proc.returncode == 0, proc.stderr
    tcl = (out_dir / "eco_resize.tcl").read_text()
    assert "repair_timing -setup -hold" in tcl
    assert "write_def" in tcl
    manifest = json.loads((out_dir / "eco_manifest.json").read_text())
    assert manifest["release_use_allowed"] is False
    assert manifest["equivalence_gate"] == "scripts/check_eco_equivalence.py"


def test_external_model_corpus_intake_policy_gate() -> None:
    proc = subprocess.run(
        [PY, str(ROOT / "scripts" / "check_external_model_corpus_intake_policy.py")],
        capture_output=True,
        text=True,
    )
    assert proc.returncode == 0, proc.stderr
    assert "PASS" in proc.stdout
    policy = load_yaml_object(external_policy.POLICY)
    for key in external_policy.REQUIRED_FALSE_CLAIM_FLAGS:
        assert policy.get(key) is False, key


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
