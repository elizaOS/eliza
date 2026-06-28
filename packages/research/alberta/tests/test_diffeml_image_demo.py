"""Tests for the DiffEML image demonstration helpers."""

from __future__ import annotations

from dataclasses import replace

import jax
import jax.numpy as jnp
import jax.random as jr
import numpy as np
import pytest

from alberta_framework.core import diffeml_image as demo
from alberta_framework.core.diffeml import build_eml_template_bank, eml_threshold_gate_library


def test_packed_binary_gates_match_truth_table_masks() -> None:
    """Packed hard gates should use the same truth-table mask ordering."""
    left = np.full((16,), 0b1100, dtype=np.uint64)
    right = np.full((16,), 0b1010, dtype=np.uint64)
    masks = np.arange(16, dtype=np.uint8)

    outputs = demo.eval_packed_binary_gates(left, right, masks, np.uint64(0b1111))

    assert [int(value) for value in outputs.tolist()] == list(range(16))


def test_gate_masks_pack_two_4bit_masks_per_byte() -> None:
    """Selected Boolean gate masks should have a real 4-bit deployment format."""
    layers = (
        np.array([0, 1, 2, 3, 4], dtype=np.uint8),
        np.array([15, 14, 13, 12], dtype=np.uint8),
    )

    packed = demo.pack_gate_masks_4bit(layers)
    unpacked = demo.unpack_gate_masks_4bit(packed, n_masks=9)

    assert packed.dtype == np.uint8
    assert packed.tolist() == [16, 50, 244, 222, 12]
    np.testing.assert_array_equal(
        unpacked,
        np.array([0, 1, 2, 3, 4, 15, 14, 13, 12], dtype=np.uint8),
    )


def test_detector_feature_values_include_raw_edges_laplace_and_color_maps() -> None:
    """Detector features should expand CIFAR-shaped input to 15 maps per pixel."""
    x_train = np.linspace(0.0, 1.0, num=24, dtype=np.float32).reshape(2, 12)
    x_test = np.linspace(1.0, 0.0, num=12, dtype=np.float32).reshape(1, 12)
    split = demo.DatasetSplit(
        x_train=x_train,
        y_train=np.array([0, 1], dtype=np.int32),
        x_test=x_test,
        y_test=np.array([0], dtype=np.int32),
        meta={"image_shape": (2, 2, 3), "flat_order": "chw"},
    )

    (train_features, test_features), rows, cols, meta = demo.detector_feature_values(split)

    assert train_features.shape == (2, 60)
    assert test_features.shape == (1, 60)
    assert rows.shape == (60,)
    assert cols.shape == (60,)
    assert meta["detector_maps"] == 15


def test_local_tree_hierarchy_wiring_marks_or_pool_layers() -> None:
    """Local tree hierarchy should insert fixed OR-pooling layers between stages."""
    rows = np.repeat(np.arange(4, dtype=np.int32), 4)
    cols = np.tile(np.arange(4, dtype=np.int32), 4)
    layout = demo.FeatureLayout(rows=rows, cols=cols, image_shape=(4, 4, 1))

    wiring = demo.make_wiring(
        jr.key(0),
        input_dim=16,
        layers=3,
        width=32,
        mode="local_tree_hierarchy",
        feature_layout=layout,
        local_patch_size=3,
        tree_stage_depths=(1, 2),
        or_gate_index=14,
    )

    assert len(wiring.left) == 4
    assert wiring.fixed_gate_masks.count(14) == 1
    assert wiring.meta["or_pool_layers"] == 1
    assert wiring.meta["layer_kinds"] == [
        "stage0_tree0",
        "stage0_or_pool",
        "stage1_tree0",
        "stage1_tree1",
    ]


def test_residual_random_wiring_mixes_previous_features_with_raw_inputs() -> None:
    """Residual random topology should force deeper nodes to reuse EML features."""
    input_dim = 5
    wiring = demo.make_wiring(
        jr.key(3),
        input_dim=input_dim,
        layers=3,
        width=8,
        mode="residual_random",
        feature_layout=None,
        local_patch_size=3,
        tree_stage_depths=(1,),
        or_gate_index=14,
    )

    assert wiring.meta["mode"] == "residual_random"
    assert np.all(np.asarray(wiring.left[1]) >= input_dim + 1)
    assert np.all(np.asarray(wiring.left[2]) >= input_dim + 1)
    assert np.all(np.asarray(wiring.right[1]) < input_dim + 1)
    assert np.all(np.asarray(wiring.right[2]) < input_dim + 1)


