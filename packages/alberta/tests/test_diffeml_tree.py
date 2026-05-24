"""Tests for hard Boolean decision-tree to DiffEML-circuit compilation."""

from __future__ import annotations

import numpy as np

from alberta_framework.core.diffeml_tree import (
    MASK_AND,
    MASK_NOT_A,
    MASK_OR,
    BooleanDecisionTree,
    BooleanDecisionTreeNode,
    bitize_thresholds,
    evaluate_boolean_circuit,
    export_tree_to_boolean_circuit,
    prune_redundant_leaves,
)


def test_boolean_tree_learns_xor_with_depth_two() -> None:
    """Zero-gain root splits should allow a depth-2 tree to learn XOR."""
    x = np.array(
        [
            [0, 0],
            [0, 1],
            [1, 0],
            [1, 1],
        ],
        dtype=np.int64,
    )
    y = np.array([0, 1, 1, 0], dtype=np.int64)

    tree = BooleanDecisionTree(max_depth=2, criterion="information_gain").fit(x, y)

    np.testing.assert_array_equal(tree.predict_int(x), y)
    assert tree.n_leaves == 4
    assert tree.root.feature_index == 0


def test_boolean_tree_learns_threshold_toy_after_bitization() -> None:
    """A thresholded real toy should become a pure Boolean split after bitization."""
    values = np.array([0.05, 0.25, 0.45, 0.55, 0.75, 0.95], dtype=np.float64)
    x_bits = bitize_thresholds(values, 0.5)
    y = values >= 0.5

    tree = BooleanDecisionTree(max_depth=1, criterion="gini").fit(x_bits, y)

    np.testing.assert_array_equal(tree.predict(x_bits), y)
    assert x_bits.dtype == np.bool_
    assert x_bits.shape == (6, 1)


def test_prune_redundant_leaves_collapses_equal_leaf_children() -> None:
    """Compression should remove a split whose leaves predict the same label."""
    root = BooleanDecisionTreeNode(
        prediction=True,
        n_samples=4,
        positives=2,
        impurity=0.5,
        depth=0,
        feature_index=0,
        false_child=BooleanDecisionTreeNode(
            prediction=False,
            n_samples=2,
            positives=0,
            impurity=0.0,
            depth=1,
        ),
        true_child=BooleanDecisionTreeNode(
            prediction=False,
            n_samples=2,
            positives=0,
            impurity=0.0,
            depth=1,
        ),
        gain=0.0,
    )

    pruned = prune_redundant_leaves(root)

    assert isinstance(pruned, BooleanDecisionTreeNode)
    assert pruned.is_leaf
    assert pruned.prediction is False


def test_exported_xor_circuit_uses_valid_eml_witnessed_boolean_masks() -> None:
    """Tree export should produce a hard NOT/AND/OR circuit without a float head."""
    x = np.array(
        [
            [0, 0],
            [0, 1],
            [1, 0],
            [1, 1],
        ],
        dtype=np.int64,
    )
    y = np.array([0, 1, 1, 0], dtype=np.int64)
    tree = BooleanDecisionTree(max_depth=2, max_leaves=4).fit(x, y)

    circuit = tree.export_circuit()
    validation = circuit.validate_eml_witnesses()
    config = circuit.to_config()

    assert set(circuit.masks) <= {MASK_NOT_A, MASK_AND, MASK_OR}
    assert circuit.source_indices.shape == (circuit.n_gates, 2)
    assert circuit.gate_masks.shape == (circuit.n_gates,)
    assert circuit.has_float_head is False
    assert config["head_mode"] == "boolean_source"
    assert config["has_float_head"] is False
    assert "readout_weights" not in config
    assert validation.valid
    assert validation.missing_masks == ()
    assert validation.required_masks == tuple(sorted(set(circuit.masks)))
    assert circuit.n_gates == 5


def test_exported_circuit_predictions_match_tree_on_threshold_toy() -> None:
    """Hard circuit evaluation should match tree predictions on toy data."""
    values = np.array(
        [
            [0.1, 0.9],
            [0.2, 0.4],
            [0.7, 0.8],
            [0.9, 0.2],
            [0.6, 0.6],
        ],
        dtype=np.float64,
    )
    x_bits = bitize_thresholds(values, np.array([[0.5], [0.5]], dtype=np.float64))
    y = np.logical_or(x_bits[:, 0], x_bits[:, 1])
    tree = BooleanDecisionTree(max_depth=2).fit(x_bits, y)

    circuit = export_tree_to_boolean_circuit(tree)
    circuit_predictions = evaluate_boolean_circuit(circuit, x_bits)

    np.testing.assert_array_equal(tree.predict(x_bits), y)
    np.testing.assert_array_equal(circuit_predictions, tree.predict(x_bits))
    assert circuit.head_mode == "boolean_source"
