"""Tests for the Step 2 published-style stressor runner."""

from __future__ import annotations

import json
import sys
from argparse import Namespace
from pathlib import Path
from types import ModuleType
from typing import Any

import jax.numpy as jnp
import numpy as np
import pytest
from conftest import load_script

_SCRIPT_PATH = (
    Path(__file__).resolve().parents[1]
    / "examples"
    / "The Alberta Plan"
    / "Step2"
    / "step2_published_stressors.py"
)


def load_module() -> ModuleType:
    return load_script(_SCRIPT_PATH, "step2_published_stressors")


def make_dummy_classification_dataset(module: ModuleType) -> Any:
    """Create a tiny ten-class classification dataset."""
    rng = np.random.default_rng(0)
    x_train = rng.normal(size=(50, 16)).astype(np.float32)
    y_train = np.asarray([idx % module.N_CLASSES for idx in range(50)], dtype=np.int32)
    x_test = rng.normal(size=(20, 16)).astype(np.float32)
    y_test = np.asarray([idx % module.N_CLASSES for idx in range(20)], dtype=np.int32)
    return module.ClassificationDataset(
        x_train=x_train,
        y_train=y_train,
        x_test=x_test,
        y_test=y_test,
        metadata={"feature_dim": 16, "n_classes": module.N_CLASSES},
    )


def test_resize_digits_8x8_to_28x28_shape_and_corners() -> None:
    module = load_module()
    x: np.ndarray = np.arange(64, dtype=np.float32).reshape(1, 64)

    resized = module.resize_digits_8x8_to_28x28(x)

    assert resized.shape == (1, 784)
    image = resized.reshape(1, 28, 28)[0]
    assert image[0, 0] == pytest.approx(0.0)
    assert image[-1, -1] == pytest.approx(63.0)


def test_permuted_classification_stream_shapes() -> None:
    module = load_module()
    dataset = make_dummy_classification_dataset(module)

    stream = module.make_permuted_classification_stream(
        dataset=dataset,
        steps=30,
        seed=1,
        n_permutations=3,
        task_block_size=10,
        sample_with_replacement=False,
        task_sampling="random",
    )

    assert stream.observations.shape == (30, 16)
    assert stream.targets.shape == (30, module.N_CLASSES)
    assert stream.labels.shape == (30,)
    assert stream.test_views.shape == (3, 20, 16)
    assert len(stream.feature_orders) == 3
    assert stream.metadata["task_ids_observed"] == [0, 1, 2]


def test_permuted_classification_stream_sequential_epoch_sampling() -> None:
    module = load_module()
    dataset = make_dummy_classification_dataset(module)

    stream = module.make_permuted_classification_stream(
        dataset=dataset,
        steps=20,
        seed=4,
        n_permutations=2,
        task_block_size=10,
        sample_with_replacement=False,
        task_sampling="sequential_epoch",
    )

    assert stream.observations.shape == (20, 16)
    assert stream.metadata["task_sampling"] == "sequential_epoch"
    assert stream.metadata["full_mnist_task_blocks"] is False


def test_permuted_classification_stream_evaluates_observed_views_by_default() -> None:
    module = load_module()
    dataset = make_dummy_classification_dataset(module)

    stream = module.make_permuted_classification_stream(
        dataset=dataset,
        steps=10,
        seed=5,
        n_permutations=4,
        task_block_size=10,
        sample_with_replacement=False,
        task_sampling="sequential_epoch",
    )

    assert stream.test_views.shape == (1, 20, 16)
    assert stream.metadata["task_ids_observed"] == [0]
    assert stream.metadata["test_task_ids_evaluated"] == [0]
    assert stream.metadata["test_views_cover_observed_permutations"] is True
    assert stream.metadata["test_views_cover_all_permutations"] is False


def test_optional_positive_int_accepts_all_sentinel() -> None:
    module = load_module()

    assert module.optional_positive_int("all") is None
    assert module.optional_positive_int("25") == 25
    with pytest.raises(Exception):
        module.optional_positive_int("0")