def test_class_bank_random_wiring_keeps_final_layer_within_class_banks() -> None:
    """Class-bank wiring should align final feature construction with count heads."""
    input_dim = 11
    width = 20
    n_classes = 5
    wiring = demo.make_wiring(
        jr.key(7),
        input_dim=input_dim,
        layers=4,
        width=width,
        mode="class_bank_random",
        n_classes=n_classes,
        feature_layout=None,
        local_patch_size=3,
        tree_stage_depths=(1,),
        or_gate_index=None,
    )
    bank_ids = demo.class_bank_ids(width, n_classes)
    prev_start = input_dim + 1
    final_left = np.asarray(wiring.left[-1]) - prev_start
    final_right = np.asarray(wiring.right[-1])

    assert wiring.meta["mode"] == "class_bank_random"
    assert wiring.meta["generic_layers"] == 2
    assert wiring.meta["class_bank_layers"] == 2
    assert np.all(final_left >= 0)
    assert np.all(final_left < width)
    assert np.array_equal(bank_ids[final_left], bank_ids)
    assert np.all(final_right < input_dim + 1)


def test_affine_expander_wiring_is_deterministic_and_descriptor_compressed() -> None:
    """Affine expander wiring should be executable without storing every edge."""
    input_dim = 11
    width = 20
    wiring = demo.make_wiring(
        jr.key(8),
        input_dim=input_dim,
        layers=3,
        width=width,
        mode="affine_expander",
        feature_layout=None,
        local_patch_size=3,
        tree_stage_depths=(1,),
        or_gate_index=None,
    )
    repeat = demo.make_wiring(
        jr.key(999),
        input_dim=input_dim,
        layers=3,
        width=width,
        mode="affine_expander",
        feature_layout=None,
        local_patch_size=3,
        tree_stage_depths=(1,),
        or_gate_index=None,
    )

    assert wiring.meta["mode"] == "affine_expander"
    assert wiring.meta["deterministic_wiring"] is True
    assert wiring.meta["wiring_storage_mode"] == "affine_mod_descriptor"
    assert np.array_equal(np.asarray(wiring.left[0]), np.asarray(repeat.left[0]))
    assert np.array_equal(np.asarray(wiring.right[1]), np.asarray(repeat.right[1]))
    assert int(wiring.meta["deployed_wiring_bytes"]) < 3 * width * 2
    assert np.all(np.asarray(wiring.left[0]) < input_dim)
    assert np.all(np.asarray(wiring.left[1]) >= input_dim + 1)


def test_butterfly_class_bank_wiring_keeps_bank_stage_local_and_compressed() -> None:
    """Butterfly class banks should be executable and class-local at the tail."""
    input_dim = 13
    width = 24
    n_classes = 4
    wiring = demo.make_wiring(
        jr.key(9),
        input_dim=input_dim,
        layers=5,
        width=width,
        mode="butterfly_class_bank",
        n_classes=n_classes,
        feature_layout=None,
        local_patch_size=3,
        tree_stage_depths=(1,),
        or_gate_index=None,
    )
    bank_ids = demo.class_bank_ids(width, n_classes)
    prev_start = input_dim + 1
    final_left = np.asarray(wiring.left[-1]) - prev_start
    final_right = np.asarray(wiring.right[-1]) - prev_start

    assert wiring.meta["mode"] == "butterfly_class_bank"
    assert wiring.meta["mixer_layers"] == 4
    assert wiring.meta["class_bank_layers"] == 1
    assert wiring.meta["wiring_storage_mode"] == "implicit_butterfly_and_bank_strides"
    assert int(wiring.meta["deployed_wiring_bytes"]) < 5 * width * 2
    assert np.array_equal(final_left, np.arange(width))
    assert np.array_equal(bank_ids[final_right], bank_ids)


