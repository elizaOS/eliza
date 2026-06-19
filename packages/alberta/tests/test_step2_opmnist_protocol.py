"""Artifact-level protocol checks for the Step 2 OPMNIST audit."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, cast

REPO_ROOT = Path(__file__).resolve().parents[1]
RESULTS_PATH = (
    REPO_ROOT
    / "outputs"
    / "step2_canonical"
    / "opmnist_true_mnist_40block_mse_results.json"
)
PUBLISHED_RESULTS_PATH = (
    REPO_ROOT
    / "outputs"
    / "step2_canonical"
    / "upgd_memory_opmnist_latest_best_800block_1seed_results.json"
)
SINGLE_UPGD_RESULTS_PATH = (
    REPO_ROOT
    / "outputs"
    / "step2_canonical"
    / "upgd_memory_opmnist_single_upgd_h128_800block_1seed_results.json"
)
DOHARE_OPMNIST_TASKS = 800
DOHARE_OPMNIST_TASK_BLOCK_SIZE = 60_000
DOHARE_OPMNIST_TOTAL_STEPS = DOHARE_OPMNIST_TASKS * DOHARE_OPMNIST_TASK_BLOCK_SIZE


def load_opmnist_results() -> dict[str, Any]:
    """Load the promoted OPMNIST canonical snapshot."""
    with RESULTS_PATH.open() as f:
        return cast(dict[str, Any], json.load(f))


def load_published_opmnist_results() -> dict[str, Any]:
    """Load the single-seed published-scale OPMNIST snapshot."""
    with PUBLISHED_RESULTS_PATH.open() as f:
        return cast(dict[str, Any], json.load(f))


def load_single_upgd_opmnist_results() -> dict[str, Any]:
    """Load the single-UPGD full-scale OPMNIST follow-up."""
    with SINGLE_UPGD_RESULTS_PATH.open() as f:
        return cast(dict[str, Any], json.load(f))


def test_current_opmnist_artifact_cannot_close_published_scale() -> None:
    results = load_opmnist_results()
    dataset = results["datasets"]["permuted_mnist_like"]
    status = results["status"]

    assert dataset["is_true_mnist"] is True
    assert dataset["is_full_mnist_split"] is True
    assert dataset["task_block_size"] == DOHARE_OPMNIST_TASK_BLOCK_SIZE
    assert dataset["n_permutations"] == DOHARE_OPMNIST_TASKS
    assert dataset["steps"] < DOHARE_OPMNIST_TOTAL_STEPS
    assert dataset["opmnist_completed_full_60000_task_blocks"] == 40
    assert status["matches_dohare_opmnist_core_protocol"] is True
    assert status["matches_dohare_opmnist_published_task_count"] is False
    assert status["published_scale_external_claim_supported"] is False


def test_single_seed_opmnist_artifact_closes_published_scale_protocol() -> None:
    results = load_published_opmnist_results()
    dataset = results["datasets"]["permuted_mnist_like"]

    assert results["config"]["mnist_published_scale"] is True
    assert results["config"]["n_seeds"] == 1
    assert dataset["is_true_mnist"] is True
    assert dataset["is_full_mnist_split"] is True
    assert dataset["n_train"] == DOHARE_OPMNIST_TASK_BLOCK_SIZE
    assert dataset["n_test"] == 10_000
    assert dataset["n_permutations"] == DOHARE_OPMNIST_TASKS
    assert dataset["task_block_size"] == DOHARE_OPMNIST_TASK_BLOCK_SIZE
    assert dataset["steps"] == DOHARE_OPMNIST_TOTAL_STEPS
    assert dataset["completed_full_task_blocks"] == DOHARE_OPMNIST_TASKS
    assert dataset["opmnist_completed_full_60000_task_blocks"] == DOHARE_OPMNIST_TASKS
    assert dataset["matches_dohare_opmnist_core_protocol"] is True
    assert dataset["matches_dohare_opmnist_published_task_count"] is True
    assert dataset["prediction_before_update_every_step"] is True
    assert dataset["task_id_provided_to_learner"] is False
    assert dataset["test_views_cover_all_permutations"] is True


def test_latest_best_opmnist_artifact_is_not_a_step2_solution_claim() -> None:
    from conftest import load_script
    module = load_script(
        REPO_ROOT / "benchmarks" / "step2_associative_opmnist_confirmation.py",
        "step2_associative_opmnist_confirmation_artifact_audit",
    )

    status = module.canonical_opmnist_artifact_status(load_published_opmnist_results())

    assert status["protocol_complete"] is True
    assert status["published_scale_single_or_more_seed"] is True
    assert status["configured_seed_count"] == 1
    assert status["multi_seed_full_scale"] is False
    assert status["primary_beats_best_mlp_by_metric"] == {
        "online_mean_mse": True,
        "online_mean_accuracy": True,
        "final_window_mse": True,
        "final_window_accuracy": False,
        "test_mse": False,
        "test_accuracy": False,
    }
    assert status["primary_all_core_metrics_win"] is False
    assert status["solved_opmnist_step2"] is False
    assert status["claim_scope"] == "limited_opmnist_evidence_not_step2_solution"


def test_single_upgd_h128_artifact_closes_protocol_and_reports_mixed_metrics() -> None:
    results = load_single_upgd_opmnist_results()
    dataset = results["datasets"]["permuted_mnist_like"]
    comparisons = results["aggregate"]["permuted_mnist_like"]["comparisons"]

    assert results["config"]["mnist_published_scale"] is True
    assert results["config"]["n_seeds"] == 1
    assert results["config"]["only_methods"] == (
        "mlp_h64,mlp_h128,upgd_structure_linear_h128,"
        "upgd_structure_softmax_h128"
    )
    assert dataset["is_true_mnist"] is True
    assert dataset["is_full_mnist_split"] is True
    assert dataset["steps"] == DOHARE_OPMNIST_TOTAL_STEPS
    assert dataset["completed_full_task_blocks"] == DOHARE_OPMNIST_TASKS
    assert dataset["matches_dohare_opmnist_core_protocol"] is True
    assert dataset["matches_dohare_opmnist_published_task_count"] is True
    assert dataset["test_views_cover_all_permutations"] is True

    softmax_accuracy = comparisons["test_accuracy"]["candidate_vs_best_mlp"][
        "upgd_structure_softmax_h128"
    ]
    softmax_mse = comparisons["test_mse"]["candidate_vs_best_mlp"][
        "upgd_structure_softmax_h128"
    ]
    final_accuracy = comparisons["final_window_accuracy"]["candidate_vs_best_mlp"][
        "upgd_structure_softmax_h128"
    ]

    assert softmax_accuracy["diff_mean_positive_favors_candidate"] > 0.0
    assert softmax_mse["diff_mean_positive_favors_candidate"] < 0.0
    assert final_accuracy["diff_mean_positive_favors_candidate"] < 0.0


def test_current_opmnist_artifact_discloses_limited_heldout_views() -> None:
    results = load_opmnist_results()
    dataset = results["datasets"]["permuted_mnist_like"]

    assert dataset["evaluate_all_permutation_views"] is False
    assert dataset["max_test_permutation_views"] == 40
    assert dataset["test_permutation_views"] == 40
    assert dataset["test_views_cover_observed_permutations"] is True
    assert dataset["test_views_cover_all_permutations"] is False


def test_current_opmnist_artifact_reports_accuracy_and_mse_metrics() -> None:
    results = load_opmnist_results()
    comparisons = results["aggregate"]["permuted_mnist_like"]["comparisons"]

    for metric in (
        "online_mean_accuracy",
        "online_mean_mse",
        "final_window_accuracy",
        "final_window_mse",
        "test_accuracy",
        "test_mse",
    ):
        assert metric in comparisons
        assert "mixture_vs_best_mlp" in comparisons[metric]


def test_current_opmnist_artifact_does_not_beat_best_expert_on_test() -> None:
    results = load_opmnist_results()
    comparisons = results["aggregate"]["permuted_mnist_like"]["comparisons"]

    test_accuracy = comparisons["test_accuracy"]["mixture_vs_best_expert"]
    test_mse = comparisons["test_mse"]["mixture_vs_best_expert"]

    assert test_accuracy["wins_for_baseline"] == 1
    assert test_accuracy["wins_for_mixture"] == 0
    assert test_accuracy["paired_diff_mean_positive_favors_mixture"] < 0.0
    assert test_mse["wins_for_baseline"] == 1
    assert test_mse["wins_for_mixture"] == 0
    assert test_mse["paired_diff_mean_positive_favors_mixture"] < 0.0