def test_canonical_mnist_split_uses_standard_openml_indices() -> None:
    module = load_module()
    x = np.zeros((70_000, 2), dtype=np.float32)
    y = np.arange(70_000, dtype=np.int32) % module.N_CLASSES

    train_idx, test_idx, split_kind = module.split_mnist_arrays(
        x=x,
        y=y,
        seed=0,
        train_fraction=0.7,
        split="canonical",
    )

    assert split_kind == "openml_canonical_60000_10000"
    assert train_idx.shape == (60_000,)
    assert test_idx.shape == (10_000,)
    assert train_idx[0] == 0
    assert test_idx[0] == 60_000


def test_slowly_changing_regression_stream_shapes_and_flips() -> None:
    module = load_module()

    observations, targets, meta = module.make_slowly_changing_regression_stream(
        steps=25,
        seed=2,
        m_bits=6,
        slow_bits=2,
        flip_interval=5,
        target_hidden=8,
        beta=0.7,
        noise_std=0.0,
    )

    assert observations.shape == (25, 7)
    assert targets.shape == (25, 1)
    assert meta["n_flips"] == 4
    assert meta["feature_dim"] == 7


def test_slowly_changing_regression_dohare_config_metadata() -> None:
    module = load_module()

    _, _, meta = module.make_slowly_changing_regression_stream(
        steps=25,
        seed=2,
        m_bits=20,
        slow_bits=15,
        flip_interval=10_000,
        target_hidden=100,
        beta=0.7,
        noise_std=0.0,
    )

    assert meta["matches_dohare_public_config"] is True
    assert meta["matches_dohare_target_family"] is True
    assert meta["meets_dohare_public_scr_step_count"] is False
    assert meta["matches_dohare_public_scr_protocol"] is False
    assert meta["task_id_provided_to_learner"] is False


def make_scr_status_results(
    module: ModuleType,
    dataset_meta: dict[str, object],
) -> dict[str, object]:
    """Create a minimal SCR aggregate result for status tests."""
    return {
        "aggregate": {
            "slowly_changing_regression": {
                "comparisons": {
                    "final_window_mse": {
                        "mixture_vs_best_mlp": {
                            "paired_diff_mean_positive_favors_mixture": 0.0,
                            "wins_for_mixture": 1,
                            "wins_for_baseline": 0,
                            "ties": 0,
                        }
                    },
                }
            }
        },
        "datasets": {
            "slowly_changing_regression": {
                "steps": module.DOHARE_SCR_MIN_PUBLISHED_STEPS,
                "matches_dohare_public_config": True,
                "task_id_provided_to_learner": False,
                "uses_online_stream_only": True,
                "uses_fixed_target_network": True,
                **dataset_meta,
            }
        },
    }


def test_benchmark_status_accepts_published_scale_scr_only_at_million_steps() -> None:
    module = load_module()

    status = module.benchmark_status(make_scr_status_results(module, {}))

    assert status["uses_dohare_public_scr_config"] is True
    assert status["scr_meets_published_step_count"] is True
    assert status["matches_dohare_public_scr_protocol"] is True
    assert status["published_scale_scr_claim_supported"] is True


def test_benchmark_status_rejects_short_scr_for_published_scale() -> None:
    module = load_module()

    status = module.benchmark_status(
        make_scr_status_results(
            module,
            {"steps": module.DOHARE_SCR_MIN_PUBLISHED_STEPS - 1},
        )
    )

    assert status["uses_dohare_public_scr_config"] is True
    assert status["scr_meets_published_step_count"] is False
    assert status["matches_dohare_public_scr_protocol"] is False
    assert status["published_scale_scr_claim_supported"] is False


def test_benchmark_status_rejects_scr_task_id_leakage() -> None:
    module = load_module()

    status = module.benchmark_status(
        make_scr_status_results(module, {"task_id_provided_to_learner": True})
    )

    assert status["scr_task_id_provided_to_learner"] is True
    assert status["matches_dohare_public_scr_protocol"] is False
    assert status["published_scale_scr_claim_supported"] is False


