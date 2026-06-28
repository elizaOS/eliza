"""Tests for the Step 2 UPGD-memory OPMNIST runner."""

from __future__ import annotations

import json
import pickle
from pathlib import Path
from types import ModuleType
from typing import Any

import numpy as np
from conftest import load_script

_SCRIPT_PATH = (
    Path(__file__).resolve().parents[1]
    / "examples"
    / "The Alberta Plan"
    / "Step2"
    / "step2_upgd_memory_opmnist.py"
)
_GATE_SCRIPT_PATH = (
    Path(__file__).resolve().parents[1]
    / "benchmarks"
    / "step2_opmnist_solution_gate.py"
)
_PLAN_SCRIPT_PATH = (
    Path(__file__).resolve().parents[1]
    / "benchmarks"
    / "step2_opmnist_full_run_plan.py"
)
_MERGE_SCRIPT_PATH = (
    Path(__file__).resolve().parents[1]
    / "benchmarks"
    / "step2_opmnist_merge_seed_results.py"
)
_PIPELINE_SCRIPT_PATH = (
    Path(__file__).resolve().parents[1]
    / "benchmarks"
    / "step2_opmnist_solution_pipeline.py"
)


def load_module() -> ModuleType:
    return load_script(_SCRIPT_PATH, "step2_upgd_memory_opmnist")


def load_gate_module() -> ModuleType:
    return load_script(_GATE_SCRIPT_PATH, "step2_opmnist_solution_gate")


def load_plan_module() -> ModuleType:
    return load_script(_PLAN_SCRIPT_PATH, "step2_opmnist_full_run_plan")


def load_merge_module() -> ModuleType:
    return load_script(_MERGE_SCRIPT_PATH, "step2_opmnist_merge_seed_results")


def load_pipeline_module() -> ModuleType:
    return load_script(_PIPELINE_SCRIPT_PATH, "step2_opmnist_solution_pipeline")


def test_accumulator_keeps_final_window_tail() -> None:
    module = load_module()
    accumulator = module.init_accumulator(final_window=3)
    metrics = np.asarray(
        [
            [0.4, 0.0],
            [0.3, 1.0],
            [0.2, 1.0],
            [0.1, 1.0],
        ],
        dtype=np.float32,
    )

    updated = module.update_accumulator(accumulator, metrics, final_window=3)
    summary = module.summarize_accumulator(updated)

    assert updated.n_steps == 4
    np.testing.assert_allclose(updated.final_losses[:3], [0.3, 0.2, 0.1])
    assert summary["online_mean_accuracy"] == 0.75
    assert summary["final_window_accuracy"] == 1.0


def test_sklearn_digits_smoke_run_writes_primary_comparison(tmp_path: Path) -> None:
    module = load_module()
    output_dir = tmp_path / "opmnist"
    note_path = tmp_path / "note.md"
    module.main(
        [
            "--mnist-source",
            "sklearn_digits_8x8",
            "--steps",
            "12",
            "--n-seeds",
            "1",
            "--final-window",
            "4",
            "--max-train-examples",
            "40",
            "--max-test-examples",
            "20",
            "--n-permutations",
            "2",
            "--task-block-size",
            "6",
            "--chunk-size",
            "6",
            "--output-dir",
            str(output_dir),
            "--result-prefix",
            "smoke",
            "--note-path",
            str(note_path),
            "--force-restart",
        ]
    )

    results = json.loads((output_dir / "smoke_results.json").read_text())
    aggregate = results["aggregate"]["permuted_mnist_like"]

    assert results["primary_method"] == "step2_hybrid_memory_trace"
    assert results["solution_status"]["solved_opmnist_step2"] is False
    assert (
        results["solution_status"]["claim_scope"]
        == "limited_opmnist_evidence_not_step2_solution"
    )
    assert results["datasets"]["permuted_mnist_like"]["is_true_mnist"] is False
    assert "test_accuracy" in aggregate["comparisons"]
    assert results["manifest"]["schema"] == (
        "alberta.step2.upgd_memory_opmnist.manifest.v1"
    )
    assert "--mnist-source" in results["manifest"]["argv"]
    assert results["manifest"]["methods"] == results["config"]["methods"]
    assert "git" in results["manifest"]
    assert "jax" in results["manifest"]["environment"]
    assert "runner" in results["manifest"]["source_sha256"]
    assert len(results["manifest"]["source_sha256"]["runner"]) == 64
    assert note_path.exists()


