"""Tests for DiffEML topology accounting utilities."""

from __future__ import annotations

import json

from alberta_framework.core.diffeml_topologies import (
    TopologySpec,
    affine_expander_topology_spec,
    butterfly_class_bank_topology_spec,
    candidate_topology_specs,
    class_bank_random_topology_spec,
    compare_gate_budget,
    continuous_eml_block_topology_spec,
    conv_tree_stage_topology_spec,
    difflogic_random_topology_spec,
    local_tree_hierarchy_topology_spec,
)


def test_random_sparse_budget_matches_current_image_metadata_formula() -> None:
    """Random wiring accounting should match the image runner's metadata formula."""
    spec = difflogic_random_topology_spec(
        name="cifar_random_2048x6",
        input_dim=16_384,
        n_classes=10,
        width=2048,
        layers=6,
        gate_mode="eml_threshold",
        library_size=16,
        head_mode="linear",
    )

    counts = spec.accounting()

    assert counts.layer_count == 6
    assert counts.total_nodes == 12_288
    assert counts.trainable_gate_nodes == 12_288
    assert counts.fixed_gate_nodes == 0
    assert counts.trainable_node_parameters == 24_576
    assert counts.head_parameters == 20_490
    assert counts.deployed_readout_bytes == 20_560
    assert counts.source_index_bytes == 2
    assert counts.deployed_wiring_bytes == 49_152
    assert counts.deployed_gate_mask_bytes == 12_288
    assert counts.deployed_circuit_bytes == 82_000
    assert counts.total_trainable_parameters == 45_066
    assert counts.packed_gate_word_ops_per_batch == 12_288
    assert counts.packed_source_word_reads_per_batch == 24_576
    assert counts.final_feature_columns == 2048


def test_local_tree_hierarchy_counts_fixed_or_pool_nodes() -> None:
    """Local tree specs should count fixed OR-pool nodes but not selector params."""
    spec = local_tree_hierarchy_topology_spec(
        name="local_tree",
        input_dim=16,
        n_classes=10,
        width=32,
        stage_depths=(1, 2),
        gate_mode="eml_template",
        library_size=13,
        head_mode="group_sum",
    )

    counts = spec.accounting()

    assert [layer.name for layer in spec.layers] == [
        "stage0_tree0",
        "stage0_or_pool",
        "stage1_tree0",
        "stage1_tree1",
    ]
    assert counts.layer_count == 4
    assert counts.total_nodes == 128
    assert counts.trainable_gate_nodes == 96
    assert counts.fixed_gate_nodes == 32
    assert counts.trainable_node_parameters == 96 * 13
    assert counts.head_parameters == 0
    assert counts.deployed_readout_bytes == 0


def test_class_vote_head_counts_trainable_class_assignments() -> None:
    """Class-vote readouts train class selectors but compile to class ids."""
    spec = difflogic_random_topology_spec(
        name="class_vote",
        input_dim=16,
        n_classes=3,
        width=12,
        layers=2,
        gate_mode="eml_template",
        library_size=16,
        head_mode="class_vote",
    )

    counts = spec.accounting()

    assert counts.head_parameters == 36
    assert counts.deployed_readout_bytes == 3
    assert counts.total_trainable_parameters == counts.trainable_node_parameters + 36


def test_signed_class_vote_head_counts_polarity_metadata() -> None:
    """Signed class-vote readouts add polarity bits without float deploy weights."""
    spec = difflogic_random_topology_spec(
        name="signed_class_vote",
        input_dim=16,
        n_classes=3,
        width=12,
        layers=2,
        gate_mode="eml_template",
        library_size=16,
        head_mode="signed_class_vote",
    )

    counts = spec.accounting()

    assert counts.head_parameters == 72
    assert counts.deployed_readout_bytes == 5
    assert counts.total_trainable_parameters == counts.trainable_node_parameters + 72


def test_class_bank_random_topology_tracks_pure_readout_metadata() -> None:
    """Class-bank plans should spend gates in class banks without readout weights."""
    spec = class_bank_random_topology_spec(
        name="class_bank",
        input_dim=128,
        n_classes=10,
        width=100,
        layers=4,
        class_bank_layers=2,
        gate_mode="eml_template",
        library_size=16,
        head_mode="group_sum",
    )

    counts = spec.accounting()

    assert spec.family == "class_bank_random"
    assert [layer.kind for layer in spec.layers] == [
        "random_sparse",
        "random_sparse",
        "class_bank_random",
        "class_bank_random",
    ]
    assert counts.total_nodes == 400
    assert counts.head_parameters == 0
    assert counts.deployed_readout_bytes == 0
    assert spec.metadata == {
        "runner_wiring_mode": "class_bank_random",
        "generic_layers": 2,
        "class_bank_layers": 2,
    }


def test_affine_expander_uses_compressed_deterministic_wiring_metadata() -> None:
    """Affine expander plans should avoid per-edge random wiring storage."""
    spec = affine_expander_topology_spec(
        name="affine_expander",
        input_dim=1024,
        n_classes=10,
        width=256,
        layers=4,
        gate_mode="eml_template",
        library_size=16,
    )

    counts = spec.accounting()
    explicit_wiring_bytes = counts.total_nodes * 2 * counts.source_index_bytes

    assert spec.family == "affine_expander"
    assert spec.metadata is not None
    assert spec.metadata["runner_wiring_mode"] == "affine_expander"
    assert spec.head_mode == "class_vote"
    assert counts.total_nodes == 1024
    assert counts.trainable_gate_nodes == 1024
    assert counts.head_parameters == 2560
    assert counts.deployed_readout_bytes == 128
    assert counts.deployed_wiring_bytes == 32
    assert counts.deployed_wiring_bytes < explicit_wiring_bytes // 100
    assert counts.deployed_circuit_bytes == 32 + 1024 + 128
    assert spec.layers[0].metadata == {
        "layer": 0,
        "source": "input",
        "modulus": 1024,
        "left_multiplier": 1,
        "left_offset": 1,
        "right_multiplier": 3,
        "right_offset": 7,
        "wiring_storage_mode": "affine_mod_descriptor",
        "wiring_storage_bytes": 8,
    }