def test_sklearn_digits_28x28_fallback_is_capped_and_labelled() -> None:
    pytest.importorskip("sklearn.datasets")
    module = load_module()

    data = module.load_sklearn_digits_source(
        seed=3,
        train_fraction=0.7,
        max_train_examples=50,
        max_test_examples=20,
        expand_to_28x28=True,
    )

    assert data.x_train.shape == (50, 784)
    assert data.x_test.shape == (20, 784)
    assert data.metadata["is_true_mnist"] is False
    assert data.metadata["source_kind"] == "local_sklearn_digits_28x28"


def test_benchmark_status_tracks_nonnegative_primary_comparisons() -> None:
    module = load_module()
    results = {
        "aggregate": {
            "permuted_mnist_like": {
                "comparisons": {
                    "final_window_mse": {
                        "mixture_vs_best_mlp": {
                            "paired_diff_mean_positive_favors_mixture": 0.1,
                            "wins_for_mixture": 2,
                            "wins_for_baseline": 0,
                            "ties": 0,
                        }
                    },
                    "test_accuracy": {
                        "mixture_vs_best_mlp": {
                            "paired_diff_mean_positive_favors_mixture": -0.01,
                            "wins_for_mixture": 0,
                            "wins_for_baseline": 2,
                            "ties": 0,
                        }
                    },
                }
            }
        }
    }

    status = module.benchmark_status(results)

    assert status["all_primary_nonnegative_vs_best_mlp"] is False
    assert status["published_scale_external_claim_supported"] is False
    assert (
        status["checks"]["permuted_mnist_like"]["final_window_mse"][
            "paired_diff_mean_positive_favors_portfolio"
        ]
        == pytest.approx(0.1)
    )


def make_status_results(module: ModuleType, dataset_meta: dict[str, object]) -> dict[str, object]:
    """Create a minimal aggregate result for status tests."""
    return {
        "aggregate": {
            "permuted_mnist_like": {
                "comparisons": {
                    "final_window_mse": {
                        "mixture_vs_best_mlp": {
                            "paired_diff_mean_positive_favors_mixture": 0.0,
                            "wins_for_mixture": 1,
                            "wins_for_baseline": 0,
                            "ties": 0,
                        }
                    },
                    "test_accuracy": {
                        "mixture_vs_best_mlp": {
                            "paired_diff_mean_positive_favors_mixture": 0.0,
                            "wins_for_mixture": 1,
                            "wins_for_baseline": 0,
                            "ties": 0,
                        }
                    },
                }
            }
        },
        "datasets": {
            "permuted_mnist_like": {
                "steps": module.DOHARE_OPMNIST_TOTAL_STEPS,
                "n_permutations": module.DOHARE_OPMNIST_TASKS,
                "is_true_mnist": True,
                "source_kind": "openml_mnist_784",
                "is_full_mnist_split": True,
                "full_mnist_task_blocks": True,
                "task_id_provided_to_learner": False,
                "single_pass_examples_within_task": True,
                "permutations_are_random_pixel_orders": True,
                "prediction_before_update_every_step": True,
                "all_experts_update_every_step": True,
                "completed_full_task_blocks": module.DOHARE_OPMNIST_TASKS,
                "opmnist_completed_full_60000_task_blocks": (
                    module.DOHARE_OPMNIST_TASKS
                ),
                "matches_dohare_opmnist_core_protocol": True,
                "matches_dohare_opmnist_published_task_count": True,
                **dataset_meta,
            }
        },
    }


def test_benchmark_status_accepts_true_full_scale_opmnist_flags() -> None:
    module = load_module()

    status = module.benchmark_status(make_status_results(module, {}))

    assert status["uses_true_mnist"] is True
    assert status["uses_true_openml_mnist"] is True
    assert status["uses_full_mnist_split"] is True
    assert status["uses_full_mnist_task_blocks"] is True
    assert status["task_id_provided_to_learner"] is False
    assert status["single_pass_examples_within_task"] is True
    assert status["uses_random_pixel_permutations_for_all_tasks"] is True
    assert status["matches_dohare_opmnist_published_task_count"] is True
    assert status["prediction_before_update_every_step"] is True
    assert status["all_experts_update_every_step"] is True
    assert status["opmnist_completed_full_60000_task_blocks"] == 800
    assert status["published_scale_external_claim_supported"] is True


