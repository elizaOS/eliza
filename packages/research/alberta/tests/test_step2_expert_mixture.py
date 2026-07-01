"""Smoke tests for the Direction 9 Step 2 expert mixture script."""

from __future__ import annotations

from pathlib import Path
from types import ModuleType

import jax.numpy as jnp
import jax.random as jr
import numpy as np
from conftest import load_script

_SCRIPT_PATH = (
    Path(__file__).resolve().parents[1]
    / "examples"
    / "The Alberta Plan"
    / "Step2"
    / "step2_expert_mixture.py"
)


def load_script_module() -> ModuleType:
    return load_script(_SCRIPT_PATH, "step2_expert_mixture")


def test_expert_mixture_stream_metrics_are_finite_and_weighted():
    module = load_script_module()
    observations = jnp.asarray(
        [
            [0.0, 1.0, -1.0],
            [1.0, 0.0, 0.5],
            [-0.5, 0.25, 1.0],
            [0.2, -0.8, 0.4],
        ],
        dtype=jnp.float32,
    )
    targets = jnp.asarray(
        [
            [1.0, 0.0],
            [0.0, 1.0],
            [1.0, 0.0],
            [0.0, 1.0],
        ],
        dtype=jnp.float32,
    )
    mlp = module.make_mlp(n_heads=2, hidden_sizes=(4,), step_size=0.01, sparsity=0.0)
    upgd = module.make_upgd(
        n_heads=2,
        hidden_sizes=(4,),
        step_size=0.01,
        sparsity=0.0,
        perturbation_sigma=0.0,
    )

    _, _, metrics = module.run_expert_mixture_stream(
        mlp=mlp,
        upgd=upgd,
        key=jr.key(0),
        observations=observations,
        targets=targets,
        hedge_eta=1.0,
        hedge_discount=0.99,
    )

    assert metrics.shape == (4, 8)
    assert jnp.all(jnp.isfinite(jnp.asarray(metrics)))
    weights = metrics[:, 3:5]
    assert jnp.allclose(jnp.sum(jnp.asarray(weights), axis=1), 1.0, atol=1e-6)


def test_dataset_aliases_expand_to_concrete_regimes():
    module = load_script_module()

    assert module.expand_dataset_names("synthetic") == list(module.SYNTHETIC_REGIMES)
    assert module.expand_dataset_names("digits_iid,synthetic_frequency") == [
        "digits_iid",
        "synthetic_frequency",
    ]
    assert module.expand_dataset_names("digits_iid,digits_iid") == ["digits_iid"]


def test_retention_deployment_router_triggers_on_class_blocked_labels():
    module = load_script_module()
    labels = np.repeat(np.arange(module.N_DIGIT_CLASSES, dtype=np.int32), 12)

    weights, signal = module.retention_deployment_weights(
        tracking_weights=np.asarray([1.0, 0.0], dtype=np.float32),
        labels=labels,
        n_heads=module.N_DIGIT_CLASSES,
        final_window=24,
        retention_router="class_imbalance",
        retention_upgd_deployment_weight=1.0,
        min_lifetime_class_fraction=0.8,
        max_recent_class_fraction=0.4,
    )

    assert signal["retention_hazard"] is True
    assert signal["deployment_source"] == "class_imbalance_retention"
    assert np.allclose(weights, np.asarray([0.0, 1.0], dtype=np.float32))


def test_retention_deployment_router_leaves_iid_labels_on_tracking_weights():
    module = load_script_module()
    labels = np.tile(np.arange(module.N_DIGIT_CLASSES, dtype=np.int32), 12)

    weights, signal = module.retention_deployment_weights(
        tracking_weights=np.asarray([0.7, 0.3], dtype=np.float32),
        labels=labels,
        n_heads=module.N_DIGIT_CLASSES,
        final_window=50,
        retention_router="class_imbalance",
        retention_upgd_deployment_weight=1.0,
        min_lifetime_class_fraction=0.8,
        max_recent_class_fraction=0.4,
    )

    assert signal["retention_hazard"] is False
    assert signal["deployment_source"] == "tracking"
    assert np.allclose(weights, np.asarray([0.7, 0.3], dtype=np.float32))


def test_new_stream_regime_constructors_have_expected_shapes():
    module = load_script_module()

    observations, targets, meta = module.make_synthetic_stream(
        steps=6,
        seed=0,
        regime="synthetic_frequency",
    )
    assert observations.shape == (6, 4)
    assert targets.shape == (6, 2)
    assert meta["regime"] == "synthetic_frequency"

    x_train = np.arange(12 * 4, dtype=np.float32).reshape(12, 4)
    y_train = np.asarray([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0, 1], dtype=np.int32)
    x_test = np.arange(5 * 4, dtype=np.float32).reshape(5, 4)
    y_test = np.asarray([0, 1, 2, 3, 4], dtype=np.int32)
    observations, targets, labels, test_x, test_y, meta = module.make_digits_regime_sequence(
        x_train=x_train,
        y_train=y_train,
        x_test=x_test,
        y_test=y_test,
        steps=8,
        seed=1,
        regime="digits_label_drift",
        phase_length=4,
        mask_keep_fraction=0.5,
        mask_noise_std=0.0,
    )

    assert observations.shape == (8, 4)
    assert targets.shape == (8, module.N_DIGIT_CLASSES)
    assert labels.shape == (8,)
    assert test_x.shape == x_test.shape
    assert test_y.shape == y_test.shape
    assert meta["regime"] == "digits_label_drift"
    assert meta["n_phases"] == 2
