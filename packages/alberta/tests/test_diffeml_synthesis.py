"""Tests for packed hard Boolean DiffEML synthesis."""

import numpy as np

from alberta_framework.core.diffeml_synthesis import (
    BOOLEAN_GATE_NAMES,
    count_true_bits,
    evaluate_all_packed_gates,
    export_selected_gate_arrays,
    export_selected_gate_specs,
    fit_binary_hard_circuit,
    pack_bool_matrix,
    pack_bool_vector,
    predict_binary_hard_circuit,
    score_all_gates_for_pair,
    unpack_bool_matrix,
    unpack_bool_vector,
    unpack_packed_columns,
    witness_gate_masks_with_eml,
    witness_selected_gates_with_eml,
)

BOOLEAN_ROWS = np.asarray(
    [[False, False], [False, True], [True, False], [True, True]],
    dtype=np.bool_,
)


def truth_table(mask: int) -> np.ndarray:
    """Return a local NumPy truth table in DiffEML mask order."""
    return np.asarray([(mask >> idx) & 1 for idx in range(4)], dtype=np.bool_)


def test_pack_unpack_bool_columns_and_vectors() -> None:
    """Packed columns should round-trip across multiple uint64 words."""
    data = ((np.arange(130 * 5).reshape(130, 5) * 37 + 11) % 7) < 3

    packed = pack_bool_matrix(data)
    unpacked = unpack_bool_matrix(packed)

    assert packed.words.dtype == np.uint64
    assert packed.words.shape == (5, 3)
    assert int(packed.valid_word_masks[-1]) == 0b11
    np.testing.assert_array_equal(unpacked, data)

    labels = np.logical_xor(data[:, 0], data[:, 1])
    packed_labels = pack_bool_vector(labels)

    np.testing.assert_array_equal(unpack_bool_vector(packed_labels), labels)
    assert count_true_bits(packed_labels.words, packed_labels.valid_word_masks) == int(
        np.sum(labels)
    )


def test_all_16_gate_masks_match_truth_tables() -> None:
    """Packed gate evaluation should implement every two-input Boolean mask."""
    packed = pack_bool_matrix(BOOLEAN_ROWS)

    outputs = evaluate_all_packed_gates(
        packed.words[0],
        packed.words[1],
        packed.valid_word_masks,
    )
    unpacked = unpack_packed_columns(outputs, BOOLEAN_ROWS.shape[0])

    assert outputs.shape == (16, 1)
    for mask in range(16):
        np.testing.assert_array_equal(unpacked[:, mask], truth_table(mask))
        assert BOOLEAN_GATE_NAMES[mask]


def test_xor_synthesis_selects_hard_boolean_gate() -> None:
    """Greedy packed synthesis should recover XOR with a normal 4-bit mask."""
    inputs = np.tile(BOOLEAN_ROWS, (16, 1))
    labels = np.logical_xor(inputs[:, 0], inputs[:, 1])

    result = fit_binary_hard_circuit(inputs, labels, max_gates=2)

    assert result.accuracy == 1.0
    assert result.accuracy > result.majority_accuracy
    np.testing.assert_array_equal(result.predictions, labels)
    np.testing.assert_array_equal(predict_binary_hard_circuit(result, inputs), labels)
    assert result.gates[0].mask == 6
    assert result.gates[0].name == "XOR"

    packed = pack_bool_matrix(inputs)
    packed_labels = pack_bool_vector(labels)
    scores = score_all_gates_for_pair(
        packed.words[0],
        packed.words[1],
        packed_labels.words,
        packed.valid_word_masks,
        left_source=0,
        right_source=1,
        n_examples=inputs.shape[0],
    )
    assert scores[6].score.accuracy == 1.0
    assert scores[6].score.correlation == 1.0


def test_thresholded_diagonal_toy_beats_majority() -> None:
    """A small thresholded diagonal/Hamming task should beat majority voting."""
    inputs = np.asarray(
        [[bool((row >> bit) & 1) for bit in range(3)] for row in range(8)],
        dtype=np.bool_,
    )
    inputs = np.tile(inputs, (8, 1))
    labels = np.sum(inputs, axis=1) >= 2

    result = fit_binary_hard_circuit(inputs, labels, max_gates=5)

    assert result.accuracy > result.majority_accuracy
    assert result.accuracy >= 0.875
    np.testing.assert_array_equal(predict_binary_hard_circuit(result, inputs), result.predictions)


def test_no_float_head_deployment_metadata_and_exports() -> None:
    """Deployment metadata should describe a pure Boolean circuit readout."""
    inputs = np.tile(BOOLEAN_ROWS, (4, 1))
    labels = np.logical_xor(inputs[:, 0], inputs[:, 1])

    result = fit_binary_hard_circuit(inputs, labels, max_gates=2)
    metadata = result.metadata
    exported = export_selected_gate_arrays(result)
    specs = export_selected_gate_specs(result)

    assert metadata["deploy_uses_float_head"] is False
    assert metadata["deploy_float_head_parameters"] == 0
    assert metadata["deploy_uses_learned_real_thresholds"] is False
    assert metadata["gate_mask_bits"] == 4
    assert metadata["deploy_gate_family"] == "eml_witnessed_4bit_boolean_masks"
    assert exported.masks.dtype == np.uint8
    assert exported.left_sources.dtype == np.int32
    assert exported.right_sources.dtype == np.int32
    assert exported.output_sources.dtype == np.int32
    np.testing.assert_array_equal(exported.masks, np.asarray([6], dtype=np.uint8))
    assert specs[0]["mask"] == 6
    assert specs[0]["left_source"] == 0
    assert specs[0]["right_source"] == 1


def test_eml_witness_coverage_for_selected_and_all_masks() -> None:
    """Selected hard masks should be covered by depth-2 EML templates."""
    inputs = np.tile(BOOLEAN_ROWS, (4, 1))
    labels = np.logical_xor(inputs[:, 0], inputs[:, 1])
    result = fit_binary_hard_circuit(inputs, labels, max_gates=2)

    selected_report = witness_selected_gates_with_eml(result, depth=2, eps=0.05)
    all_report = witness_gate_masks_with_eml(range(16), depth=2, eps=0.05)

    assert selected_report.covered
    assert selected_report.missing_masks == ()
    assert selected_report.requested_masks == (6,)
    assert selected_report.mask_to_name[6] == "XOR"
    assert "eml(" in selected_report.mask_to_expression[6]
    assert all_report.covered
    assert all_report.requested_masks == tuple(range(16))
    assert all_report.missing_masks == ()