def test_benchmark_status_rejects_sklearn_fallback_for_published_scale() -> None:
    module = load_module()

    status = module.benchmark_status(
        make_status_results(
            module,
            {
                "is_true_mnist": False,
                "source_kind": "local_sklearn_digits_28x28",
                "is_full_mnist_split": False,
            },
        )
    )

    assert status["uses_true_mnist"] is False
    assert status["uses_full_mnist_split"] is False
    assert status["published_scale_external_claim_supported"] is False


def test_benchmark_status_rejects_short_task_blocks_for_published_scale() -> None:
    module = load_module()

    status = module.benchmark_status(
        make_status_results(
            module,
            {
                "task_block_size": 10_000,
                "full_mnist_task_blocks": False,
                "matches_dohare_opmnist_core_protocol": False,
            },
        )
    )

    assert status["uses_full_mnist_task_blocks"] is False
    assert status["matches_dohare_opmnist_core_protocol"] is False
    assert status["published_scale_external_claim_supported"] is False


def test_benchmark_status_rejects_missing_temporal_uniformity_flags() -> None:
    module = load_module()

    status = module.benchmark_status(
        make_status_results(
            module,
            {
                "prediction_before_update_every_step": False,
                "all_experts_update_every_step": True,
            },
        )
    )

    assert status["prediction_before_update_every_step"] is False
    assert status["published_scale_external_claim_supported"] is False


def test_opmnist_protocol_metadata_tracks_partial_vs_published_blocks() -> None:
    module = load_module()
    dataset = make_dummy_classification_dataset(module)
    dataset = module.ClassificationDataset(
        x_train=np.zeros((60_000, 16), dtype=np.float32),
        y_train=np.zeros(60_000, dtype=np.int32),
        x_test=dataset.x_test,
        y_test=dataset.y_test,
        metadata={
            "is_true_mnist": True,
            "is_full_mnist_split": True,
            "feature_dim": 16,
            "n_classes": module.N_CLASSES,
        },
    )

    meta = module.opmnist_protocol_metadata(
        dataset=dataset,
        steps=5 * module.DOHARE_OPMNIST_TASK_BLOCK_SIZE,
        seed=0,
        n_permutations=module.DOHARE_OPMNIST_TASKS,
        task_block_size=module.DOHARE_OPMNIST_TASK_BLOCK_SIZE,
        sample_with_replacement=False,
        task_sampling="sequential_epoch",
        include_identity_permutation=False,
        max_test_permutation_views=5,
        evaluate_all_permutation_views=False,
        observed_task_ids=[0, 1, 2, 3, 4],
        test_task_ids=[0, 1, 2, 3, 4],
        streaming_runner=True,
        chunk_size=10_000,
        resume_checkpoint_path="resume.pkl",
    )

    assert meta["matches_dohare_opmnist_core_protocol"] is True
    assert meta["opmnist_completed_full_60000_task_blocks"] == 5
    assert meta["matches_dohare_opmnist_published_task_count"] is False
    assert meta["streaming_runner"] is True
    assert meta["resumable_runner"] is True


def test_permuted_classification_chunk_is_reproducible_and_sequential() -> None:
    module = load_module()
    dataset = make_dummy_classification_dataset(module)
    feature_orders = module.make_feature_orders(
        seed=11,
        feature_dim=16,
        n_permutations=2,
        include_identity_permutation=False,
    )

    first_obs, first_targets, first_labels = module.make_permuted_classification_chunk(
        dataset=dataset,
        start_step=0,
        chunk_steps=12,
        seed=11,
        n_permutations=2,
        task_block_size=10,
        sample_with_replacement=False,
        task_sampling="sequential_epoch",
        feature_orders=feature_orders,
    )
    second_obs, second_targets, second_labels = module.make_permuted_classification_chunk(
        dataset=dataset,
        start_step=0,
        chunk_steps=12,
        seed=11,
        n_permutations=2,
        task_block_size=10,
        sample_with_replacement=False,
        task_sampling="sequential_epoch",
        feature_orders=feature_orders,
    )

    np.testing.assert_allclose(np.asarray(first_obs), np.asarray(second_obs))
    np.testing.assert_allclose(np.asarray(first_targets), np.asarray(second_targets))
    np.testing.assert_array_equal(first_labels, second_labels)