def test_butterfly_class_bank_keeps_readout_pure_and_wiring_implicit() -> None:
    """Butterfly-bank plans should spend gates on class evidence, not heads."""
    spec = butterfly_class_bank_topology_spec(
        name="butterfly_bank",
        input_dim=16_384,
        n_classes=10,
        width=2048,
        mixer_layers=4,
        class_bank_layers=2,
        gate_mode="eml_threshold",
        library_size=16,
    )

    counts = spec.accounting()
    explicit_wiring_bytes = counts.total_nodes * 2 * counts.source_index_bytes

    assert spec.family == "butterfly_class_bank"
    assert spec.head_mode == "group_sum"
    assert [layer.kind for layer in spec.layers] == [
        "butterfly_mixer",
        "butterfly_mixer",
        "butterfly_mixer",
        "butterfly_mixer",
        "class_bank_butterfly",
        "class_bank_butterfly",
    ]
    assert counts.total_nodes == 12_288
    assert counts.trainable_node_parameters == 24_576
    assert counts.head_parameters == 0
    assert counts.deployed_readout_bytes == 0
    assert counts.deployed_wiring_bytes == 12
    assert counts.deployed_wiring_bytes < explicit_wiring_bytes // 1000
    assert counts.deployed_circuit_bytes == 12_300
    assert spec.layers[-1].metadata == {
        "stage": "class_bank",
        "stride": 2,
        "class_bank": True,
        "bank_width": 205,
        "wiring_storage_mode": "implicit_bank_butterfly_stride",
        "wiring_storage_bytes": 2,
    }
    assert spec.metadata == {
        "runner_wiring_mode": "butterfly_class_bank",
        "deterministic_wiring": True,
        "mixer_layers": 4,
        "class_bank_layers": 2,
        "bank_width": 205,
        "butterfly_strides": [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024],
        "descriptor": "global butterfly mixer, then class-local butterfly banks",
    }


def test_conv_tree_spatial_stage_budget_uses_variable_widths() -> None:
    """Conv/tree stage specs should count spatial widths exactly."""
    spec = conv_tree_stage_topology_spec(
        name="conv_tree",
        input_dim=15_360,
        n_classes=10,
        image_shape=(32, 32, 3),
        channels_per_stage=(8, 16),
        tree_depths=(2, 1),
        gate_mode="eml_threshold",
        library_size=16,
    )

    counts = spec.accounting()

    assert [layer.width for layer in spec.layers] == [8192, 8192, 4096, 4096]
    assert spec.layers[2].fixed_gate_mask == 14
    assert counts.total_nodes == 24_576
    assert counts.trainable_gate_nodes == 20_480
    assert counts.fixed_gate_nodes == 4096
    assert counts.trainable_node_parameters == 40_960
    assert counts.head_parameters == 40_970


def test_topology_spec_round_trips_through_json_config() -> None:
    """Topology specs should serialize deterministically for artifact metadata."""
    spec = continuous_eml_block_topology_spec(
        name="continuous_blocks",
        input_dim=1024,
        n_classes=10,
        width=512,
        blocks=2,
        depth_per_block=3,
        gate_mode="eml_threshold",
        library_size=16,
        residual=True,
    )

    encoded = json.dumps(spec.to_config(), sort_keys=True)
    restored = TopologySpec.from_config(json.loads(encoded))

    assert restored == spec
    assert restored.accounting() == spec.accounting()
    assert restored.metadata == {
        "blocks": 2,
        "depth_per_block": 3,
        "residual": True,
        "runner_wiring_mode": "future_continuous_eml_blocks",
    }


def test_packed_inference_counts_scale_by_uint64_batches() -> None:
    """Packed counts should scale by chunks of up to 64 examples."""
    spec = difflogic_random_topology_spec(
        name="tiny",
        input_dim=5,
        n_classes=3,
        width=7,
        layers=2,
        gate_mode="eml_template",
        library_size=16,
    )

    counts = spec.packed_inference_counts(examples=130)

    assert counts.word_batches == 3
    assert counts.gate_word_ops == 42
    assert counts.source_word_reads == 84
    assert counts.feature_word_writes == 42
    assert counts.input_pack_columns == 15
    assert counts.final_unpack_columns == 21
    assert counts.head_parameters_read == 24
    assert counts.deployed_readout_bytes_read == 45


def test_candidate_specs_include_non_random_families_and_budget_comparison() -> None:
    """Candidate plans should include structured families beyond random wiring."""
    specs = candidate_topology_specs(input_dim=16_384, n_classes=10, library_size=16)
    families = {spec.family for spec in specs}

    assert "random_sparse" in families
    assert "affine_expander" in families
    assert "butterfly_class_bank" in families
    assert "class_bank_random" in families
    assert "continuous_eml_blocks" in families
    assert "conv_tree_spatial_stages" in families

    random_spec = specs[0]
    comparison = compare_gate_budget(random_spec, reference_nodes=2048 * 6)
    assert comparison.candidate_nodes == 12_288
    assert comparison.reference_nodes == 12_288
    assert comparison.node_ratio == 1.0
    assert comparison.remaining_reference_nodes == 0