def test_stop_after_chunks_writes_checkpoint_without_final_result(
    tmp_path: Path,
) -> None:
    module = load_module()
    output_dir = tmp_path / "partial"
    status_path = tmp_path / "partial_status.json"

    module.main(
        [
            "--mnist-source",
            "sklearn_digits_8x8",
            "--steps",
            "12",
            "--n-seeds",
            "1",
            "--final-window",
            "4",
            "--max-train-examples",
            "40",
            "--max-test-examples",
            "20",
            "--n-permutations",
            "2",
            "--task-block-size",
            "6",
            "--chunk-size",
            "6",
            "--stop-after-chunks",
            "1",
            "--output-dir",
            str(output_dir),
            "--result-prefix",
            "partial",
            "--status-path",
            str(status_path),
            "--note-path",
            str(tmp_path / "partial.md"),
            "--force-restart",
        ]
    )

    status = json.loads(status_path.read_text())

    assert status["completed_steps"] == 6
    assert status["latest_progress"]["chunks_run_this_invocation"] == 1
    assert (output_dir / "partial_seed0_resume.pkl").exists()
    assert not (output_dir / "partial_results.json").exists()


def test_published_scale_fraction_aligns_to_complete_blocks() -> None:
    module = load_module()
    args = module.parse_args(
        [
            "--mnist-published-scale",
            "--allow-openml-download",
            "--opmnist-fraction",
            "0.01",
        ]
    )

    module.apply_presets(args)
    module.validate_args(args)

    assert args.mnist_source == "openml"
    assert args.mnist_split == "canonical"
    assert args.n_permutations == 800
    assert args.task_block_size == 60_000
    assert args.steps == 480_000


def test_aggregate_records_handles_candidate_methods() -> None:
    module = load_module()
    record = {
        "methods": {
            module.PRIMARY_METHOD: {
                "online_mean_mse": 0.2,
                "online_mean_accuracy": 0.7,
                "final_window_mse": 0.18,
                "final_window_accuracy": 0.72,
                "test_mse": 0.17,
                "test_accuracy": 0.73,
            },
            "mlp_h64": {
                "online_mean_mse": 0.25,
                "online_mean_accuracy": 0.6,
                "final_window_mse": 0.2,
                "final_window_accuracy": 0.65,
                "test_mse": 0.2,
                "test_accuracy": 0.66,
            },
            "mlp_h64_sharp": {
                "online_mean_mse": 0.22,
                "online_mean_accuracy": 0.68,
                "final_window_mse": 0.19,
                "final_window_accuracy": 0.7,
                "test_mse": 0.18,
                "test_accuracy": 0.71,
            },
            module.CENTROID_METHOD: {
                "online_mean_mse": 0.19,
                "online_mean_accuracy": 0.74,
                "final_window_mse": 0.16,
                "final_window_accuracy": 0.76,
                "test_mse": 0.16,
                "test_accuracy": 0.75,
            },
        }
    }

    aggregate = module.aggregate_records([record])
    comparison = aggregate["comparisons"]["final_window_mse"]

    assert aggregate["mlp_methods"] == ["mlp_h64", "mlp_h64_sharp"]
    assert module.CENTROID_METHOD in aggregate["candidate_methods"]
    assert comparison["best_mlp"] == "mlp_h64_sharp"
    assert comparison["candidate_vs_best_mlp"][module.CENTROID_METHOD][
        "diff_mean_positive_favors_candidate"
    ] > 0.0


def test_opmnist_solution_status_requires_multiseed_full_protocol_and_all_metrics() -> None:
    module = load_module()
    records = [
        {
            "seed": seed,
            "dataset": {
                "steps": module.pub.DOHARE_OPMNIST_TOTAL_STEPS,
            },
            "methods": {
                module.PRIMARY_METHOD: {
                    "online_mean_mse": 0.10 + 0.001 * seed,
                    "online_mean_accuracy": 0.91 + 0.001 * seed,
                    "final_window_mse": 0.09 + 0.001 * seed,
                    "final_window_accuracy": 0.92 + 0.001 * seed,
                    "test_mse": 0.11 + 0.001 * seed,
                    "test_accuracy": 0.90 + 0.001 * seed,
                },
                "mlp_h128": {
                    "online_mean_mse": 0.20 + 0.001 * seed,
                    "online_mean_accuracy": 0.81 + 0.001 * seed,
                    "final_window_mse": 0.19 + 0.001 * seed,
                    "final_window_accuracy": 0.82 + 0.001 * seed,
                    "test_mse": 0.21 + 0.001 * seed,
                    "test_accuracy": 0.80 + 0.001 * seed,
                },
            },
        }
        for seed in range(3)
    ]
    dataset = {
        "is_true_mnist": True,
        "is_full_mnist_split": True,
        "n_train": module.pub.DOHARE_OPMNIST_TASK_BLOCK_SIZE,
        "n_test": 10_000,
        "steps": module.pub.DOHARE_OPMNIST_TOTAL_STEPS,
        "completed_full_task_blocks": module.pub.DOHARE_OPMNIST_TASKS,
        "opmnist_completed_full_60000_task_blocks": module.pub.DOHARE_OPMNIST_TASKS,
        "matches_dohare_opmnist_core_protocol": True,
        "matches_dohare_opmnist_published_task_count": True,
        "prediction_before_update_every_step": True,
        "task_id_provided_to_learner": False,
        "test_views_cover_all_permutations": True,
    }
    payload = {
        "config": {
            "mnist_published_scale": True,
            "steps": module.pub.DOHARE_OPMNIST_TOTAL_STEPS,
            "n_seeds": 3,
            "n_permutations": module.pub.DOHARE_OPMNIST_TASKS,
            "task_block_size": module.pub.DOHARE_OPMNIST_TASK_BLOCK_SIZE,
        },
        "datasets": {"permuted_mnist_like": dataset},
        "records": records,
        "aggregate": {"permuted_mnist_like": module.aggregate_records(records)},
        "manifest": {
            "schema": "alberta.step2.upgd_memory_opmnist.manifest.v1",
            "argv": ["--mnist-published-scale"],
            "methods": [module.PRIMARY_METHOD, "mlp_h128"],
            "git": {"commit": "abc123", "dirty": False},
            "environment": {"jax": "test"},
            "source_sha256": {"runner": "a" * 64},
        },
    }

    status = module.opmnist_solution_status(payload)

    assert status["protocol_complete"] is True
    assert status["multi_seed_full_scale"] is True
    assert status["artifact_provenance"]["provenance_complete"] is True
    assert status["candidates_winning_all_metrics"] == [module.PRIMARY_METHOD]
    assert status["solved_opmnist_step2"] is True


