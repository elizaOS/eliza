"""Tests for the Step 2 learned resource-manager stateful external runner."""

from __future__ import annotations

from pathlib import Path
from types import ModuleType

import numpy as np
import pytest
from conftest import load_script

_SCRIPT_PATH = (
    Path(__file__).resolve().parents[1]
    / "examples"
    / "The Alberta Plan"
    / "Step2"
    / "step2_resource_manager_stateful_external.py"
)


def load_module() -> ModuleType:
    return load_script(_SCRIPT_PATH, "step2_resource_manager_stateful_external")


def make_dummy_digits_data(module: ModuleType) -> object:
    """Create a tiny in-memory digits-shaped dataset."""
    rng = np.random.default_rng(0)
    x_train = rng.normal(size=(40, 8)).astype(np.float32)
    y_train = np.asarray([idx % module.N_CLASSES for idx in range(40)], dtype=np.int32)
    x_test = rng.normal(size=(20, 8)).astype(np.float32)
    y_test = np.asarray([idx % module.N_CLASSES for idx in range(20)], dtype=np.int32)
    return module.DigitsData(
        x_train=x_train,
        y_train=y_train,
        x_test=x_test,
        y_test=y_test,
        metadata={"feature_dim": 8, "n_classes": module.N_CLASSES},
    )


def test_recurrent_permutation_stream_shapes() -> None:
    module = load_module()
    data = make_dummy_digits_data(module)

    stream = module.make_recurrent_permutation_stream(
        data=data,
        steps=30,
        seed=1,
        n_states=3,
        block_size=5,
    )

    assert stream.observations.shape == (30, 8)
    assert stream.targets.shape == (30, module.N_CLASSES)
    assert stream.labels.shape == (30,)
    assert stream.state_ids.shape == (30,)
    assert stream.test_views.shape == (3, 20, 8)
    assert stream.n_contexts == 3
    assert set(np.asarray(stream.state_ids).tolist()) == {0, 1, 2}


def test_recurrent_mask_noise_stream_shapes() -> None:
    module = load_module()
    data = make_dummy_digits_data(module)

    stream = module.make_recurrent_mask_noise_stream(
        data=data,
        steps=24,
        seed=2,
        n_states=4,
        block_size=6,
        keep_fraction=0.5,
        noise_std=0.0,
    )

    assert stream.observations.shape == (24, 8)
    assert stream.test_views.shape == (4, 20, 8)
    assert stream.n_contexts == 4


def test_external_image_loader_uses_local_fallback_without_openml() -> None:
    module = load_module()

    data = module.load_external_image_data(
        seed=3,
        train_fraction=0.6,
        source="openml_fashion_mnist",
        allow_openml_download=False,
        sample_limit=100,
    )

    assert data.x_train.shape[1] == 28 * 28
    assert data.x_test.shape[1] == 28 * 28
    assert data.metadata["requested_external_source"] == "openml_fashion_mnist"
    assert data.metadata["used_fallback"] is True
    assert data.metadata["fallback_reason"] == "OpenML download disabled"


def test_delayed_contextual_permutation_stream_shapes_and_delay() -> None:
    module = load_module()
    data = module.load_external_image_data(
        seed=4,
        train_fraction=0.6,
        source="digits_28x28_fallback",
        allow_openml_download=False,
        sample_limit=100,
    )

    stream = module.make_delayed_contextual_permutation_stream(
        data=data,
        steps=36,
        seed=5,
        n_states=3,
        block_size=6,
        context_delay_blocks=1,
    )

    assert stream.observations.shape == (36, 28 * 28)
    assert stream.targets.shape == (36, module.N_CLASSES)
    assert stream.test_views.shape[0] == 3
    assert stream.test_views.shape[2] == 28 * 28
    assert stream.n_contexts == 3
    state_ids = np.asarray(stream.state_ids)
    assert state_ids[:6].tolist() == [0] * 6
    assert state_ids[6:12].tolist() == [0] * 6
    assert state_ids[12:18].tolist() == [1] * 6
    assert stream.metadata["benchmark"] == "external_delayed_contextual_permutation"


def test_paired_resource_manager_comparison_direction() -> None:
    module = load_module()
    records = [
        {
            "methods": {
                "resource_manager": {"final_window_mse": 0.8, "test_accuracy": 0.9},
                "mlp_static": {"final_window_mse": 1.0, "test_accuracy": 0.8},
            }
        },
        {
            "methods": {
                "resource_manager": {"final_window_mse": 1.2, "test_accuracy": 0.7},
                "mlp_static": {"final_window_mse": 1.0, "test_accuracy": 0.8},
            }
        },
    ]

    mse = module.paired_resource_manager_vs(
        records,
        baseline="mlp_static",
        metric="final_window_mse",
        higher_is_better=False,
    )
    acc = module.paired_resource_manager_vs(
        records,
        baseline="mlp_static",
        metric="test_accuracy",
        higher_is_better=True,
    )

    assert mse["paired_diff_mean_positive_favors_resource_manager"] == pytest.approx(0.0)
    assert acc["paired_diff_mean_positive_favors_resource_manager"] == pytest.approx(0.0)