def test_packed_hard_logits_match_jax_hard_logits_for_whole_circuit() -> None:
    """Packed hard inference should preserve full hardened-circuit logits."""
    library = eml_threshold_gate_library(depth=2, eps=0.05)
    template_bank = build_eml_template_bank(depth=2, eps=0.05)
    config = _tiny_config()
    wiring = demo.make_wiring(
        jr.key(1),
        input_dim=5,
        layers=config.layers,
        width=config.width,
        mode="random",
        feature_layout=None,
        local_patch_size=3,
        tree_stage_depths=(1,),
        or_gate_index=library.masks.index(14),
    )
    params = demo.init_params(
        jr.key(2),
        layers=len(wiring.left),
        width=config.width,
        n_gates=library.size,
        n_classes=3,
        gate_mode=config.gate_mode,
        gate_init_scale=0.8,
        threshold_init_scale=0.1,
        direction_init_scale=0.1,
        head_init_scale=0.4,
        residual_gate_index=None,
        residual_gate_bias=0.0,
    )
    x_bits = np.array(
        [
            [0, 1, 0, 1, 1],
            [1, 0, 1, 0, 0],
            [1, 1, 0, 0, 1],
            [0, 0, 1, 1, 0],
            [1, 0, 0, 1, 1],
            [0, 1, 1, 0, 0],
            [1, 1, 1, 0, 1],
        ],
        dtype=np.float32,
    )

    jax_logits = demo.forward(
        params,
        jnp.asarray(x_bits),
        wiring,
        library.outputs,
        template_bank,
        jnp.array(0.25, dtype=jnp.float32),
        config,
        hard=True,
    )
    masks = demo.selected_gate_mask_arrays(params, wiring, library.masks, config.width)
    packed_logits = demo.packed_hard_logits(params, x_bits, wiring, masks, config)

    np.testing.assert_allclose(np.asarray(jax_logits), packed_logits, atol=1e-6)


def test_packed_group_sum_logits_match_jax_without_float_head() -> None:
    """A grouped-count readout should stay in packed Boolean form."""
    library = eml_threshold_gate_library(depth=2, eps=0.05)
    template_bank = build_eml_template_bank(depth=2, eps=0.05)
    config = replace(_tiny_config(), head_mode="group_sum", group_sum_tau=2.0)
    wiring = demo.make_wiring(
        jr.key(11),
        input_dim=5,
        layers=config.layers,
        width=config.width,
        mode="random",
        feature_layout=None,
        local_patch_size=3,
        tree_stage_depths=(1,),
        or_gate_index=library.masks.index(14),
    )
    params = demo.init_params(
        jr.key(12),
        layers=len(wiring.left),
        width=config.width,
        n_gates=library.size,
        n_classes=3,
        gate_mode=config.gate_mode,
        gate_init_scale=0.8,
        threshold_init_scale=0.1,
        direction_init_scale=0.1,
        head_init_scale=0.4,
        residual_gate_index=None,
        residual_gate_bias=0.0,
    )
    x_bits = np.array(
        [
            [0, 1, 0, 1, 1],
            [1, 0, 1, 0, 0],
            [1, 1, 0, 0, 1],
        ],
        dtype=np.float32,
    )

    jax_logits = demo.forward(
        params,
        jnp.asarray(x_bits),
        wiring,
        library.outputs,
        template_bank,
        jnp.array(0.25, dtype=jnp.float32),
        config,
        hard=True,
    )
    masks = demo.selected_gate_mask_arrays(params, wiring, library.masks, config.width)
    packed_logits = demo.packed_hard_logits(params, x_bits, wiring, masks, config)
    storage = demo.compiled_circuit_storage_summary(params, wiring, masks, config)

    np.testing.assert_allclose(np.asarray(jax_logits), packed_logits, atol=1e-6)
    assert storage["head_fp32_bytes"] == 0
    assert storage["compiled_packed_bytes"] == storage["wiring_bytes"] + storage["gate_mask_bytes"]


