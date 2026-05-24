"""Tests for the Step 2 associative OPMNIST confirmation runner."""

from __future__ import annotations

import json
from pathlib import Path
from types import ModuleType

import pytest
from conftest import load_script

_SCRIPT_PATH = (
    Path(__file__).resolve().parents[1]
    / "benchmarks"
    / "step2_associative_opmnist_confirmation.py"
)


def load_module() -> ModuleType:
    return load_script(_SCRIPT_PATH, "step2_associative_opmnist_confirmation")


def test_scale_presets_distinguish_smoke_partial_and_full() -> None:
    module = load_module()

    smoke = module.parse_args(["--scale", "smoke", "--mnist-source", "synthetic"])
    partial = module.parse_args(["--scale", "partial", "--mnist-source", "synthetic"])
    full = module.parse_args(["--scale", "full", "--dry-run"])

    assert smoke.scale == "smoke"
    assert partial.scale == "partial"
    assert full.scale == "full"
    assert smoke.steps < partial.steps < full.steps
    assert smoke.n_permutations < partial.n_permutations
    assert full.steps == module.DOHARE_OPMNIST_TOTAL_STEPS
    assert full.n_permutations == module.DOHARE_OPMNIST_TASKS
    assert module.published_scale_guard(full)["configured_for_full_published_scale"]


def test_synthetic_smoke_run_writes_manifest_without_published_claim(
    tmp_path: Path,
) -> None:
    module = load_module()

    payload = module.main(
        [
            "--scale",
            "smoke",
            "--mnist-source",
            "synthetic",
            "--steps",
            "24",
            "--chunk-size",
            "8",
            "--final-window",
            "4",
            "--n-permutations",
            "2",
            "--task-block-size",
            "12",
            "--seeds",
            "0",
            "--max-train-examples",
            "60",
            "--max-test-examples",
            "20",
            "--block-size",
            "8",
            "--suffix-length",
            "3",
            "--max-features",
            "64",
            "--adaptive-feature-family",
            "--adaptive-window",
            "--adaptive-budget",
            "--initial-budget-fraction",
            "0.25",
            "--output-dir",
            str(tmp_path),
            "--result-prefix",
            "smoke",
        ]
    )

    result_path = tmp_path / "smoke_results.json"
    manifest_path = tmp_path / "smoke_manifest.json"
    result = json.loads(result_path.read_text())
    manifest = json.loads(manifest_path.read_text())

    assert payload["status"]["published_scale_external_claim_supported"] is False
    assert result["status"]["scale"] == "smoke"
    assert result["protocol"]["scale"] == "smoke"
    assert result["protocol"]["completed_steps"] == 24
    assert result["published_scale_guard"]["smoke_or_partial_never_counts_as_published"]
    assert result["records"][0]["steps"] == 24
    assert manifest["schema"] == "alberta.step2.associative_opmnist.manifest.v1"
    assert manifest["argv"][0:2] == ["--scale", "smoke"]
    assert manifest["seed_list"] == [0]
    assert manifest["dataset"]["source"] == "synthetic"
    assert manifest["config"]["adaptive_feature_family"] is True
    assert manifest["config"]["adaptive_window"] is True
    assert manifest["config"]["adaptive_budget"] is True
    assert manifest["config"]["initial_budget_fraction"] == 0.25


def test_full_scale_requires_explicit_guard_unless_dry_run() -> None:
    module = load_module()

    with pytest.raises(ValueError, match="48,000,000"):
        module.parse_args(["--scale", "full"])


def test_full_scale_dry_run_records_plan_but_not_confirmation(
    tmp_path: Path,
) -> None:
    module = load_module()

    payload = module.main(
        [
            "--scale",
            "full",
            "--dry-run",
            "--output-dir",
            str(tmp_path),
            "--result-prefix",
            "full_plan",
        ]
    )

    protocol = payload["protocol"]
    guard = payload["published_scale_guard"]
    status = payload["status"]

    assert payload["dry_run"] is True
    assert payload["records"] == []
    assert protocol["planned_steps"] == module.DOHARE_OPMNIST_TOTAL_STEPS
    assert protocol["completed_steps"] == 0
    assert protocol["configured_for_dohare_opmnist_published_task_count"] is True
    assert protocol["matches_dohare_opmnist_published_task_count"] is False
    assert guard["configured_for_full_published_scale"] is True
    assert guard["requires_allow_published_scale"] is True
    assert guard["allow_published_scale"] is False
    assert guard["dry_run"] is True
    assert status["published_scale_external_claim_supported"] is False
    assert (tmp_path / "full_plan_results.json").exists()
    assert (tmp_path / "full_plan_manifest.json").exists()


def test_smoke_scale_never_counts_as_published_even_with_full_sized_metadata() -> None:
    module = load_module()
    args = module.parse_args(
        [
            "--scale",
            "smoke",
            "--dry-run",
            "--steps",
            str(module.DOHARE_OPMNIST_TOTAL_STEPS),
            "--n-permutations",
            str(module.DOHARE_OPMNIST_TASKS),
            "--task-block-size",
            str(module.DOHARE_OPMNIST_TASK_BLOCK_SIZE),
            "--evaluate-all-permutation-views",
        ]
    )
    dataset_meta = {
        "is_true_mnist": True,
        "is_full_mnist_split": True,
        "n_train": module.DOHARE_OPMNIST_TASK_BLOCK_SIZE,
        "n_test": 10_000,
        "n_classes": 10,
    }
    observed = module.observed_task_ids_for_steps(
        steps=args.steps,
        task_block_size=args.task_block_size,
        n_permutations=args.n_permutations,
    )
    test_ids = module.test_task_ids_for_protocol(args, observed)
    protocol = module.protocol_metadata(
        args,
        dataset_meta,
        completed_steps=module.DOHARE_OPMNIST_TOTAL_STEPS,
        observed_task_ids=observed,
        test_task_ids=test_ids,
    )
    status = module.benchmark_status(
        args=args,
        dataset_meta=dataset_meta,
        protocol=protocol,
        completed_steps=module.DOHARE_OPMNIST_TOTAL_STEPS,
    )

    assert protocol["matches_dohare_opmnist_core_protocol"] is True
    assert protocol["matches_dohare_opmnist_published_task_count"] is True
    assert status["full_published_run_executed"] is False
    assert status["published_scale_external_claim_supported"] is False