def test_opmnist_solution_status_requires_publishable_provenance() -> None:
    module = load_module()
    payload = make_solution_payload(0)
    payload["config"]["n_seeds"] = 3
    payload["records"] = [
        make_solution_payload(seed)["records"][0] for seed in range(3)
    ]
    payload["datasets"] = {
        "permuted_mnist_like": payload["records"][-1]["dataset"]
    }
    payload["aggregate"] = {
        "permuted_mnist_like": module.aggregate_records(payload["records"])
    }
    payload.pop("manifest")

    status = module.opmnist_solution_status(payload)

    assert status["protocol_complete"] is True
    assert status["multi_seed_full_scale"] is True
    assert status["artifact_provenance"]["provenance_complete"] is False
    assert status["candidates_winning_all_metrics"] == [module.PRIMARY_METHOD]
    assert status["solved_opmnist_step2"] is False


def make_solution_payload(seed: int) -> dict[str, Any]:
    """Create one synthetic full-protocol OPMNIST seed result."""
    module = load_module()
    record = {
        "seed": seed,
        "dataset_name": "permuted_mnist_like",
        "dataset": {
            "is_true_mnist": True,
            "is_full_mnist_split": True,
            "n_train": module.pub.DOHARE_OPMNIST_TASK_BLOCK_SIZE,
            "n_test": 10_000,
            "n_permutations": module.pub.DOHARE_OPMNIST_TASKS,
            "task_block_size": module.pub.DOHARE_OPMNIST_TASK_BLOCK_SIZE,
            "steps": module.pub.DOHARE_OPMNIST_TOTAL_STEPS,
            "completed_full_task_blocks": module.pub.DOHARE_OPMNIST_TASKS,
            "opmnist_completed_full_60000_task_blocks": module.pub.DOHARE_OPMNIST_TASKS,
            "matches_dohare_opmnist_core_protocol": True,
            "matches_dohare_opmnist_published_task_count": True,
            "prediction_before_update_every_step": True,
            "task_id_provided_to_learner": False,
            "test_views_cover_all_permutations": True,
        },
        "methods": {
            module.PRIMARY_METHOD: {
                "online_mean_mse": 0.10 + 0.001 * seed,
                "online_mean_accuracy": 0.91 + 0.001 * seed,
                "final_window_mse": 0.09 + 0.001 * seed,
                "final_window_accuracy": 0.92 + 0.001 * seed,
                "test_mse": 0.11 + 0.001 * seed,
                "test_accuracy": 0.90 + 0.001 * seed,
            },
            "mlp_h128": {
                "online_mean_mse": 0.20 + 0.001 * seed,
                "online_mean_accuracy": 0.81 + 0.001 * seed,
                "final_window_mse": 0.19 + 0.001 * seed,
                "final_window_accuracy": 0.82 + 0.001 * seed,
                "test_mse": 0.21 + 0.001 * seed,
                "test_accuracy": 0.80 + 0.001 * seed,
            },
        },
    }
    return {
        "config": {
            "mnist_published_scale": True,
            "steps": module.pub.DOHARE_OPMNIST_TOTAL_STEPS,
            "n_seeds": 1,
            "n_permutations": module.pub.DOHARE_OPMNIST_TASKS,
            "task_block_size": module.pub.DOHARE_OPMNIST_TASK_BLOCK_SIZE,
        },
        "datasets": {"permuted_mnist_like": record["dataset"]},
        "records": [record],
        "aggregate": {"permuted_mnist_like": module.aggregate_records([record])},
        "manifest": {
            "schema": "alberta.step2.upgd_memory_opmnist.manifest.v1",
            "argv": ["--seed", str(seed)],
            "methods": [module.PRIMARY_METHOD, "mlp_h128"],
            "git": {"commit": f"commit-{seed}", "dirty": False},
            "environment": {"jax": "test"},
            "source_sha256": {"runner": "a" * 64},
        },
    }