def test_packed_class_vote_logits_match_jax_with_discrete_readout() -> None:
    """A learned class-vote readout should compile to class ids plus popcounts."""
    library = eml_threshold_gate_library(depth=2, eps=0.05)
    template_bank = build_eml_template_bank(depth=2, eps=0.05)
    config = replace(_tiny_config(), head_mode="class_vote", group_sum_tau=2.0)
    wiring = demo.make_wiring(
        jr.key(21),
        input_dim=5,
        layers=config.layers,
        width=config.width,
        mode="random",
        feature_layout=None,
        local_patch_size=3,
        tree_stage_depths=(1,),
        or_gate_index=library.masks.index(14),
    )
    params = demo.init_params(
        jr.key(22),
        layers=len(wiring.left),
        width=config.width,
        n_gates=library.size,
        n_classes=3,
        gate_mode=config.gate_mode,
        gate_init_scale=0.8,
        threshold_init_scale=0.1,
        direction_init_scale=0.1,
        head_init_scale=0.4,
        residual_gate_index=None,
        residual_gate_bias=0.0,
    )
    x_bits = np.array(
        [
            [0, 1, 0, 1, 1],
            [1, 0, 1, 0, 0],
            [1, 1, 0, 0, 1],
        ],
        dtype=np.float32,
    )

    jax_logits = demo.forward(
        params,
        jnp.asarray(x_bits),
        wiring,
        library.outputs,
        template_bank,
        jnp.array(0.25, dtype=jnp.float32),
        config,
        hard=True,
    )
    masks = demo.selected_gate_mask_arrays(params, wiring, library.masks, config.width)
    packed_logits = demo.packed_hard_logits(params, x_bits, wiring, masks, config)
    storage = demo.compiled_circuit_storage_summary(params, wiring, masks, config)

    np.testing.assert_allclose(np.asarray(jax_logits), packed_logits, atol=1e-6)
    assert storage["head_fp32_bytes"] == 0
    assert storage["head_vote_index_bytes"] > 0
    assert storage["compiled_packed_bytes"] == (
        storage["wiring_bytes"] + storage["gate_mask_bytes"] + storage["head_vote_index_bytes"]
    )
    assert storage["gate_mask_packed4_bytes"] == (
        int(storage["gate_mask_bytes"]) + 1
    ) // 2
    assert storage["compiled_bitpacked_bytes"] == (
        storage["wiring_bytes"]
        + storage["gate_mask_packed4_bytes"]
        + storage["head_vote_index_bytes"]
    )


def test_deterministic_wiring_storage_uses_descriptor_bytes() -> None:
    """Compressed deterministic topology bytes should be counted at deployment."""
    library = eml_threshold_gate_library(depth=2, eps=0.05)
    config = replace(_tiny_config(), head_mode="class_vote", wiring_mode="affine_expander")
    wiring = demo.make_wiring(
        jr.key(27),
        input_dim=5,
        layers=config.layers,
        width=config.width,
        mode=config.wiring_mode,
        feature_layout=None,
        local_patch_size=3,
        tree_stage_depths=(1,),
        or_gate_index=library.masks.index(14),
    )
    params = demo.init_params(
        jr.key(28),
        layers=len(wiring.left),
        width=config.width,
        n_gates=library.size,
        n_classes=3,
        gate_mode=config.gate_mode,
        gate_init_scale=0.8,
        threshold_init_scale=0.1,
        direction_init_scale=0.1,
        head_init_scale=0.4,
        residual_gate_index=None,
        residual_gate_bias=0.0,
        head_mode=config.head_mode,
    )
    masks = demo.selected_gate_mask_arrays(params, wiring, library.masks, config.width)
    storage = demo.compiled_circuit_storage_summary(params, wiring, masks, config)

    assert storage["wiring_storage_mode"] == "affine_mod_descriptor"
    assert storage["wiring_bytes"] == wiring.meta["deployed_wiring_bytes"]
    assert storage["wiring_bytes"] < storage["explicit_wiring_bytes"]
    assert storage["compiled_bitpacked_bytes"] < storage["compiled_packed_bytes"]


