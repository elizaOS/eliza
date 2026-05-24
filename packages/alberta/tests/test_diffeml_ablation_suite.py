"""Tests for the DiffEML image ablation-suite harness."""

from __future__ import annotations

from pathlib import Path
from types import ModuleType
from typing import Any

from conftest import load_script

_SCRIPT_PATH = (
    Path(__file__).resolve().parents[1]
    / "examples"
    / "The Alberta Plan"
    / "Step2"
    / "step2_diffeml_ablation_suite.py"
)

SUITE: ModuleType = load_script(_SCRIPT_PATH, "step2_diffeml_ablation_suite")


def test_ablation_specs_cover_fixed_comparisons() -> None:
    """The suite should expose every requested ablation config."""
    specs = SUITE.build_ablation_specs(full=False, seed=7)
    by_name = {spec.name: spec for spec in specs}

    assert tuple(by_name) == (
        "eml_template",
        "truth_table",
        "linear_head",
        "group_sum_head",
        "class_vote_head",
        "signed_class_vote_head",
        "class_bank_group_sum",
        "class_bank_class_vote",
        "threshold_pixels",
        "detector_thresholds",
        "packed_eval",
        "mlp_same_features",
    )
    assert by_name["eml_template"].config.gate_mode == "eml_template"
    assert by_name["truth_table"].config.gate_mode == "truth_table"
    assert by_name["linear_head"].config.head_mode == "linear"
    assert by_name["group_sum_head"].config.head_mode == "group_sum"
    assert by_name["class_vote_head"].config.head_mode == "class_vote"
    assert by_name["signed_class_vote_head"].config.head_mode == "signed_class_vote"
    assert by_name["class_bank_group_sum"].config.wiring_mode == "class_bank_random"
    assert by_name["class_bank_group_sum"].config.head_mode == "group_sum"
    assert by_name["class_bank_class_vote"].config.wiring_mode == "class_bank_random"
    assert by_name["class_bank_class_vote"].config.head_mode == "class_vote"
    assert by_name["threshold_pixels"].config.feature_mode == "threshold_pixels"
    assert by_name["detector_thresholds"].config.feature_mode == "detector_thresholds"
    assert by_name["packed_eval"].config.packed_eval is True
    assert by_name["mlp_same_features"].config.compare_mlp is True
    assert by_name["eml_template"].config.seed == 7


def test_demo_command_includes_only_relevant_flags() -> None:
    """Command equivalents should reproduce direct image-demo runs."""
    spec = {
        spec.name: spec
        for spec in SUITE.build_ablation_specs(full=False, seed=0)
    }["packed_eval"]

    command = SUITE.demo_command(
        spec.config,
        output=Path("out.json"),
        data_dir=Path("custom-data"),
    )

    assert "step2_diffeml_image_demo.py" in command
    assert "--data-dir custom-data" in command
    assert "--packed-eval" in command
    assert "--output out.json" in command
    assert "--compare-mlp" not in command


def test_summarize_suite_computes_requested_deltas() -> None:
    """Summaries should compute cross-run and baseline deltas without training."""
    runs = [
        _run("eml_template", "digits", {"test_hard_accuracy": 0.80}),
        _run("truth_table", "digits", {"test_hard_accuracy": 0.75}),
        _run("linear_head", "digits", {"test_hard_accuracy": 0.70}),
        _run("group_sum_head", "digits", {"test_hard_accuracy": 0.60}),
        _run("class_vote_head", "digits", {"test_hard_accuracy": 0.64}),
        _run("signed_class_vote_head", "digits", {"test_hard_accuracy": 0.66}),
        _run("class_bank_group_sum", "digits", {"test_hard_accuracy": 0.63}),
        _run("class_bank_class_vote", "digits", {"test_hard_accuracy": 0.67}),
        _run("threshold_pixels", "digits", {"test_hard_accuracy": 0.65}),
        _run("detector_thresholds", "digits", {"test_hard_accuracy": 0.68}),
        _run(
            "packed_eval",
            "digits",
            {"test_hard_accuracy": 0.72, "packed_hard_test_accuracy": 0.72},
        ),
        _run(
            "mlp_same_features",
            "digits",
            {"test_hard_accuracy": 0.66},
            baseline={"test_accuracy": 0.61},
        ),
    ]

    summary = SUITE.summarize_suite(runs)
    comparisons = {item["name"]: item for item in summary["comparisons"]}

    assert comparisons["eml_template_vs_truth_table"]["deltas"] == {"digits": 0.05}
    assert comparisons["linear_head_vs_group_sum"]["deltas"] == {"digits": 0.10}
    assert comparisons["class_vote_vs_group_sum"]["deltas"] == {"digits": 0.04}
    assert comparisons["linear_head_vs_class_vote"]["deltas"] == {"digits": 0.06}
    assert comparisons["signed_class_vote_vs_class_vote"]["deltas"] == {"digits": 0.02}
    assert comparisons["class_bank_group_sum_vs_group_sum"]["deltas"] == {"digits": 0.03}
    assert comparisons["class_bank_class_vote_vs_class_vote"]["deltas"] == {"digits": 0.03}
    assert comparisons["threshold_pixels_vs_detector_thresholds"]["deltas"] == {
        "digits": -0.03
    }
    assert comparisons["packed_eval_equality"]["equal"] is True
    assert comparisons["mlp_same_feature_comparison"]["deltas"] == {"digits": 0.05}


def _run(
    name: str,
    dataset: str,
    metrics: dict[str, float],
    *,
    baseline: dict[str, float] | None = None,
) -> dict[str, Any]:
    result: dict[str, Any] = {"dataset": dataset, "metrics": metrics}
    if baseline is not None:
        result["baselines"] = {"mlp_same_features": baseline}
    return {"name": name, "results": [result]}