def test_merge_seed_results_combines_split_runs_and_recomputes_solution_status(
    tmp_path: Path,
) -> None:
    merger = load_merge_module()
    input_paths = []
    for seed in range(3):
        path = tmp_path / f"seed{seed}.json"
        path.write_text(json.dumps(make_solution_payload(seed)), encoding="utf-8")
        input_paths.append(path)
    output_path = tmp_path / "merged.json"
    summary_path = tmp_path / "merged.md"

    exit_code = merger.main(
        [
            *(str(path) for path in input_paths),
            "--output",
            str(output_path),
            "--write-summary",
            str(summary_path),
        ]
    )
    merged = json.loads(output_path.read_text())

    assert exit_code == 0
    assert len(merged["records"]) == 3
    assert merged["config"]["merged_from_seed_splits"] is True
    assert merged["manifest"]["schema"] == (
        "alberta.step2.upgd_memory_opmnist.merge_manifest.v1"
    )
    assert merged["manifest"]["seeds"] == [0, 1, 2]
    assert len(merged["manifest"]["split_results"]) == 3
    assert all(
        len(row["sha256"]) == 64 for row in merged["manifest"]["split_results"]
    )
    assert merged["manifest"]["split_results"][0]["manifest"]["git"]["commit"] == (
        "commit-0"
    )
    assert merged["solution_status"]["multi_seed_full_scale"] is True
    assert (
        merged["solution_status"]["artifact_provenance"][
            "merged_split_manifest_complete"
        ]
        is True
    )
    assert merged["solution_status"]["solved_opmnist_step2"] is True
    assert summary_path.exists()


def test_merge_seed_results_rejects_duplicate_seed(tmp_path: Path) -> None:
    merger = load_merge_module()
    path_a = tmp_path / "seed0a.json"
    path_b = tmp_path / "seed0b.json"
    path_a.write_text(json.dumps(make_solution_payload(0)), encoding="utf-8")
    path_b.write_text(json.dumps(make_solution_payload(0)), encoding="utf-8")

    try:
        merger.main([str(path_a), str(path_b), "--output", str(tmp_path / "out.json")])
    except ValueError as exc:
        assert "duplicate seeds" in str(exc)
    else:
        raise AssertionError("expected duplicate seed validation failure")


def test_opmnist_solution_status_rejects_single_seed_or_mixed_metric_artifacts() -> None:
    module = load_module()
    latest_best_path = (
        Path(__file__).resolve().parents[1]
        / "outputs"
        / "step2_canonical"
        / "upgd_memory_opmnist_latest_best_800block_1seed_results.json"
    )
    single_seed_payload = json.loads(latest_best_path.read_text())

    status = module.opmnist_solution_status(single_seed_payload)

    assert status["protocol_complete"] is True
    assert status["configured_seed_count"] == 1
    assert status["multi_seed_full_scale"] is False
    assert status["solved_opmnist_step2"] is False


def test_opmnist_solution_gate_cli_rejects_current_canonical_artifact(
    tmp_path: Path,
) -> None:
    gate = load_gate_module()
    latest_best_path = (
        Path(__file__).resolve().parents[1]
        / "outputs"
        / "step2_canonical"
        / "upgd_memory_opmnist_latest_best_800block_1seed_results.json"
    )
    status_path = tmp_path / "audit.json"

    exit_code = gate.main(
        [
            str(latest_best_path),
            "--write-status",
            str(status_path),
        ]
    )
    audit = json.loads(status_path.read_text())

    assert exit_code == 2
    assert audit["status"]["protocol_complete"] is True
    assert audit["status"]["multi_seed_full_scale"] is False
    assert audit["status"]["solved_opmnist_step2"] is False


def test_opmnist_solution_gate_cli_allows_diagnostic_unsolved_mode() -> None:
    gate = load_gate_module()
    latest_best_path = (
        Path(__file__).resolve().parents[1]
        / "outputs"
        / "step2_canonical"
        / "upgd_memory_opmnist_latest_best_800block_1seed_results.json"
    )

    exit_code = gate.main([str(latest_best_path), "--allow-unsolved"])

    assert exit_code == 0


