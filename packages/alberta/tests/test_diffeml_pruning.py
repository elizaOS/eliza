"""Tests for DiffEML hard-circuit pruning utilities."""

from __future__ import annotations

import json

import pytest

from alberta_framework.core.diffeml_pruning import (
    GateRef,
    HardGateLayer,
    SourceRef,
    compact_hard_circuit,
    find_constant_gates,
    find_duplicate_gates,
    find_unused_readout_features,
    used_readout_features,
)


def test_readout_unused_features_cover_linear_group_and_vote_modes() -> None:
    """Readout utility should identify features with no deploy-time consumer."""
    assert used_readout_features(
        final_width=4,
        head_mode="linear",
        head_weights=[
            [1.0, 0.0],
            [0.0, 0.0],
            [0.0, -0.2],
            [1e-5, 0.0],
        ],
        tolerance=1e-4,
    ) == (0, 2)
    assert find_unused_readout_features(
        final_width=4,
        head_mode="linear",
        head_weights=[
            [1.0, 0.0],
            [0.0, 0.0],
            [0.0, -0.2],
            [1e-5, 0.0],
        ],
        tolerance=1e-4,
    ) == (1, 3)

    assert used_readout_features(final_width=5, head_mode="group_sum", n_classes=2) == (
        0,
        1,
        2,
        3,
    )
    assert find_unused_readout_features(final_width=5, head_mode="group_sum", n_classes=2) == (4,)

    assert used_readout_features(
        final_width=4,
        head_mode="class_vote",
        n_classes=3,
        class_ids=[0, -1, 2, 1],
    ) == (0, 2, 3)


def test_detects_constant_and_identity_alias_gates() -> None:
    """Constant masks and projection masks should disappear from the compact DAG."""
    layer = HardGateLayer.from_iterables(
        left=[0, 0, 0, 0],
        right=[1, 1, 1, 1],
        masks=[0, 15, 12, 8],
        name="layer0",
    )

    result = compact_hard_circuit(
        [layer],
        input_dim=2,
        head_mode="linear",
        head_weights=[
            [0.0],
            [0.0],
            [0.0],
            [1.0],
        ],
    )

    assert [alias.gate for alias in result.constant_gates] == [
        GateRef(0, 0),
        GateRef(0, 1),
    ]
    assert result.identity_alias_gates[0].gate == GateRef(0, 2)
    assert result.identity_alias_gates[0].source == SourceRef.input(0)
    assert result.kept_gates == (GateRef(0, 3),)
    assert result.compacted_layers[0].masks == (8,)
    assert result.stats.original_gates == 4
    assert result.stats.compacted_gates == 1
    assert result.stats.pruned_gates == 3

    constants = find_constant_gates([layer], input_dim=2)
    assert [constant.gate for constant in constants] == [GateRef(0, 0), GateRef(0, 1)]


def test_detects_commutative_duplicate_gates() -> None:
    """AND(A, B) and AND(B, A) should collapse to one canonical gate."""
    layer = HardGateLayer.from_iterables(
        left=[0, 1, 0],
        right=[1, 0, 1],
        masks=[8, 8, 14],
    )

    result = compact_hard_circuit(
        [layer],
        input_dim=2,
        head_mode="linear",
        head_weights=[
            [1.0],
            [1.0],
            [0.0],
        ],
    )

    assert result.duplicate_gates[0].gate == GateRef(0, 1)
    assert result.duplicate_gates[0].canonical_source == SourceRef.gate(0, 0)
    assert result.kept_gates == (GateRef(0, 0),)
    assert result.compacted_layers[0].original_indices == (0,)
    assert find_duplicate_gates([layer], input_dim=2)[0].gate == GateRef(0, 1)


def test_compaction_rewires_duplicate_dependencies_to_canonical_gate() -> None:
    """A later layer using a duplicate should point at the retained canonical gate."""
    layer0 = HardGateLayer.from_iterables(
        left=[0, 1, 0],
        right=[1, 0, 1],
        masks=[8, 8, 14],
        name="base",
    )
    layer1 = HardGateLayer.from_iterables(
        left=[4],
        right=[0],
        masks=[6],
        name="readout_basis",
    )

    result = compact_hard_circuit(
        [layer0, layer1],
        input_dim=2,
        head_mode="linear",
        head_weights=[[1.0]],
    )

    assert result.duplicate_gates[0].gate == GateRef(0, 1)
    assert result.compacted_layers[0].original_indices == (0,)
    assert result.compacted_layers[1].original_indices == (0,)
    assert result.compacted_layers[1].left_sources == (SourceRef.gate(0, 0),)
    assert result.compacted_layers[1].right_sources == (SourceRef.input(0),)
    assert result.final_feature_sources == (SourceRef.gate(1, 0),)
    assert result.stats.unused_unique_gates == 1


def test_group_sum_prunes_remainder_and_unreachable_final_gates() -> None:
    """Class-aligned grouped readouts should prune final remainder features."""
    layer = HardGateLayer.from_iterables(
        left=[0, 0, 1, 1, 0],
        right=[1, 1, 0, 0, 1],
        masks=[8, 14, 8, 14, 6],
    )

    result = compact_hard_circuit([layer], input_dim=2, head_mode="group_sum", n_classes=2)

    assert result.unused_readout_features == (4,)
    assert result.readout_used_features == (0, 1, 2, 3)
    assert GateRef(0, 4) in result.unused_unique_gates
    assert result.compacted_layers[0].original_indices == (0, 1)
    assert result.stats.unused_readout_features == 1


def test_compaction_result_serializes_to_json_config() -> None:
    """Compaction metadata should be artifact-friendly."""
    layer = HardGateLayer.from_iterables(left=[0, 1], right=[1, 0], masks=[8, 8])

    result = compact_hard_circuit(
        [layer],
        input_dim=2,
        head_mode="linear",
        head_weights=[[1.0], [1.0]],
    )
    encoded = json.dumps(result.to_config(), sort_keys=True)
    decoded = json.loads(encoded)

    assert decoded["source_index_model"] == "global_dag"
    assert decoded["stats"]["duplicate_gates"] == 1
    assert decoded["compacted_layers"][0]["original_indices"] == [0]


def test_invalid_source_indices_are_rejected() -> None:
    """Pruning should fail early on malformed hard-circuit metadata."""
    layer = HardGateLayer.from_iterables(left=[3], right=[0], masks=[8])

    with pytest.raises(ValueError, match="source index exceeds"):
        compact_hard_circuit([layer], input_dim=2)