def test_opmnist_checkpoint_round_trips_progress(tmp_path: Path) -> None:
    module = load_module()
    path = tmp_path / "resume.pkl"
    config = {
        "seed": 0,
        "stream_seed": 11,
        "feature_dim": 4,
        "n_permutations": 2,
        "include_identity_permutation": False,
    }
    accumulator = module.init_prequential_accumulator()
    carry = (jnp.asarray([1.0], dtype=jnp.float32),)
    feature_orders = module.make_feature_orders(
        seed=11,
        feature_dim=4,
        n_permutations=2,
        include_identity_permutation=False,
    )

    module.save_opmnist_checkpoint(
        path,
        completed_steps=12,
        carry=carry,
        accumulator=accumulator,
        feature_orders=feature_orders,
        config=config,
        elapsed_s=3.0,
        progress_history=[
            {
                "completed_steps": 12,
                "chunk_steps": 12,
                "steps_per_second": 4.0,
            }
        ],
    )
    loaded = module.load_opmnist_checkpoint(path, config)

    assert loaded["completed_steps"] == 12
    assert loaded["elapsed_s"] == pytest.approx(3.0)
    assert path.with_suffix(".pkl.json").exists()
    np.testing.assert_array_equal(loaded["feature_orders"][1], feature_orders[1])


def test_opmnist_checkpoint_rejects_nondeterministic_feature_orders(tmp_path: Path) -> None:
    module = load_module()
    path = tmp_path / "resume.pkl"
    config = {
        "seed": 0,
        "stream_seed": 11,
        "feature_dim": 4,
        "n_permutations": 2,
        "include_identity_permutation": False,
    }
    feature_orders = list(
        module.make_feature_orders(
            seed=11,
            feature_dim=4,
            n_permutations=2,
            include_identity_permutation=False,
        )
    )
    feature_orders[1] = np.roll(feature_orders[1], 1).astype(np.int32)

    module.save_opmnist_checkpoint(
        path,
        completed_steps=12,
        carry=(jnp.asarray([1.0], dtype=jnp.float32),),
        accumulator=module.init_prequential_accumulator(),
        feature_orders=tuple(feature_orders),
        config=config,
    )

    with pytest.raises(RuntimeError, match="deterministic stream seed"):
        module.load_opmnist_checkpoint(path, config)


def test_opmnist_checkpoint_rejects_invalid_feature_order_permutation(
    tmp_path: Path,
) -> None:
    module = load_module()
    path = tmp_path / "resume.pkl"
    config = {
        "seed": 0,
        "stream_seed": 11,
        "feature_dim": 4,
        "n_permutations": 2,
        "include_identity_permutation": False,
    }
    feature_orders = list(
        module.make_feature_orders(
            seed=11,
            feature_dim=4,
            n_permutations=2,
            include_identity_permutation=False,
        )
    )
    feature_orders[0] = np.asarray([0, 0, 2, 3], dtype=np.int32)

    module.save_opmnist_checkpoint(
        path,
        completed_steps=12,
        carry=(jnp.asarray([1.0], dtype=jnp.float32),),
        accumulator=module.init_prequential_accumulator(),
        feature_orders=tuple(feature_orders),
        config=config,
    )

    with pytest.raises(RuntimeError, match="not a permutation"):
        module.load_opmnist_checkpoint(path, config)


def test_opmnist_checkpoint_loader_accepts_legacy_openml_identity_keys(
    tmp_path: Path,
) -> None:
    module = load_module()
    path = tmp_path / "resume.pkl"
    config = {
        "seed": 0,
        "source_kind": "openml_mnist_784",
        "stream_seed": 11,
        "feature_dim": 4,
        "n_permutations": 2,
        "task_block_size": module.DOHARE_OPMNIST_TASK_BLOCK_SIZE,
        "include_identity_permutation": False,
    }
    feature_orders = module.make_feature_orders(
        seed=11,
        feature_dim=4,
        n_permutations=2,
        include_identity_permutation=False,
    )
    module.save_opmnist_checkpoint(
        path,
        completed_steps=12,
        carry=(jnp.asarray([1.0], dtype=jnp.float32),),
        accumulator=module.init_prequential_accumulator(),
        feature_orders=feature_orders,
        config=config,
    )

    loaded = module.load_opmnist_checkpoint(
        path,
        {
            **config,
            "dataset_split": "openml_canonical_60000_10000",
            "dataset_n_train": 60_000,
            "dataset_n_test": 10_000,
            "dataset_is_full_mnist_split": True,
            "max_train_examples": None,
            "max_test_examples": None,
        },
    )

    assert loaded["completed_steps"] == 12