def test_opmnist_full_run_plan_generates_runner_and_audit_commands(
    tmp_path: Path,
) -> None:
    planner = load_plan_module()
    plan_path = tmp_path / "plan.json"

    exit_code = planner.main(
        [
            "--output-dir",
            str(tmp_path / "solution"),
            "--result-prefix",
            "candidate",
            "--note-path",
            str(tmp_path / "candidate.md"),
            "--write-plan",
            str(plan_path),
        ]
    )
    plan = json.loads(plan_path.read_text())

    assert exit_code == 0
    assert plan["schema"] == "alberta.step2.opmnist_full_run_plan.v1"
    assert plan["n_seeds"] == 3
    assert plan["protocol"]["updates_per_seed"] == 48_000_000
    assert "step2_hybrid_memory_trace" in plan["methods"]
    assert "step2_hybrid_memory_trace_adaptive_sharp" in plan["methods"]
    assert "mlp_h64_sharp" in plan["methods"]
    assert "--mnist-published-scale" in plan["runner_command"]
    assert "--include-adaptive-primary-sharpened" in plan["runner_command"]
    assert "--include-sharpened-mlp" in plan["runner_command"]
    assert "--evaluate-all-permutation-views" in plan["runner_command"]
    assert len(plan["split_seed_runner_commands"]) == 3
    assert "benchmarks/step2_opmnist_merge_seed_results.py" in plan["merge_command"]
    assert "benchmarks/step2_opmnist_solution_gate.py" in plan["audit_command"]
    assert "status.solved_opmnist_step2=true" in plan["promotion_rule"]


def test_opmnist_full_run_plan_rejects_non_solution_seed_count() -> None:
    planner = load_plan_module()

    try:
        planner.main(["--n-seeds", "1"])
    except ValueError as exc:
        assert "--n-seeds must be at least 3" in str(exc)
    else:
        raise AssertionError("expected --n-seeds validation failure")


def test_opmnist_full_run_plan_rejects_unavailable_methods() -> None:
    planner = load_plan_module()

    try:
        planner.main(["--only-methods", "mlp_h64", "missing_step2_candidate"])
    except ValueError as exc:
        assert "unavailable methods" in str(exc)
        assert "missing_step2_candidate" in str(exc)
    else:
        raise AssertionError("expected unavailable method validation failure")


def test_opmnist_full_run_plan_infers_candidate_include_flags() -> None:
    planner = load_plan_module()
    args = planner.parse_args(
        [
            "--only-methods",
            "mlp_h64",
            "upgd_structure_brier_h128",
            "step2_hybrid_memory_trace_dream_surprise",
        ]
    )

    planner.validate_args(args)
    command = planner.runner_command(args)

    assert "--include-brier-single-upgd" in command
    assert "--include-dreaming-candidates" in command


def test_opmnist_solution_pipeline_reports_missing_seed_results(
    tmp_path: Path,
) -> None:
    pipeline = load_pipeline_module()
    status_path = tmp_path / "pipeline_status.json"

    exit_code = pipeline.main(
        [
            "--output-dir",
            str(tmp_path / "solution"),
            "--result-prefix",
            "candidate",
            "--write-status",
            str(status_path),
            "--run-next",
        ]
    )
    payload = json.loads(status_path.read_text())

    assert exit_code == 0
    assert payload["status"]["ready_to_merge"] is False
    assert payload["status"]["all_seed_results_exist"] is False
    assert payload["actions"][0]["action"] == "run_next"
    assert payload["actions"][0]["seed"] == 0
    assert payload["actions"][0]["dry_run"] is True


def test_opmnist_solution_pipeline_can_bound_next_seed_chunks(
    tmp_path: Path,
) -> None:
    pipeline = load_pipeline_module()
    status_path = tmp_path / "pipeline_status.json"

    exit_code = pipeline.main(
        [
            "--output-dir",
            str(tmp_path / "solution"),
            "--result-prefix",
            "candidate",
            "--write-status",
            str(status_path),
            "--run-next",
            "--run-next-chunks",
            "2",
        ]
    )
    payload = json.loads(status_path.read_text())
    command = payload["actions"][0]["command"]

    assert exit_code == 0
    assert payload["actions"][0]["bounded_chunks"] == 2
    assert "--stop-after-chunks" in command
    assert command[command.index("--stop-after-chunks") + 1] == "2"


