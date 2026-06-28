"""Smoke tests for the Step 2 external benchmark suite."""

from __future__ import annotations

from pathlib import Path
from types import ModuleType

import numpy as np
from conftest import load_script

_SCRIPT_PATH = (
    Path(__file__).resolve().parents[1]
    / "examples"
    / "The Alberta Plan"
    / "Step2"
    / "step2_external_suite.py"
)


def load_module() -> ModuleType:
    return load_script(_SCRIPT_PATH, "step2_external_suite")


def test_domain_matrix_specs_include_worker_c_stressors() -> None:
    module = load_module()

    specs = module.benchmark_specs(
        (
            "digits_mask_noise",
            "diabetes_regression",
            "dense_exact_zero",
            "sparse_multilabel",
            "temporal_delayed_history",
        ),
        n_permutations=3,
    )

    assert [spec.name for spec in specs] == [
        "digits_mask_noise",
        "diabetes_regression",
        "dense_exact_zero",
        "sparse_multilabel",
        "temporal_delayed_history",
    ]
    assert [spec.task_kind for spec in specs] == [
        "multiclass",
        "regression",
        "regression",
        "multilabel",
        "regression",
    ]


def test_dense_exact_zero_stream_has_exact_zero_targets() -> None:
    module = load_module()
    spec = module.benchmark_specs(("dense_exact_zero",), n_permutations=3)[0]
    dataset = module.load_dataset("dense_exact_zero", seed=0, train_fraction=0.7)

    observations, targets, labels, _, meta = module.make_online_sequence(
        dataset=dataset,
        spec=spec,
        steps=32,
        seed=10,
        permutation_block_size=8,
    )

    assert observations.shape == (32, 48)
    assert targets.shape == (32, 1)
    assert labels.shape == (32,)
    assert meta["task_kind"] == "regression"
    np.testing.assert_array_equal(np.asarray(targets), np.zeros((32, 1), dtype=np.float32))


def test_sparse_multilabel_stream_keeps_multi_hot_targets() -> None:
    module = load_module()
    spec = module.benchmark_specs(("sparse_multilabel",), n_permutations=3)[0]
    dataset = module.load_dataset("sparse_multilabel", seed=0, train_fraction=0.7)

    _, targets, labels, _, meta = module.make_online_sequence(
        dataset=dataset,
        spec=spec,
        steps=40,
        seed=12,
        permutation_block_size=10,
    )

    target_arr = np.asarray(targets)
    assert target_arr.shape == (40, 6)
    assert labels.shape == (40,)
    assert meta["task_kind"] == "multilabel"
    assert np.all(np.sum(target_arr, axis=1) >= 1.0)


def test_temporal_delayed_history_stream_is_sequential_regression() -> None:
    module = load_module()
    spec = module.benchmark_specs(("temporal_delayed_history",), n_permutations=3)[0]
    dataset = module.load_dataset("temporal_delayed_history", seed=0, train_fraction=0.7)

    observations, targets, _, _, meta = module.make_online_sequence(
        dataset=dataset,
        spec=spec,
        steps=25,
        seed=0,
        permutation_block_size=10,
    )

    np.testing.assert_allclose(np.asarray(observations), dataset.x_train[:25])
    np.testing.assert_allclose(np.asarray(targets), dataset.y_train[:25])
    assert meta["protocol"] == "sequential"
    assert meta["task_kind"] == "regression"


def test_external_suite_exposes_deeper_mlp_baseline() -> None:
    module = load_module()

    learner = module.make_learner(
        method="mlp_deep",
        n_classes=3,
        hidden_sizes=(16,),
        step_size=0.03,
        sparsity=0.5,
        task_kind="multiclass",
        perturbation_sigma=1e-4,
        utility_decay=0.995,
        cbp_decay_rate=0.99,
        cbp_replacement_rate=1e-4,
        cbp_maturity_threshold=100,
    )

    assert "mlp_deep" in module.DEFAULT_METHODS
    assert learner.to_config()["hidden_sizes"] == [16, 16]


