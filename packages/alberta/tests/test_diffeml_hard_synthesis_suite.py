"""Tests for the DiffEML hard-synthesis experiment harness."""

from __future__ import annotations

from pathlib import Path
from types import ModuleType
from typing import Any

import pytest
from conftest import load_script

_SCRIPT_PATH = (
    Path(__file__).resolve().parents[1]
    / "examples"
    / "The Alberta Plan"
    / "Step2"
    / "step2_diffeml_hard_synthesis_suite.py"
)

SUITE: ModuleType = load_script(_SCRIPT_PATH, "step2_diffeml_hard_synthesis_suite")


def test_smoke_matrix_shape_and_claim_rejection_rules() -> None:
    """Smoke scale should cover all requested tasks and anti-claim checks."""
    matrix = SUITE.build_matrix(scale="smoke", seeds=(0,), run_output_dir=Path("runs"))
    experiments = matrix["experiments"]

    assert matrix["schema_version"] == "diffeml.hard_synthesis_suite.v1"
    assert len(experiments) == 11
    assert {row["family"] for row in experiments} == {
        "packed_bitset_gate_synthesis",
        "ecoc_readout",
        "anf_sparse_boolean_polynomial",
        "tree_bdd_compilation",
    }
    assert {row["task_id"] for row in experiments} == {
        "xor",
        "diagonal_halfspace",
        "checkerboard",
        "small_digits_even_odd_bits",
        "small_digits_mod3_bits",
        "multiclass_ecoc_toy",
    }
    assert {rule["rule_id"] for rule in matrix["claim_rejection_rules"]} == {
        "no_float_head",
        "hard_packed_metrics_primary",
        "eml_witness_per_gate_mask",
        "same_feature_baselines_for_image_tasks",
    }

    for row in experiments:
        checks = row["claim_checks"]
        assert checks["float_head_forbidden"] is True
        assert checks["hard_packed_metrics_primary"] is True
        assert checks["eml_witness_required_for_every_gate_mask"] is True
        assert checks["primary_metric"] == "packed_hard_accuracy"

    image_rows = [row for row in experiments if row["task_kind"] == "image_bits"]
    assert image_rows
    for row in image_rows:
        assert row["claim_checks"]["same_feature_baseline_required"] is True
        assert row["claim_checks"]["same_feature_baseline_present"] is True
        assert "same_feature_mlp_accuracy" in row["baseline_columns"]


def test_commands_and_configs_are_reproducible() -> None:
    """Rows should contain direct commands and backend-facing configs."""
    specs = SUITE.build_specs(scale="smoke", seeds=(7,))
    packed_xor = next(
        spec
        for spec in specs
        if spec.family == "packed_bitset_gate_synthesis" and spec.task_id == "xor"
    )
    diagonal = next(spec for spec in specs if spec.task_id == "diagonal_halfspace")

    xor_command = SUITE.suite_command(packed_xor, output=Path("runs/xor.json"))
    diagonal_command = SUITE.suite_command(diagonal, output=Path("runs/diag.json"))
    xor_config = SUITE.experiment_config(packed_xor)

    assert "step2_diffeml_hard_synthesis_suite.py" in xor_command
    assert "--run boolean" in xor_command
    assert "--scale smoke" in xor_command
    assert "--seeds 7" in xor_command
    assert f"--experiment {packed_xor.run_id}" in xor_command
    assert "--output runs/xor.json" in xor_command
    assert "--run continuous" in diagonal_command
    assert xor_config["synthesis"]["family"] == "packed_bitset_gate_synthesis"
    assert xor_config["task"]["target_rule"] == "x0 xor x1"
    assert xor_config["claim_contract"]["forbidden_deployed_readout"] == "linear"
    assert xor_config["claim_contract"]["flags"] == []