def test_opmnist_solution_pipeline_merges_and_audits_ready_splits(
    tmp_path: Path,
) -> None:
    pipeline = load_pipeline_module()
    output_dir = tmp_path / "solution"
    split_dir = output_dir / "seed_splits"
    split_dir.mkdir(parents=True)
    for seed in range(3):
        path = split_dir / f"candidate_seed{seed}_results.json"
        path.write_text(json.dumps(make_solution_payload(seed)), encoding="utf-8")
    status_path = tmp_path / "pipeline_status.json"

    exit_code = pipeline.main(
        [
            "--output-dir",
            str(output_dir),
            "--result-prefix",
            "candidate",
            "--write-status",
            str(status_path),
            "--merge-ready",
            "--audit",
            "--no-dry-run",
        ]
    )
    payload = json.loads(status_path.read_text())
    merged = json.loads((output_dir / "candidate_results.json").read_text())

    assert exit_code == 0
    assert payload["status"]["ready_to_merge"] is True
    assert payload["status"]["ready_to_audit"] is True
    assert [action["action"] for action in payload["actions"]] == ["merge", "audit"]
    assert all(action["returncode"] == 0 for action in payload["actions"])
    assert merged["solution_status"]["solved_opmnist_step2"] is True
    assert (output_dir / "candidate_solution_gate.json").exists()


def test_aggregate_records_allows_candidate_only_splits() -> None:
    module = load_module()
    record = {
        "methods": {
            module.PRIMARY_METHOD: {
                "online_mean_mse": 0.2,
                "online_mean_accuracy": 0.7,
                "final_window_mse": 0.18,
                "final_window_accuracy": 0.72,
                "test_mse": 0.17,
                "test_accuracy": 0.73,
            },
            module.PRIMARY_ADAPTIVE_SHARP_METHOD: {
                "online_mean_mse": 0.19,
                "online_mean_accuracy": 0.71,
                "final_window_mse": 0.17,
                "final_window_accuracy": 0.73,
                "test_mse": 0.16,
                "test_accuracy": 0.74,
            },
        }
    }

    aggregate = module.aggregate_records([record])

    assert aggregate["mlp_methods"] == []
    assert aggregate["comparisons"] == {}


def test_make_methods_includes_adaptive_primary_when_requested() -> None:
    module = load_module()
    methods = module.make_methods(
        64,
        include_adaptive_primary_sharpened=True,
        include_sharpened_mlp=True,
        include_prototype_memory=True,
    )

    assert module.PRIMARY_METHOD in methods
    assert module.PRIMARY_ADAPTIVE_SHARP_METHOD in methods
    assert "mlp_h64_sharp" in methods
    assert "proto_mem_s20" in methods
    assert module.PROTO_MEMORY_METHOD in methods


def test_make_methods_includes_fixed_readout_single_upgd_when_requested() -> None:
    module = load_module()
    methods = module.make_methods(64, include_single_upgd=True)

    assert module.PRIMARY_METHOD in methods
    for method in module.SINGLE_UPGD_METHODS:
        assert method in methods
        cfg = methods[method].to_config()
        assert cfg["type"] == "UPGDLearner"
        assert cfg["loss_normalization"] == "target_structure"
        assert cfg["readout_mode"] in {"linear_mse", "softmax_ce"}


def test_smoothed_simplex_learner_applies_fixed_uniform_floor() -> None:
    module = load_module()
    base = module.UPGDLearner.step2_default(
        n_heads=10,
        hidden_sizes=(4,),
        readout_mode="softmax_ce",
    )
    learner = module.SmoothedSimplexLearner(base, smoothing=0.40)
    state = learner.init(3, module.jr.key(0))
    observation = module.jnp.asarray([1.0, 0.0, -1.0], dtype=module.jnp.float32)
    target = module.jax.nn.one_hot(2, 10)

    raw_prediction = base.predict(state, observation)
    smoothed_prediction = learner.predict(state, observation)
    result = learner.update(state, observation, target)

    expected = 0.6 * raw_prediction + 0.4 * module.jnp.ones(10) / 10.0
    module.np.testing.assert_allclose(
        module.np.asarray(smoothed_prediction),
        module.np.asarray(expected),
        rtol=1e-6,
        atol=1e-6,
    )
    assert result.predictions.shape == (10,)
    assert learner.to_config()["smoothing"] == 0.40


def test_make_methods_includes_smoothed_single_upgd_when_requested() -> None:
    module = load_module()
    methods = module.make_methods(64, include_smoothed_single_upgd=True)

    for method in module.SMOOTHED_SINGLE_UPGD_METHODS:
        assert method in methods
        assert methods[method].to_config()["type"] == "SmoothedSimplexLearner"


def test_make_methods_includes_brier_single_upgd_when_requested() -> None:
    module = load_module()
    methods = module.make_methods(64, include_brier_single_upgd=True)

    for method in module.BRIER_SINGLE_UPGD_METHODS:
        assert method in methods
        cfg = methods[method].to_config()
        assert cfg["type"] == "UPGDLearner"
        assert cfg["readout_mode"] == "softmax_mse"
        assert cfg["readout_loss_mode"] == "softmax_mse"
        assert cfg["readout_prediction_mode"] == "softmax"