def test_packed_signed_class_vote_logits_match_jax_with_polarity_metadata() -> None:
    """Signed class votes should compile to class ids, polarity bits, and popcounts."""
    library = eml_threshold_gate_library(depth=2, eps=0.05)
    template_bank = build_eml_template_bank(depth=2, eps=0.05)
    config = replace(_tiny_config(), head_mode="signed_class_vote", group_sum_tau=2.0)
    wiring = demo.make_wiring(
        jr.key(31),
        input_dim=5,
        layers=config.layers,
        width=config.width,
        mode="random",
        feature_layout=None,
        local_patch_size=3,
        tree_stage_depths=(1,),
        or_gate_index=library.masks.index(14),
    )
    params = demo.init_params(
        jr.key(32),
        layers=len(wiring.left),
        width=config.width,
        n_gates=library.size,
        n_classes=3,
        gate_mode=config.gate_mode,
        gate_init_scale=0.8,
        threshold_init_scale=0.1,
        direction_init_scale=0.1,
        head_init_scale=0.4,
        residual_gate_index=None,
        residual_gate_bias=0.0,
        head_mode=config.head_mode,
    )
    x_bits = np.array(
        [
            [0, 1, 0, 1, 1],
            [1, 0, 1, 0, 0],
            [1, 1, 0, 0, 1],
        ],
        dtype=np.float32,
    )

    jax_logits = demo.forward(
        params,
        jnp.asarray(x_bits),
        wiring,
        library.outputs,
        template_bank,
        jnp.array(0.25, dtype=jnp.float32),
        config,
        hard=True,
    )
    masks = demo.selected_gate_mask_arrays(params, wiring, library.masks, config.width)
    packed_logits = demo.packed_hard_logits(params, x_bits, wiring, masks, config)
    storage = demo.compiled_circuit_storage_summary(params, wiring, masks, config)

    np.testing.assert_allclose(np.asarray(jax_logits), packed_logits, atol=1e-6)
    assert storage["head_fp32_bytes"] == 0
    assert storage["head_signed_vote_index_bytes"] > 0
    assert storage["compiled_packed_bytes"] == (
        storage["wiring_bytes"]
        + storage["gate_mask_bytes"]
        + storage["head_signed_vote_index_bytes"]
    )


def test_class_vote_hard_logits_use_straight_through_readout_gradient() -> None:
    """Hard class-vote logits should still train the soft class assignment."""
    config = replace(_tiny_config(), head_mode="class_vote", group_sum_tau=1.0)
    params = demo.CircuitParams(
        gate_logits=None,
        threshold_logits=None,
        direction_logits=None,
        head_w=jnp.array(
            [
                [2.0, 0.0, -1.0],
                [-1.0, 2.0, 0.0],
                [0.0, -1.0, 2.0],
            ],
            dtype=jnp.float32,
        ),
        head_b=jnp.zeros((3,), dtype=jnp.float32),
    )
    features = jnp.array([[1.0, 1.0, 0.0]], dtype=jnp.float32)

    def loss(head_w: jax.Array) -> jax.Array:
        local_params = params._replace(head_w=head_w)
        logits = demo.classifier_logits(local_params, features, config, hard=True)
        return demo.cross_entropy(logits, jnp.array([2], dtype=jnp.int32))

    grad = jax.grad(loss)(params.head_w)

    assert bool(jnp.any(jnp.abs(grad) > 0.0))


def test_class_vote_readout_regularization_is_train_time_only() -> None:
    """Readout penalties should act on soft class metadata, not packed deployment."""
    config = replace(
        _tiny_config(),
        head_mode="class_vote",
        readout_entropy_weight=0.5,
        readout_balance_weight=2.0,
    )
    params = demo.CircuitParams(
        gate_logits=None,
        threshold_logits=None,
        direction_logits=None,
        head_w=jnp.array(
            [
                [4.0, 0.0, 0.0],
                [4.0, 0.0, 0.0],
                [4.0, 0.0, 0.0],
            ],
            dtype=jnp.float32,
        ),
        head_b=jnp.zeros((3,), dtype=jnp.float32),
    )

    penalty = demo.class_vote_readout_regularization(params, config)
    disabled = demo.class_vote_readout_regularization(
        params,
        replace(config, head_mode="group_sum"),
    )

    assert float(penalty) > 0.0
    assert float(disabled) == 0.0


