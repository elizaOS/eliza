"""Tests for the DiffEML logic-benchmark matrix harness."""

from __future__ import annotations

from pathlib import Path
from types import ModuleType

from conftest import load_script

_SCRIPT_PATH = (
    Path(__file__).resolve().parents[1]
    / "examples"
    / "The Alberta Plan"
    / "Step2"
    / "step2_diffeml_logic_benchmark.py"
)

BENCH: ModuleType = load_script(_SCRIPT_PATH, "step2_diffeml_logic_benchmark")


def test_paper_matrix_builds_matched_diffeml_runs() -> None:
    """Paper scale should cover MNIST, CIFAR threshold, and CIFAR detector runs."""
    specs = BENCH.build_diffeml_specs(scale="paper", seeds=(0, 1))
    run_ids = {spec.run_id for spec in specs}

    assert len(specs) == 6
    assert "mnist_threshold_pixels_random_w2048_l6_train60000_seed0" in run_ids
    assert "cifar_threshold_pixels_random_w2048_l6_train50000_seed0" in run_ids
    assert "cifar_detector_thresholds_random_w2048_l6_train20000_seed1" in run_ids
    assert all(spec.packed_eval for spec in specs)
    assert all(spec.compare_mlp for spec in specs)
    detector = next(
        spec
        for spec in specs
        if spec.run_id == "cifar_detector_thresholds_random_w2048_l6_train20000_seed0"
    )
    assert detector.input_bits == 24576
    assert detector.pixel_thresholds == 4
    assert detector.hard_loss_weight == 0.8
    assert detector.input_drop_rate == 0.02
    assert detector.feature_drop_rate == 0.3
    assert detector.min_temperature == 0.05


def test_diffeml_command_and_gate_budget_are_reproducible() -> None:
    """Commands should call the image demo and gate budgets should be explicit."""
    spec = BENCH.build_diffeml_specs(scale="smoke", seeds=(7,))[0]
    command = BENCH.diffeml_command(
        spec,
        output=Path("out.json"),
        data_dir=Path("data-cache"),
    )
    budget = BENCH.estimate_diffeml_gate_budget(spec)

    assert "step2_diffeml_image_demo.py" in command
    assert "--datasets digits" in command
    assert "--seed 7" in command
    assert "--packed-eval" in command
    assert "--compare-mlp" in command
    assert budget["selector_nodes"] == 192
    assert budget["eml_threshold_ops_if_expanded"] == 576
    assert budget["active_selector_logits"] == 3072


def test_external_baselines_have_explicit_provenance() -> None:
    """Known external rows must separate paper-reported and pending evidence."""
    rows = BENCH.external_baseline_rows()
    by_id = {row.row_id: row for row in rows}
    provenances = {row.provenance for row in rows}

    assert provenances == {"paper_reported", "pending"}
    assert by_id["difflogic_cifar_large_x4_paper"].accuracy == 0.6214
    assert by_id["difflogic_cifar_large_x4_paper"].gates == 5_120_000
    assert by_id["logictreenet_cifar_g_paper"].accuracy == 0.8629
    assert by_id["logictreenet_cifar_g_paper"].gates == 61_000_000
    assert by_id["difflogic_local_reproduction_pending"].accuracy is None
    assert by_id["difflogic_local_reproduction_pending"].local_command is not None


def test_acceptance_requires_local_reproduction_seed_matrix_and_margin() -> None:
    """Superiority checks should reject weak provenance and below-baseline rows."""
    baseline = BENCH.BaselineRow(
        row_id="external",
        method="External",
        family="DiffLogic",
        dataset="cifar",
        provenance="paper_reported",
        source="paper",
        accuracy=0.60,
        gates=100,
    )
    paper_candidate = BENCH.BaselineRow(
        row_id="candidate_paper",
        method="DiffEML",
        family="DiffEML",
        dataset="cifar",
        provenance="paper_reported",
        source="note",
        accuracy=0.70,
        gates=100,
    )
    weak_candidate = BENCH.BaselineRow(
        row_id="candidate_weak",
        method="DiffEML",
        family="DiffEML",
        dataset="cifar",
        provenance="local_reproduced",
        source="artifact",
        accuracy=0.59,
        gates=100,
    )
    strong_candidate = BENCH.BaselineRow(
        row_id="candidate_strong",
        method="DiffEML",
        family="DiffEML",
        dataset="cifar",
        provenance="local_reproduced",
        source="artifact",
        accuracy=0.61,
        gates=100,
    )

    assert (
        BENCH.acceptance_check(paper_candidate, baseline, observed_seeds=5).status
        == "insufficient_provenance"
    )
    assert (
        BENCH.acceptance_check(strong_candidate, baseline, observed_seeds=1).status
        == "insufficient_seeds"
    )
    packed_check = BENCH.acceptance_check(
        strong_candidate,
        baseline,
        observed_seeds=5,
        packed_matches=False,
    )
    assert packed_check.status == "packed_mismatch"
    assert (
        BENCH.acceptance_check(weak_candidate, baseline, observed_seeds=5).status
        == "below_baseline"
    )
    assert (
        BENCH.acceptance_check(weak_candidate, baseline, observed_seeds=1).status
        == "below_baseline"
    )
    accepted = BENCH.acceptance_check(strong_candidate, baseline, observed_seeds=5)
    assert accepted.status == "accepted"
    assert accepted.margin == 0.010000000000000009


def test_matrix_includes_no_claim_when_current_artifact_is_disabled() -> None:
    """A pure planning matrix should still emit baselines without local claims."""
    matrix = BENCH.build_matrix(
        scale="smoke",
        seeds=(0,),
        data_dir=Path("data"),
        run_output_dir=Path("runs"),
        current_artifact=None,
    )

    assert matrix["schema_version"] == "diffeml.logic_benchmark_matrix.v1"
    assert len(matrix["planned_diffeml_runs"]) == 1
    assert matrix["local_evidence_rows"] == []
    assert matrix["acceptance_checks"] == []


def test_matrix_checks_all_cifar_external_rows_for_current_artifact(
    tmp_path: Path,
) -> None:
    """Loaded local artifacts should be compared to each CIFAR target row."""
    artifact = tmp_path / "diffeml_result.json"
    artifact.write_text(
        """
        {
          "config": {
            "feature_mode": "detector_thresholds",
            "pixel_thresholds": 4,
            "width": 2048,
            "layers": 6,
            "seed": 0
          },
          "results": [
            {
              "dataset": "cifar",
              "data": {"train_examples": 20000, "test_examples": 5000},
              "model": {"layers": 6, "nodes": 12288, "active_node_parameters": 196608},
              "metrics": {
                "test_hard_accuracy": 0.441,
                "packed_hard_test_accuracy": 0.442
              }
            }
          ]
        }
        """,
        encoding="utf-8",
    )

    matrix = BENCH.build_matrix(
        scale="smoke",
        seeds=(0,),
        data_dir=Path("data"),
        run_output_dir=Path("runs"),
        current_artifact=artifact,
    )

    local_row = matrix["local_evidence_rows"][0]
    checked_baselines = {check["baseline_id"] for check in matrix["acceptance_checks"]}

    assert local_row["metric"] == "packed_hard_test_accuracy"
    assert local_row["accuracy"] == 0.442
    assert "difflogic_cifar_small_paper" in checked_baselines
    assert "difflogic_cifar_large_x4_paper" in checked_baselines
    assert "logictreenet_cifar_g_paper" in checked_baselines
    assert len(matrix["acceptance_checks"]) == 7