def test_temperature_scaled_simplex_learner_applies_fixed_temperature() -> None:
    module = load_module()
    base = module.UPGDLearner.step2_default(
        n_heads=10,
        hidden_sizes=(4,),
        readout_mode="softmax_ce",
    )
    learner = module.TemperatureScaledSimplexLearner(base, temperature=4.0)
    state = learner.init(3, module.jr.key(0))
    observation = module.jnp.asarray([1.0, 0.0, -1.0], dtype=module.jnp.float32)
    target = module.jax.nn.one_hot(2, 10)

    raw_prediction = base.predict(state, observation)
    scaled_prediction = learner.predict(state, observation)
    result = learner.update(state, observation, target)
    expected = module.jnp.power(module.jnp.maximum(raw_prediction, 1e-8), 0.25)
    expected = expected / module.jnp.sum(expected)

    module.np.testing.assert_allclose(
        module.np.asarray(scaled_prediction),
        module.np.asarray(expected),
        rtol=1e-6,
        atol=1e-6,
    )
    assert result.predictions.shape == (10,)
    assert learner.to_config()["temperature"] == 4.0


def test_make_methods_includes_temperature_single_upgd_when_requested() -> None:
    module = load_module()
    methods = module.make_methods(64, include_temperature_single_upgd=True)

    for method in module.TEMPERATURE_SINGLE_UPGD_METHODS:
        assert method in methods
        assert methods[method].to_config()["type"] == "TemperatureScaledSimplexLearner"


def test_rls_calibrated_learner_matches_runner_api() -> None:
    module = load_module()
    learner = module.make_rls_calibrated_candidate()
    state = learner.init(4, module.jr.key(0))
    observation = module.jnp.asarray([1.0, 0.0, -1.0, 0.5], dtype=module.jnp.float32)
    target = module.jax.nn.one_hot(3, module.N_CLASSES)

    result = learner.update(state, observation, target)

    assert learner.n_heads == module.N_CLASSES
    assert learner.calibration_dim == module.N_CLASSES + 1
    assert result.predictions.shape == (module.N_CLASSES,)
    module.np.testing.assert_allclose(
        float(module.jnp.sum(result.predictions)),
        1.0,
        rtol=1e-6,
        atol=1e-6,
    )
    cfg = learner.to_config()
    assert cfg["type"] == "RLSCalibratedLearner"
    assert cfg["prediction_mode"] == "simplex"
    assert cfg["identity_init"] is True
    assert cfg["init_requires_feature_dim"] is True
    assert cfg["base"]["type"] == "UPGDLearner"


def test_rls_calibrated_learner_uses_previous_gate_for_current_prediction() -> None:
    module = load_module()
    learner = module.make_rls_calibrated_candidate()
    state = learner.init(4, module.jr.key(0))
    observation = module.jnp.asarray([1.0, 0.0, -1.0, 0.5], dtype=module.jnp.float32)
    target = module.jax.nn.one_hot(3, module.N_CLASSES)
    base_prediction = learner._base.predict(state.base_state, observation)

    weights = module.jnp.zeros_like(state.weights)
    weights = weights.at[3, 0].set(1.0)
    state = state._replace(weights=weights)

    result = learner.update(state, observation, target)

    module.np.testing.assert_allclose(
        module.np.asarray(result.predictions),
        module.np.asarray(base_prediction),
        rtol=1e-6,
        atol=1e-6,
    )
    assert float(result.state.calibration_gate) == 1.0


def test_make_methods_includes_rls_calibrated_when_requested() -> None:
    module = load_module()
    methods = module.make_methods(64, include_rls_calibrated=True)

    assert module.RLS_CALIBRATED_METHOD in methods
    assert module.PRIMARY_RLS_CALIBRATED_METHOD in methods
    assert methods[module.RLS_CALIBRATED_METHOD].to_config()["type"] == (
        "RLSCalibratedLearner"
    )
    assert methods[module.PRIMARY_RLS_CALIBRATED_METHOD].to_config()[
        "init_requires_feature_dim"
    ] is False


def test_dream_replay_learner_scores_real_prediction_before_dreams() -> None:
    module = load_module()
    base = module.UPGDLearner.step2_default(
        n_heads=module.N_CLASSES,
        hidden_sizes=(4,),
        readout_mode="softmax_ce",
    )
    learner = module.DreamReplayLearner(
        base,
        capacity=4,
        dreams_per_step=1,
        warmup_steps=0,
        mode="surprise",
    )
    state = learner.init(3, module.jr.key(0))
    observation = module.jnp.asarray([1.0, 0.0, -1.0], dtype=module.jnp.float32)
    target = module.jax.nn.one_hot(2, module.N_CLASSES)
    base_result = base.update(state.base_state, observation, target)

    result = learner.update(state, observation, target)

    module.np.testing.assert_allclose(
        module.np.asarray(result.predictions),
        module.np.asarray(base_result.predictions),
        rtol=1e-6,
        atol=1e-6,
    )
    assert int(result.state.dream_count) == 1
    assert bool(result.state.valid[0])
    assert float(result.state.priorities[0]) >= 0.0