def test_dry_run_does_not_import_backends(monkeypatch: pytest.MonkeyPatch) -> None:
    """Dry runs should validate the selected matrix without backend modules."""

    def forbidden_import(_: str) -> Any:
        raise AssertionError("dry-run should not import optional hard-synthesis backends")

    monkeypatch.setattr(SUITE.importlib, "import_module", forbidden_import)
    payload = SUITE.run_suite(
        scale="smoke",
        seeds=(0,),
        mode="boolean",
        dry_run=True,
        run_output_dir=Path("runs"),
    )

    assert payload["dry_run"] is True
    assert payload["runs"]
    assert all(run["status"] == "dry_run" for run in payload["runs"])
    assert all(run["task_kind"] != "continuous" for run in payload["runs"])
    assert {run["task_id"] for run in payload["runs"]} >= {
        "xor",
        "small_digits_even_odd_bits",
        "multiclass_ecoc_toy",
    }


def test_missing_backend_is_a_skipped_record(monkeypatch: pytest.MonkeyPatch) -> None:
    """Non-dry execution should skip absent future modules instead of failing."""

    def missing_import(name: str) -> Any:
        raise ImportError(name)

    monkeypatch.setattr(SUITE.importlib, "import_module", missing_import)
    spec = SUITE.build_specs(scale="smoke", seeds=(0,))[0]
    record = SUITE.run_experiment(spec, dry_run=False, run_output_dir=Path("runs"))

    assert record["status"] == "skipped_missing_backend"
    assert record["result"] is None
    assert record["attempted_backends"]
    assert spec.required_modules[0] in record["attempted_backends"][0]


def test_real_backend_runs_packed_xor_without_float_head() -> None:
    """The suite should execute the packaged hard-synthesis backend for XOR."""
    spec = next(
        spec
        for spec in SUITE.build_specs(scale="smoke", seeds=(0,))
        if spec.family == "packed_bitset_gate_synthesis" and spec.task_id == "xor"
    )

    record = SUITE.run_experiment(spec, dry_run=False, run_output_dir=Path("runs"))
    result = record["result"]
    metrics = result["metrics"]

    assert record["status"] == "completed"
    assert record["backend"]["module"] == "alberta_framework.core.diffeml_hard_synthesis"
    assert result["status"] == "completed"
    assert metrics["packed_hard_accuracy"] == 1.0
    assert metrics["deployed_hard_accuracy"] == 1.0
    assert metrics["deploy_uses_float_head"] is False
    assert metrics["eml_witness_coverage"] is True
    assert metrics["selected_gate_masks"] == [6]


def test_checkerboard_feature_topology_makes_anf_exact() -> None:
    """Aligned grid thresholds should let a sparse ANF circuit solve checkerboard."""
    spec = next(
        spec
        for spec in SUITE.build_specs(scale="smoke", seeds=(0,))
        if spec.family == "anf_sparse_boolean_polynomial" and spec.task_id == "checkerboard"
    )

    record = SUITE.run_experiment(spec, dry_run=False, run_output_dir=Path("runs"))
    result = record["result"]
    metrics = result["metrics"]

    assert record["status"] == "completed"
    assert metrics["packed_hard_accuracy"] == 1.0
    assert metrics["deployed_hard_accuracy"] == 1.0
    assert metrics["eml_witness_coverage"] is True
    assert metrics["deploy_uses_float_head"] is False
    assert metrics["anf_term_count"] == 6


def test_checkerboard_tree_uses_deeper_effective_smoke_topology() -> None:
    """The tree backend should not leave checkerboard at a depth-4 artifact cap."""
    spec = next(
        spec
        for spec in SUITE.build_specs(scale="smoke", seeds=(0,))
        if spec.family == "tree_bdd_compilation" and spec.task_id == "checkerboard"
    )

    record = SUITE.run_experiment(spec, dry_run=False, run_output_dir=Path("runs"))
    metrics = record["result"]["metrics"]

    assert record["status"] == "completed"
    assert metrics["requested_tree_depth_budget"] == 4
    assert metrics["effective_tree_depth_budget"] == 6
    assert metrics["packed_hard_accuracy"] >= 0.95
    assert metrics["eml_witness_coverage"] is True
    assert metrics["deploy_uses_float_head"] is False


def test_cli_supports_required_run_scale_and_output_flags() -> None:
    """The requested CLI surface should parse without additional dependencies."""
    args = SUITE.parse_args(
        [
            "--run",
            "all",
            "--scale",
            "full",
            "--output",
            "out.json",
            "--dry-run",
        ]
    )

    assert args.run == "all"
    assert args.scale == "full"
    assert args.output == Path("out.json")
    assert args.dry_run is True