def test_deployment_purity_summary_flags_continuous_and_pure_paths() -> None:
    """Purity metadata should make continuous deployment machinery visible."""
    linear = demo.deployment_purity_summary(_tiny_config())
    class_vote = demo.deployment_purity_summary(
        replace(_tiny_config(), head_mode="class_vote"),
    )
    raw_threshold = demo.deployment_purity_summary(
        replace(_tiny_config(), gate_mode="eml_threshold", head_mode="class_vote"),
    )

    assert linear["deploy_uses_continuous_head"] is True
    assert linear["hard_deploy_is_pure_boolean"] is False
    assert linear["primary_no_larp_metric"] == "test_hard_accuracy"
    assert class_vote["train_uses_soft_gate_mixture"] is True
    assert class_vote["train_uses_soft_readout_mixture"] is True
    assert class_vote["deploy_uses_continuous_head"] is False
    assert class_vote["hard_deploy_is_pure_boolean"] is True
    assert class_vote["primary_no_larp_metric"] == "packed_hard_test_accuracy"
    assert raw_threshold["deploy_uses_learned_real_thresholds"] is True
    assert raw_threshold["packed_boolean_eval_available"] is False
    assert raw_threshold["hard_deploy_is_pure_boolean"] is False


def test_prediction_disagreement_reports_argmax_gap() -> None:
    """Soft-hard disagreement should report class-level mismatch, not logit distance."""
    left_logits = jnp.array(
        [
            [3.0, 0.0],
            [0.0, 3.0],
            [2.0, 1.0],
        ],
        dtype=jnp.float32,
    )
    right_logits = jnp.array(
        [
            [2.0, 1.0],
            [3.0, 0.0],
            [5.0, 4.0],
        ],
        dtype=jnp.float32,
    )

    disagreement = demo.prediction_disagreement(left_logits, right_logits)

    assert float(disagreement) == pytest.approx(1.0 / 3.0)


def test_compiled_storage_and_int8_head_eval_are_reported_for_selector_circuit() -> None:
    """Compiled circuits should expose storage estimates and int8-head logits."""
    library = eml_threshold_gate_library(depth=2, eps=0.05)
    config = _tiny_config()
    wiring = demo.make_wiring(
        jr.key(4),
        input_dim=5,
        layers=config.layers,
        width=config.width,
        mode="random",
        feature_layout=None,
        local_patch_size=3,
        tree_stage_depths=(1,),
        or_gate_index=library.masks.index(14),
    )
    params = demo.init_params(
        jr.key(5),
        layers=len(wiring.left),
        width=config.width,
        n_gates=library.size,
        n_classes=3,
        gate_mode=config.gate_mode,
        gate_init_scale=0.8,
        threshold_init_scale=0.1,
        direction_init_scale=0.1,
        head_init_scale=0.4,
        residual_gate_index=None,
        residual_gate_bias=0.0,
    )
    masks = demo.selected_gate_mask_arrays(params, wiring, library.masks, config.width)
    x_bits = np.array([[0, 1, 0, 1, 1], [1, 0, 1, 0, 0]], dtype=np.float32)

    logits = demo.packed_hard_logits_int8_head(params, x_bits, wiring, masks, config)
    storage = demo.compiled_circuit_storage_summary(params, wiring, masks, config)

    assert logits.shape == (2, 3)
    assert np.isfinite(logits).all()
    assert storage["compiled_int8_bytes"] < storage["soft_train_bytes"]
    assert storage["compiled_packed_bytes"] == storage["compiled_int8_bytes"]
    assert storage["head_int8_bytes"] < storage["head_fp32_bytes"]