def test_make_methods_includes_dreaming_candidates_when_requested() -> None:
    module = load_module()
    methods = module.make_methods(64, include_dreaming_candidates=True)

    assert module.PRIMARY_DREAM_METHOD in methods
    assert methods[module.PRIMARY_DREAM_METHOD].to_config()["type"] == (
        "DreamReplayLearner"
    )
    for method in module.DREAM_SINGLE_UPGD_METHODS:
        assert method in methods
        assert methods[method].to_config()["type"] == "DreamReplayLearner"


def test_make_methods_includes_delight_candidates_when_requested() -> None:
    module = load_module()
    methods = module.make_methods(64, include_delight_candidates=True)

    for method in module.DELIGHT_METHODS:
        assert method in methods
        assert methods[method].to_config()["type"] == "DelightGatedLearner"


def test_delight_gated_candidate_matches_runner_api() -> None:
    module = load_module()
    base = module.make_single_upgd_candidates()["upgd_structure_softmax_h64"]
    learner = module.DelightGatedLearner(base, target_rate=1.0)
    state = learner.init(3, module.jr.key(0))
    observation = module.jnp.asarray([1.0, 0.0, -1.0], dtype=module.jnp.float32)
    target = module.jax.nn.one_hot(2, module.N_CLASSES)

    result = learner.update(state, observation, target)

    assert result.predictions.shape == (module.N_CLASSES,)
    assert int(result.state.step_count) == 1
    assert float(result.state.delight_ema) >= 0.0
    assert 0.0 <= float(result.state.gate_rate_ema) <= 1.0


def test_prototype_memory_candidate_matches_runner_api() -> None:
    module = load_module()
    learner = module.FixedPrototypeMemoryCandidate(feature_dim=4, slots_per_class=2)
    state = learner.init(4, module.jr.key(0))
    observation = module.jnp.asarray([1.0, 0.0, 0.0, 0.0], dtype=module.jnp.float32)
    target = module.jnp.asarray(
        [1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
        dtype=module.jnp.float32,
    )

    result = learner.update(state, observation, target)

    assert learner.n_heads == 10
    assert result.predictions.shape == (10,)
    assert int(result.state.step_count) == 1


def test_filter_methods_preserves_requested_subset_order() -> None:
    module = load_module()
    methods = module.filter_methods(
        {"a": object(), "b": object(), "c": object()},
        "c,a",
    )

    assert list(methods) == ["c", "a"]


def test_load_checkpoint_accepts_method_subset(tmp_path: Path) -> None:
    module = load_module()
    path = tmp_path / "resume.pkl"
    payload = {
        "version": module.CHECKPOINT_VERSION,
        "completed_steps": 12,
        "states": {"a": 1, "b": 2, "c": 3},
        "accumulators": {"a": 4, "b": 5, "c": 6},
        "config": {"methods": ["a", "b", "c"]},
    }
    path.write_bytes(pickle.dumps(payload))

    loaded = module.load_checkpoint(path, {"methods": ["c", "a"]})

    assert list(loaded["states"]) == ["c", "a"]
    assert list(loaded["accumulators"]) == ["c", "a"]
    assert loaded["config"]["methods"] == ["c", "a"]


def test_checkpoint_migration_adds_missing_target_simplex_ema() -> None:
    module = load_module()
    learner = module.make_step2_hybrid_learner(
        module.Step2HybridConfig(
            feature_dim=4,
            n_heads=3,
            hidden_sizes=(4,),
            readout_mode="softmax_ce",
        )
    )
    state = learner.init(module.jr.key(0))
    current_upgd_state = state.upgd_state.replace(
        previous_targets=module.jnp.asarray([0.0, 1.0, 0.0], dtype=module.jnp.float32)
    )
    legacy_upgd_state = object.__new__(module.UPGDState)
    for field_name in current_upgd_state.__dataclass_fields__:
        if field_name == "target_simplex_ema":
            continue
        object.__setattr__(
            legacy_upgd_state,
            field_name,
            getattr(current_upgd_state, field_name),
        )
    object.__setattr__(legacy_upgd_state, "unit_replacement_counts", None)

    migrated = module.migrate_checkpoint_state(
        state.replace(upgd_state=legacy_upgd_state)
    )

    assert hasattr(migrated.upgd_state, "target_simplex_ema")
    assert float(migrated.upgd_state.target_simplex_ema) == 1.0
    assert migrated.upgd_state.unit_replacement_counts is not None