def test_opmnist_checkpoint_migrates_legacy_upgd_state() -> None:
    module = load_module()
    args = Namespace(
        step_size=0.03,
        sparsity=0.5,
        perturbation_sigma=1e-4,
        perturbation_warmup_steps=0,
        perturbation_ramp_steps=0,
        dynamic_hidden_size=8,
        dynamic_utility_decay=0.99,
        dynamic_rewire_interval=20,
        dynamic_unit_replacement_rate=0.05,
        final_window=10,
    )
    _, carry = module.make_portfolio_components_and_carry(
        feature_dim=4,
        n_heads=module.N_CLASSES,
        key=module.jr.key(0),
        args=args,
    )
    upgd_state = carry[3]
    legacy_upgd_state = object.__new__(type(upgd_state))
    for key, value in upgd_state.__dict__.items():
        if key not in {
            "unit_long_utilities",
            "unit_gradient_emas",
            "loss_fast_ema",
            "loss_slow_ema",
            "previous_targets",
            "target_repeat_ema",
            "meta_trunk_log_scale",
            "meta_head_weight_log_scale",
            "meta_head_bias_log_scale",
            "meta_repetition_log_scale",
            "adaptive_kappa_log_scale",
            "previous_trunk_weight_grads",
            "previous_trunk_bias_grads",
            "previous_head_weight_grads",
            "previous_head_bias_grads",
        }:
            object.__setattr__(legacy_upgd_state, key, value)
    legacy_carry = tuple(
        legacy_upgd_state if idx == 3 else value for idx, value in enumerate(carry)
    )

    migrated_carry, migrated_fields = module.migrate_opmnist_checkpoint_carry(
        legacy_carry
    )
    migrated_upgd_state = migrated_carry[3]

    assert "upgd.unit_long_utilities" in migrated_fields
    assert "upgd.unit_gradient_emas" in migrated_fields
    assert "upgd.meta_trunk_log_scale" in migrated_fields
    assert "upgd.previous_head_weight_grads" in migrated_fields
    assert hasattr(migrated_upgd_state, "loss_fast_ema")
    assert hasattr(migrated_upgd_state, "loss_slow_ema")
    assert hasattr(migrated_upgd_state, "target_repeat_ema")
    assert hasattr(migrated_upgd_state, "adaptive_kappa_log_scale")
    np.testing.assert_array_equal(
        np.asarray(migrated_upgd_state.unit_long_utilities[0]),
        np.asarray(upgd_state.unit_utilities[0]),
    )
    np.testing.assert_array_equal(
        np.asarray(migrated_upgd_state.previous_head_weight_grads[0]),
        np.zeros_like(np.asarray(upgd_state.head_params.weights[0])),
    )


def test_opmnist_status_from_checkpoint_reports_eta(tmp_path: Path) -> None:
    module = load_module()
    path = tmp_path / "resume.pkl"
    module.save_opmnist_checkpoint(
        path,
        completed_steps=20,
        carry=(jnp.asarray([1.0], dtype=jnp.float32),),
        accumulator=module.init_prequential_accumulator(),
        feature_orders=(np.arange(4, dtype=np.int32),),
        config={"seed": 0},
        elapsed_s=4.0,
        progress_history=[
            {
                "completed_steps": 20,
                "chunk_steps": 10,
                "steps_per_second": 10.0,
            }
        ],
    )

    status = module.opmnist_status_from_checkpoint(
        path,
        target_steps=100,
        task_block_size=10,
    )

    assert status["completed_steps"] == 20
    assert status["remaining_steps"] == 80
    assert status["completed_full_task_blocks"] == 2
    assert status["target_full_task_blocks"] == 10
    assert status["recent_steps_per_second"] == pytest.approx(10.0)
    assert status["eta_seconds"] == pytest.approx(8.0)


