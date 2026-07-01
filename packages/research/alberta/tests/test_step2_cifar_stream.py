"""Tests for the Step 2 CIFAR-style stream benchmark."""

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
    / "step2_cifar_stream.py"
)


def load_module() -> ModuleType:
    return load_script(_SCRIPT_PATH, "step2_cifar_stream")


def test_one_hot_targets_are_cifar_shaped() -> None:
    module = load_module()
    targets = module.one_hot(np.array([0, 9], dtype=np.int32))

    assert targets.shape == (2, 10)
    assert targets.dtype == np.float32
    np.testing.assert_array_equal(targets[0], np.array([1, 0, 0, 0, 0, 0, 0, 0, 0, 0]))
    assert float(targets[1, 9]) == 1.0


def test_stream_indices_cover_iid_and_class_blocked_regimes() -> None:
    module = load_module()
    labels = np.array([0, 1, 0, 1, 2, 2], dtype=np.int32)

    iid = module.stream_indices(labels, steps=12, regime="iid", seed=0)
    blocked = module.stream_indices(labels, steps=6, regime="class_blocked", seed=0)

    assert iid.shape == (12,)
    assert blocked.shape == (6,)
    assert set(labels[blocked[:2]].tolist()) == {0}
    assert set(labels[blocked[2:4]].tolist()) == {1}
    assert set(labels[blocked[4:]].tolist()) == {2}


def test_synthetic_smoke_experiment_runs_without_torchvision_or_network() -> None:
    module = load_module()
    config = module.RunConfig(
        steps=12,
        n_seeds=1,
        final_window=4,
        max_train=40,
        max_test=20,
        data_dir="/tmp/alberta-framework-no-cifar",
        allow_download=False,
        regimes=("iid", "class_blocked"),
    )

    results = module.run_experiment(config)

    assert results["dataset"]["real_cifar"] is False
    assert results["dataset"]["source"] == "synthetic_cifar_smoke"
    assert results["primary_method"] == "step2_hybrid_memory_trace"
    assert set(results["summary"]) == {"iid", "class_blocked"}
    for regime in ("iid", "class_blocked"):
        assert "step2_hybrid_memory_trace" in results["summary"][regime]
        assert "upgd_step2_default" in results["summary"][regime]
        assert "paired_vs_best_mlp" in results["summary"][regime]
        paired_by_method = results["summary"][regime]["paired_vs_best_mlp_by_method"]
        assert "step2_hybrid_memory_trace" in paired_by_method
        assert "upgd_step2_default" in paired_by_method
        accuracy = results["summary"][regime]["step2_hybrid_memory_trace"][
            "test_accuracy"
        ]["mean"]
        assert 0.0 <= accuracy <= 1.0


def test_optional_sharpened_factories_are_explicit() -> None:
    module = load_module()
    config = module.RunConfig(
        include_primary_sharpened=True,
        include_adaptive_primary_sharpened=True,
        include_sharpened_mlp=True,
        include_prototype_memory=True,
        include_wide_mlp=True,
    )

    factories = module.method_factories(32, config)

    assert "step2_hybrid_memory_trace_sharp" in factories
    assert "step2_hybrid_memory_trace_adaptive_sharp" in factories
    assert "mlp_h32_sharp" in factories
    assert "mlp_h64_sharp" in factories
    assert "mlp_h128" in factories
    assert "mlp_h256" in factories
    assert "mlp_h128_128" in factories
    assert "proto_mem_s20" in factories
    assert "proto_mem_s32" in factories


def test_method_factories_can_filter_to_requested_subset() -> None:
    module = load_module()
    config = module.RunConfig(
        include_adaptive_primary_sharpened=True,
        include_wide_mlp=True,
        only_methods=("step2_hybrid_memory_trace_adaptive_sharp", "mlp_h128"),
    )

    factories = module.method_factories(32, config)

    assert list(factories) == ["step2_hybrid_memory_trace_adaptive_sharp", "mlp_h128"]


def test_prototype_memory_adapter_is_causal_vector_learner() -> None:
    module = load_module()
    learner = module.make_prototype_memory(feature_dim=4, slots_per_class=2)
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