def test_external_suite_exposes_upgd_regression_tuning_variants() -> None:
    module = load_module()

    fast = module.make_learner(
        method="upgd_fast",
        n_classes=1,
        hidden_sizes=(16,),
        step_size=0.03,
        sparsity=0.5,
        task_kind="regression",
        perturbation_sigma=1e-4,
        utility_decay=0.995,
        cbp_decay_rate=0.99,
        cbp_replacement_rate=1e-4,
        cbp_maturity_threshold=100,
    )
    mean = module.make_learner(
        method="upgd_mean",
        n_classes=1,
        hidden_sizes=(16,),
        step_size=0.03,
        sparsity=0.5,
        task_kind="regression",
        perturbation_sigma=1e-4,
        utility_decay=0.995,
        cbp_decay_rate=0.99,
        cbp_replacement_rate=1e-4,
        cbp_maturity_threshold=100,
    )

    assert {"upgd_fast", "upgd_mean", "upgd_wide"} <= set(module.DEFAULT_METHODS)
    assert fast.to_config()["loss_normalization"] == "target_structure"
    assert fast.to_config()["perturbation_interval"] == 1
    assert mean.to_config()["loss_normalization"] == "mean"


def test_external_suite_exposes_regression_rescue_variants() -> None:
    module = load_module()

    reg_k2 = module.make_learner(
        method="upgd_reg_k2",
        n_classes=1,
        hidden_sizes=(16,),
        step_size=0.03,
        sparsity=0.5,
        task_kind="regression",
        perturbation_sigma=1e-4,
        utility_decay=0.995,
        cbp_decay_rate=0.99,
        cbp_replacement_rate=1e-4,
        cbp_maturity_threshold=100,
    )
    reg_input = module.make_learner(
        method="upgd_reg_input",
        n_classes=1,
        hidden_sizes=(16,),
        step_size=0.03,
        sparsity=0.5,
        task_kind="regression",
        perturbation_sigma=1e-4,
        utility_decay=0.995,
        cbp_decay_rate=0.99,
        cbp_replacement_rate=1e-4,
        cbp_maturity_threshold=100,
    )

    assert {"upgd_reg_k2", "upgd_reg_noln", "upgd_reg_deep"} <= set(
        module.ALLOWED_METHODS
    )
    assert reg_k2.to_config()["bounder"]["kappa"] == 2.0
    assert reg_k2.to_config()["loss_normalization"] == "mean"
    assert reg_input.to_config()["readout_input_mode"] == "hidden_plus_input"


def test_external_suite_exposes_passthrough_rescue_variants() -> None:
    module = load_module()

    deep = module.make_learner(
        method="upgd_reg_passthrough_deep",
        n_classes=1,
        hidden_sizes=(16,),
        step_size=0.03,
        sparsity=0.5,
        task_kind="regression",
        perturbation_sigma=1e-4,
        utility_decay=0.995,
        cbp_decay_rate=0.99,
        cbp_replacement_rate=1e-4,
        cbp_maturity_threshold=100,
    )
    temporal = module.make_learner(
        method="upgd_temporal_fast_passthrough",
        n_classes=1,
        hidden_sizes=(16,),
        step_size=0.03,
        sparsity=0.5,
        task_kind="regression",
        perturbation_sigma=1e-4,
        utility_decay=0.995,
        cbp_decay_rate=0.99,
        cbp_replacement_rate=1e-4,
        cbp_maturity_threshold=100,
    )
    no_mutation = module.make_learner(
        method="upgd_temporal_passthrough_no_mutation",
        n_classes=1,
        hidden_sizes=(16,),
        step_size=0.03,
        sparsity=0.5,
        task_kind="regression",
        perturbation_sigma=1e-4,
        utility_decay=0.995,
        cbp_decay_rate=0.99,
        cbp_replacement_rate=1e-4,
        cbp_maturity_threshold=100,
    )

    assert {
        "upgd_reg_passthrough_deep",
        "upgd_temporal_fast_passthrough",
        "upgd_temporal_passthrough_no_mutation",
    } <= set(module.ALLOWED_METHODS)
    assert deep.to_config()["hidden_sizes"] == [16, 16]
    assert deep.to_config()["readout_head_normalization"] == "hidden_norm"
    assert temporal.to_config()["head_step_size_multiplier"] == 2.0
    assert no_mutation.to_config()["perturbation_sigma"] == 0.0


def test_temporal_context_augmentation_is_causal() -> None:
    module = load_module()
    observations = np.asarray([[1.0, 2.0], [3.0, 5.0]], dtype=np.float32)

    augmented = module.augment_temporal_context_np(observations, decay=0.5)

    assert augmented.shape == (2, 8)
    np.testing.assert_allclose(augmented[0, :2], observations[0])
    np.testing.assert_allclose(augmented[0, 2:4], np.zeros(2, dtype=np.float32))
    np.testing.assert_allclose(augmented[0, 4:6], np.zeros(2, dtype=np.float32))
    np.testing.assert_allclose(augmented[1, 2:4], observations[0])
    np.testing.assert_allclose(augmented[1, 4:6], 0.5 * observations[0])