def test_opmnist_status_command_writes_json_artifact(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module = load_module()
    checkpoint_path = tmp_path / "resume.pkl"
    status_path = tmp_path / "status.json"
    module.save_opmnist_checkpoint(
        checkpoint_path,
        completed_steps=30,
        carry=(jnp.asarray([1.0], dtype=jnp.float32),),
        accumulator=module.init_prequential_accumulator(),
        feature_orders=(np.arange(4, dtype=np.int32),),
        config={"seed": 0},
        elapsed_s=6.0,
        progress_history=[
            {
                "completed_steps": 30,
                "chunk_steps": 10,
                "steps_per_second": 5.0,
            }
        ],
    )
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "step2_published_stressors.py",
            "--opmnist-status-checkpoint",
            str(checkpoint_path),
            "--opmnist-status-target-steps",
            "100",
            "--opmnist-status-output",
            str(status_path),
        ],
    )

    module.main()

    payload = json.loads(status_path.read_text(encoding="utf-8"))
    assert payload["schema"] == "alberta.opmnist.status_report.v1"
    assert payload["checkpoint"]["completed_steps"] == 30
    assert payload["checkpoint"]["remaining_steps"] == 70


def test_run_manifest_contains_command_config_and_git_metadata(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module = load_module()
    monkeypatch.setattr(sys, "argv", ["step2_published_stressors.py", "--smoke"])
    args = module.parse_args()
    module.apply_run_preset(args)

    manifest = module.run_manifest(args, ("permuted_mnist_like",))

    assert manifest["schema"] == "alberta.opmnist.run_manifest.v1"
    assert "step2_published_stressors.py" in manifest["command"]
    assert manifest["config"]["benchmarks"] == ["permuted_mnist_like"]
    assert "git" in manifest
    assert "dirty" in manifest["git"]


def test_opmnist_checkpoint_loader_accepts_legacy_default_keys(tmp_path: Path) -> None:
    module = load_module()
    path = tmp_path / "resume.pkl"
    module.save_opmnist_checkpoint(
        path,
        completed_steps=1,
        carry=(jnp.asarray([1.0], dtype=jnp.float32),),
        accumulator=module.init_prequential_accumulator(),
        feature_orders=(np.arange(4, dtype=np.int32),),
        config={"seed": 0},
    )

    loaded = module.load_opmnist_checkpoint(
        path,
        {
            "seed": 0,
            "step_size": 0.03,
            "perturbation_sigma": 1e-4,
            "dynamic_rewire_interval": 240,
            "online_retention_mse_guard": True,
        },
    )

    assert loaded["completed_steps"] == 1


def test_opmnist_eta_from_results_uses_wall_clock(tmp_path: Path) -> None:
    module = load_module()
    path = tmp_path / "results.json"
    path.write_text(
        """{
          "wall_clock_s": 5.0,
          "datasets": {
            "permuted_mnist_like": {"steps": 50}
          },
          "status": {"published_scale_external_claim_supported": false}
        }""",
        encoding="utf-8",
    )

    status = module.opmnist_eta_from_results(
        path,
        target_steps=100,
        task_block_size=10,
    )

    assert status["completed_steps"] == 50
    assert status["overall_steps_per_second"] == pytest.approx(10.0)
    assert status["eta_seconds"] == pytest.approx(5.0)


def test_dynamic_sparse_deployment_objective_is_expert_only() -> None:
    module = load_module()
    metrics = np.zeros((1, module.PRED_START + len(module.METHOD_NAMES)), dtype=np.float32)
    args = Namespace(digits_deployment_objective="dynamic_sparse")

    weights = module.final_deployment_tracking_weights(metrics, args)

    assert weights[module.EXPERT_NAMES.index("dynamic_sparse")] == pytest.approx(1.0)
    assert float(np.sum(weights)) == pytest.approx(1.0)