def test_hardened_selector_compaction_summary_reports_dead_eml_gates() -> None:
    """Image artifacts should expose hard-DAG pruning pressure."""
    config = replace(_tiny_config(), head_mode="class_vote", width=4)
    wiring = demo.CircuitWiring(
        left=(jnp.array([0, 0, 0, 0], dtype=jnp.int32),),
        right=(jnp.array([1, 1, 1, 1], dtype=jnp.int32),),
        fixed_gate_indices=(None,),
        fixed_gate_masks=(None,),
        meta={"layer_kinds": ["hard"]},
    )
    masks = (np.array([0, 15, 12, 8], dtype=np.uint8),)
    params = demo.CircuitParams(
        gate_logits=None,
        threshold_logits=None,
        direction_logits=None,
        head_w=jnp.array(
            [
                [4.0, 0.0],
                [4.0, 0.0],
                [0.0, 4.0],
                [0.0, 4.0],
            ],
            dtype=jnp.float32,
        ),
        head_b=jnp.zeros((2,), dtype=jnp.float32),
    )

    result = demo.compact_selected_hard_circuit(
        params,
        wiring,
        masks,
        config,
        input_dim=2,
    )
    summary = demo.compaction_summary(result)

    assert summary["source_index_model"] == "global_dag"
    assert summary["original_layer_widths"] == [4]
    assert summary["compacted_layer_widths"] == [1]
    assert summary["stats"]["constant_gates"] == 2
    assert summary["stats"]["identity_alias_gates"] == 1
    assert summary["stats"]["compacted_gates"] == 1


def test_int8_head_eval_rejects_boolean_count_readouts() -> None:
    """The int8 helper should not silently reinterpret pure Boolean readouts."""
    library = eml_threshold_gate_library(depth=2, eps=0.05)
    config = replace(_tiny_config(), head_mode="class_vote")
    wiring = demo.make_wiring(
        jr.key(24),
        input_dim=5,
        layers=config.layers,
        width=config.width,
        mode="random",
        feature_layout=None,
        local_patch_size=3,
        tree_stage_depths=(1,),
        or_gate_index=library.masks.index(14),
    )
    params = demo.init_params(
        jr.key(25),
        layers=len(wiring.left),
        width=config.width,
        n_gates=library.size,
        n_classes=3,
        gate_mode=config.gate_mode,
        gate_init_scale=0.8,
        threshold_init_scale=0.1,
        direction_init_scale=0.1,
        head_init_scale=0.4,
        residual_gate_index=None,
        residual_gate_bias=0.0,
    )
    masks = demo.selected_gate_mask_arrays(params, wiring, library.masks, config.width)
    x_bits = np.array([[0, 1, 0, 1, 1]], dtype=np.float32)

    with pytest.raises(ValueError, match="head_mode='linear'"):
        demo.packed_hard_logits_int8_head(params, x_bits, wiring, masks, config)


def _tiny_config() -> demo.DemoConfig:
    """Return a minimal config for circuit-only unit tests."""
    return demo.DemoConfig(
        datasets=("digits",),
        seed=0,
        train_fraction=0.8,
        max_train=16,
        max_test=8,
        feature_mode="threshold_pixels",
        input_bits=5,
        pixel_thresholds=1,
        layers=2,
        width=7,
        wiring_mode="random",
        local_patch_size=3,
        tree_stage_depths=(1,),
        epochs=1,
        batch_size=8,
        step_size=0.01,
        initial_temperature=1.0,
        min_temperature=0.1,
        entropy_weight=0.0,
        head_l2=0.0,
        gate_init_scale=0.8,
        head_init_scale=0.4,
        max_grad_norm=10.0,
        eml_template_depth=2,
        eml_eps=0.05,
        gate_mode="eml_template",
        eml_threshold_temperature=0.75,
        threshold_init_scale=0.1,
        direction_init_scale=0.1,
        hard_loss_weight=0.0,
        input_drop_rate=0.0,
        feature_drop_rate=0.0,
        residual_gate="none",
        residual_gate_bias=0.0,
        head_mode="linear",
        group_sum_tau=30.0,
        readout_entropy_weight=0.0,
        readout_balance_weight=0.0,
        packed_eval=True,
        compare_mlp=False,
        mlp_hidden_sizes=(8,),
        mlp_epochs=1,
        mlp_step_size=0.001,
        mlp_weight_decay=0.0,
        mlp_max_grad_norm=10.0,
        mlp_init_scale=1.0,
    )
