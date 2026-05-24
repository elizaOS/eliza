"""Packed hard Boolean synthesis for DiffEML circuits.

This module is intentionally NumPy-only. It hardens DiffEML-style logic into
ordinary two-input Boolean gates represented by 4-bit truth-table masks in the
same row order used by :mod:`alberta_framework.core.diffeml`: ``00, 01, 10,
11``. The selected masks can therefore be witnessed by the existing
``eml_threshold_gate_library`` without carrying train-time floating heads into
deployment.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from math import sqrt
from typing import Literal

import numpy as np
from numpy.typing import ArrayLike, NDArray

UInt64Array = NDArray[np.uint64]
UInt8Array = NDArray[np.uint8]
Int32Array = NDArray[np.int32]
BoolArray = NDArray[np.bool_]
MetadataValue = bool | int | float | str
ObjectiveName = Literal["accuracy", "balanced_accuracy", "correlation"]

UINT64_ALL_ONES = np.uint64(np.iinfo(np.uint64).max)

BOOLEAN_GATE_NAMES: dict[int, str] = {
    0: "FALSE",
    1: "NOR",
    2: "not_a_and_b",
    3: "NOT_A",
    4: "a_and_not_b",
    5: "NOT_B",
    6: "XOR",
    7: "NAND",
    8: "AND",
    9: "XNOR",
    10: "B",
    11: "a_implies_b",
    12: "A",
    13: "b_implies_a",
    14: "OR",
    15: "TRUE",
}
"""Canonical names for two-input Boolean masks in ``00, 01, 10, 11`` order."""


@dataclass(frozen=True)
class PackedBooleanMatrix:
    """Boolean columns packed across examples into ``uint64`` words.

    Attributes:
        words: Packed bits with shape ``(n_columns, n_words)``. Bit ``k`` of
            word ``j`` stores row ``64 * j + k``.
        n_rows: Number of valid examples represented by the packed words.
        n_columns: Number of Boolean feature columns.
        valid_word_masks: Per-word masks that clear unused bits in the final
            word.
    """

    words: UInt64Array
    n_rows: int
    n_columns: int
    valid_word_masks: UInt64Array

    def __post_init__(self) -> None:
        """Validate packed matrix metadata."""
        if self.words.dtype != np.uint64:
            raise TypeError("words must have dtype uint64")
        if self.valid_word_masks.dtype != np.uint64:
            raise TypeError("valid_word_masks must have dtype uint64")
        if self.words.ndim != 2:
            raise ValueError("words must have shape (n_columns, n_words)")
        if self.n_rows < 0:
            raise ValueError("n_rows must be non-negative")
        if self.n_columns < 0:
            raise ValueError("n_columns must be non-negative")
        expected_words = n_words_for_rows(self.n_rows)
        if self.words.shape != (self.n_columns, expected_words):
            raise ValueError("words shape does not match n_columns/n_rows")
        if self.valid_word_masks.shape != (expected_words,):
            raise ValueError("valid_word_masks shape does not match n_rows")


@dataclass(frozen=True)
class PackedBooleanVector:
    """One Boolean target/residual vector packed into ``uint64`` words."""

    words: UInt64Array
    n_rows: int
    valid_word_masks: UInt64Array

    def __post_init__(self) -> None:
        """Validate packed vector metadata."""
        if self.words.dtype != np.uint64:
            raise TypeError("words must have dtype uint64")
        if self.valid_word_masks.dtype != np.uint64:
            raise TypeError("valid_word_masks must have dtype uint64")
        if self.words.ndim != 1:
            raise ValueError("words must be a one-dimensional uint64 array")
        if self.n_rows < 0:
            raise ValueError("n_rows must be non-negative")
        expected_words = n_words_for_rows(self.n_rows)
        if self.words.shape != (expected_words,):
            raise ValueError("words shape does not match n_rows")
        if self.valid_word_masks.shape != (expected_words,):
            raise ValueError("valid_word_masks shape does not match n_rows")


@dataclass(frozen=True)
class BinaryFeatureScore:
    """Popcount-derived score for one packed Boolean feature.

    Attributes:
        accuracy: Accuracy of the feature as a positive-class predictor.
        inverted_accuracy: Accuracy if deployment flips the feature with one
            Boolean NOT/polarity bit.
        best_accuracy: ``max(accuracy, inverted_accuracy)``.
        best_inverted: Whether the best deployment polarity is inverted.
        balanced_accuracy: Mean true-positive and true-negative rates.
        correlation: Phi correlation between feature bits and binary labels.
        true_positives: Count of examples where feature and label are true.
        false_positives: Count of examples where feature is true and label is
            false.
        true_negatives: Count of examples where feature and label are false.
        false_negatives: Count of examples where feature is false and label is
            true.
        feature_true_count: Number of true feature bits.
        label_true_count: Number of true label bits.
        n_examples: Number of scored examples.
    """

    accuracy: float
    inverted_accuracy: float
    best_accuracy: float
    best_inverted: bool
    balanced_accuracy: float
    correlation: float
    true_positives: int
    false_positives: int
    true_negatives: int
    false_negatives: int
    feature_true_count: int
    label_true_count: int
    n_examples: int


@dataclass(frozen=True)
class CandidateGateScore:
    """Score for one two-source, one-mask Boolean gate candidate."""

    left_source: int
    right_source: int
    mask: int
    name: str
    score: BinaryFeatureScore


@dataclass(frozen=True)
class SelectedGate:
    """One hard gate selected by the greedy synthesizer.

    Source indices use a global circuit source bank: input features first,
    then ``CONST_FALSE``, ``CONST_TRUE``, then selected gate outputs in order.
    """

    gate_index: int
    output_source: int
    left_source: int
    right_source: int
    mask: int
    name: str
    accuracy: float
    balanced_accuracy: float
    correlation: float

    def to_config(self) -> dict[str, int | float | str]:
        """Return JSON-friendly deployment metadata for this selected gate."""
        return {
            "gate_index": self.gate_index,
            "output_source": self.output_source,
            "left_source": self.left_source,
            "right_source": self.right_source,
            "mask": self.mask,
            "name": self.name,
            "accuracy": self.accuracy,
            "balanced_accuracy": self.balanced_accuracy,
            "correlation": self.correlation,
        }


@dataclass(frozen=True)
class HardCircuitState:
    """Packed training-state snapshot for a synthesized hard circuit."""

    input_dim: int
    n_examples: int
    source_names: tuple[str, ...]
    feature_words: UInt64Array
    valid_word_masks: UInt64Array
    selected_gates: tuple[SelectedGate, ...]
    best_source: int
    best_inverted: bool
    best_score: BinaryFeatureScore


@dataclass(frozen=True)
class HardCircuitSynthesisResult:
    """Result from greedy packed Boolean hard-circuit synthesis."""

    state: HardCircuitState
    predictions: BoolArray
    accuracy: float
    majority_accuracy: float
    metadata: Mapping[str, MetadataValue]

    @property
    def gates(self) -> tuple[SelectedGate, ...]:
        """Selected hard gates in evaluation order."""
        return self.state.selected_gates

    @property
    def output_source(self) -> int:
        """Global source index used as the final Boolean readout."""
        return self.state.best_source

    @property
    def output_inverted(self) -> bool:
        """Whether the final Boolean readout flips ``output_source``."""
        return self.state.best_inverted


@dataclass(frozen=True)
class SelectedGateExport:
    """Packed deployment arrays for selected hard gates."""

    masks: UInt8Array
    left_sources: Int32Array
    right_sources: Int32Array
    output_sources: Int32Array


@dataclass(frozen=True)
class EMLWitnessReport:
    """Coverage report showing selected masks are EML-template witnesses."""

    covered: bool
    depth: int
    eps: float
    requested_masks: tuple[int, ...]
    missing_masks: tuple[int, ...]
    mask_to_name: Mapping[int, str]
    mask_to_expression: Mapping[int, str]


def n_words_for_rows(n_rows: int) -> int:
    """Return the number of ``uint64`` words needed for ``n_rows`` bits."""
    if n_rows < 0:
        raise ValueError("n_rows must be non-negative")
    return (n_rows + 63) // 64


def valid_word_masks(n_rows: int) -> UInt64Array:
    """Return per-word masks that clear unused high bits in the final word."""
    n_words = n_words_for_rows(n_rows)
    masks = np.full((n_words,), UINT64_ALL_ONES, dtype=np.uint64)
    remainder = n_rows % 64
    if n_words > 0 and remainder != 0:
        masks[-1] = np.uint64((1 << remainder) - 1)
    return masks


def pack_bool_matrix(values: ArrayLike) -> PackedBooleanMatrix:
    """Pack an example-major Boolean matrix into feature-major ``uint64`` columns.

    Args:
        values: Array-like Boolean data with shape ``(n_examples, n_features)``.
            One-dimensional input is treated as a single feature column.

    Returns:
        Packed Boolean matrix.
    """
    matrix = _as_bool_matrix(values)
    n_rows = int(matrix.shape[0])
    n_columns = int(matrix.shape[1])
    masks = valid_word_masks(n_rows)
    words = np.zeros((n_columns, masks.shape[0]), dtype=np.uint64)
    for word_idx in range(masks.shape[0]):
        start = 64 * word_idx
        stop = min(start + 64, n_rows)
        for row_idx in range(start, stop):
            bit_idx = np.uint64(row_idx - start)
            words[:, word_idx] |= matrix[row_idx].astype(np.uint64, copy=False) << bit_idx
    if masks.shape[0] > 0:
        words &= masks[None, :]
    return PackedBooleanMatrix(
        words=words,
        n_rows=n_rows,
        n_columns=n_columns,
        valid_word_masks=masks,
    )


def pack_bool_vector(values: ArrayLike) -> PackedBooleanVector:
    """Pack a one-dimensional Boolean label or residual vector."""
    vector = _as_bool_vector(values)
    packed = pack_bool_matrix(vector[:, None])
    return PackedBooleanVector(
        words=packed.words[0].copy(),
        n_rows=packed.n_rows,
        valid_word_masks=packed.valid_word_masks.copy(),
    )


def unpack_bool_matrix(packed: PackedBooleanMatrix) -> BoolArray:
    """Unpack a :class:`PackedBooleanMatrix` into example-major Boolean values."""
    return unpack_packed_columns(packed.words, packed.n_rows)


def unpack_bool_vector(packed: PackedBooleanVector) -> BoolArray:
    """Unpack a :class:`PackedBooleanVector` into a Boolean vector."""
    return unpack_packed_vector(packed.words, packed.n_rows)


def unpack_packed_columns(words: ArrayLike, n_rows: int) -> BoolArray:
    """Unpack feature-major ``uint64`` words into an example-major matrix."""
    if n_rows < 0:
        raise ValueError("n_rows must be non-negative")
    packed = _as_uint64_array(words, name="words")
    if packed.ndim == 1:
        matrix = packed.reshape((1, packed.shape[0]))
    elif packed.ndim == 2:
        matrix = packed
    else:
        raise ValueError("words must be one- or two-dimensional")
    expected_words = n_words_for_rows(n_rows)
    if matrix.shape[1] != expected_words:
        raise ValueError("words shape does not match n_rows")
    out = np.zeros((n_rows, matrix.shape[0]), dtype=np.bool_)
    for word_idx in range(expected_words):
        start = 64 * word_idx
        stop = min(start + 64, n_rows)
        for row_idx in range(start, stop):
            bit_idx = np.uint64(row_idx - start)
            out[row_idx, :] = ((matrix[:, word_idx] >> bit_idx) & np.uint64(1)) != 0
    return out


def unpack_packed_vector(words: ArrayLike, n_rows: int) -> BoolArray:
    """Unpack one packed ``uint64`` Boolean vector."""
    matrix = unpack_packed_columns(words, n_rows)
    if matrix.shape[1] != 1:
        raise ValueError("words must describe exactly one packed vector")
    return matrix[:, 0]


def popcount_uint64(words: ArrayLike) -> NDArray[np.uint64]:
    """Vectorized popcount for ``uint64`` arrays using a byte lookup table."""
    arr = np.ascontiguousarray(np.asarray(words, dtype=np.uint64))
    byte_view = arr.view(np.uint8).reshape(arr.shape + (8,))
    return np.asarray(np.sum(_BYTE_POPCOUNT[byte_view], axis=-1, dtype=np.uint64))


def count_true_bits(words: ArrayLike, masks: ArrayLike) -> int:
    """Count valid set bits after applying per-word validity masks."""
    word_vector = _as_word_vector(words, name="words")
    mask_vector = _as_word_vector(masks, name="masks")
    if word_vector.shape != mask_vector.shape:
        raise ValueError("words and masks must have the same shape")
    counts = popcount_uint64(word_vector & mask_vector)
    return int(np.sum(counts, dtype=np.uint64))


def evaluate_packed_gate(
    left: ArrayLike,
    right: ArrayLike,
    mask: int,
    masks: ArrayLike,
) -> UInt64Array:
    """Evaluate one two-input Boolean gate on packed source columns.

    The mask bits correspond to rows ``00, 01, 10, 11``. For example, mask
    ``6`` is XOR, mask ``8`` is AND, and mask ``14`` is OR.
    """
    mask = validate_gate_mask(mask)
    left_words = _as_word_vector(left, name="left")
    right_words = _as_word_vector(right, name="right")
    valid_masks = _as_word_vector(masks, name="masks")
    if left_words.shape != right_words.shape or left_words.shape != valid_masks.shape:
        raise ValueError("left, right, and masks must have the same shape")

    not_left = (~left_words) & valid_masks
    not_right = (~right_words) & valid_masks
    out = np.zeros(left_words.shape, dtype=np.uint64)
    if (mask & 1) != 0:
        out |= not_left & not_right
    if (mask & 2) != 0:
        out |= not_left & right_words
    if (mask & 4) != 0:
        out |= left_words & not_right
    if (mask & 8) != 0:
        out |= left_words & right_words
    return out & valid_masks


def evaluate_all_packed_gates(
    left: ArrayLike,
    right: ArrayLike,
    masks: ArrayLike,
) -> UInt64Array:
    """Evaluate all 16 two-input Boolean gates for one packed source pair."""
    left_words = _as_word_vector(left, name="left")
    valid_masks = _as_word_vector(masks, name="masks")
    out = np.empty((16, valid_masks.shape[0]), dtype=np.uint64)
    for gate_mask in range(16):
        out[gate_mask] = evaluate_packed_gate(left_words, right, gate_mask, valid_masks)
    return out


def score_packed_feature_against_labels(
    feature: ArrayLike,
    labels: ArrayLike,
    masks: ArrayLike,
    *,
    n_examples: int,
) -> BinaryFeatureScore:
    """Score one packed Boolean feature against packed binary labels.

    The counts and accuracy/correlation metrics are computed with popcounts
    over ``uint64`` words, not by unpacking examples.
    """
    if n_examples <= 0:
        raise ValueError("n_examples must be positive")
    feature_words = _as_word_vector(feature, name="feature")
    label_words = _as_word_vector(labels, name="labels")
    valid_masks = _as_word_vector(masks, name="masks")
    if (
        feature_words.shape != label_words.shape
        or feature_words.shape != valid_masks.shape
    ):
        raise ValueError("feature, labels, and masks must have the same shape")

    masked_feature = feature_words & valid_masks
    masked_labels = label_words & valid_masks
    true_positives = count_true_bits(masked_feature & masked_labels, valid_masks)
    feature_true_count = count_true_bits(masked_feature, valid_masks)
    label_true_count = count_true_bits(masked_labels, valid_masks)
    false_positives = feature_true_count - true_positives
    false_negatives = label_true_count - true_positives
    true_negatives = n_examples - true_positives - false_positives - false_negatives
    if true_negatives < 0:
        raise ValueError("n_examples is inconsistent with packed label words")

    accuracy = (true_positives + true_negatives) / n_examples
    inverted_accuracy = 1.0 - accuracy
    positive_count = true_positives + false_negatives
    negative_count = true_negatives + false_positives
    true_positive_rate = (
        true_positives / positive_count if positive_count > 0 else 1.0
    )
    true_negative_rate = (
        true_negatives / negative_count if negative_count > 0 else 1.0
    )
    balanced_accuracy = 0.5 * (true_positive_rate + true_negative_rate)

    denom = sqrt(
        float(
            (true_positives + false_positives)
            * (true_positives + false_negatives)
            * (true_negatives + false_positives)
            * (true_negatives + false_negatives)
        )
    )
    correlation = (
        ((true_positives * true_negatives) - (false_positives * false_negatives))
        / denom
        if denom > 0.0
        else 0.0
    )
    best_inverted = inverted_accuracy > accuracy
    return BinaryFeatureScore(
        accuracy=float(accuracy),
        inverted_accuracy=float(inverted_accuracy),
        best_accuracy=float(inverted_accuracy if best_inverted else accuracy),
        best_inverted=best_inverted,
        balanced_accuracy=float(balanced_accuracy),
        correlation=float(correlation),
        true_positives=true_positives,
        false_positives=false_positives,
        true_negatives=true_negatives,
        false_negatives=false_negatives,
        feature_true_count=feature_true_count,
        label_true_count=label_true_count,
        n_examples=n_examples,
    )


def score_packed_feature_against_binary_residuals(
    feature: ArrayLike,
    residual_bits: ArrayLike,
    masks: ArrayLike,
    *,
    n_examples: int,
) -> BinaryFeatureScore:
    """Score a feature against binary residual bits.

    ``residual_bits=True`` means the feature is being scored as an explanation
    for positive residual/error examples. This keeps residual scoring in the
    same popcount-only path as binary label scoring.
    """
    return score_packed_feature_against_labels(
        feature,
        residual_bits,
        masks,
        n_examples=n_examples,
    )


def score_all_gates_for_pair(
    left: ArrayLike,
    right: ArrayLike,
    labels: ArrayLike,
    masks: ArrayLike,
    *,
    left_source: int,
    right_source: int,
    n_examples: int,
) -> tuple[CandidateGateScore, ...]:
    """Return popcount scores for all 16 masks on one packed source pair."""
    outputs = evaluate_all_packed_gates(left, right, masks)
    scores: list[CandidateGateScore] = []
    for gate_mask in range(16):
        score = score_packed_feature_against_labels(
            outputs[gate_mask],
            labels,
            masks,
            n_examples=n_examples,
        )
        scores.append(
            CandidateGateScore(
                left_source=left_source,
                right_source=right_source,
                mask=gate_mask,
                name=BOOLEAN_GATE_NAMES[gate_mask],
                score=score,
            )
        )
    return tuple(scores)


def fit_binary_hard_circuit(
    inputs: ArrayLike,
    labels: ArrayLike,
    *,
    max_gates: int = 8,
    objective: ObjectiveName = "accuracy",
    input_names: Sequence[str] | None = None,
) -> HardCircuitSynthesisResult:
    """Greedily synthesize a small hard Boolean circuit for binary labels.

    The deployment readout is a single Boolean source plus an optional polarity
    bit. There is no trainable float head, no learned real threshold, and every
    selected internal node is an ordinary 4-bit two-input Boolean mask.

    Args:
        inputs: Example-major Boolean feature matrix.
        labels: Binary labels with one value per example.
        max_gates: Maximum number of hard gates to append.
        objective: Candidate-selection objective. ``"accuracy"`` is the
            default; ``"balanced_accuracy"`` can help imbalanced labels, and
            ``"correlation"`` maximizes absolute phi correlation.
        input_names: Optional names for the input sources.

    Returns:
        Greedy hard-circuit synthesis result.
    """
    if max_gates < 0:
        raise ValueError("max_gates must be non-negative")
    if objective not in ("accuracy", "balanced_accuracy", "correlation"):
        raise ValueError("unknown objective")

    input_matrix = _as_bool_matrix(inputs)
    label_vector = _as_bool_vector(labels)
    n_examples = int(input_matrix.shape[0])
    input_dim = int(input_matrix.shape[1])
    if n_examples == 0:
        raise ValueError("fit_binary_hard_circuit requires at least one example")
    if label_vector.shape[0] != n_examples:
        raise ValueError("labels must have one value per input example")
    source_names = _initial_source_names(input_dim, input_names)

    packed_inputs = pack_bool_matrix(input_matrix)
    packed_labels = pack_bool_vector(label_vector)
    masks = packed_inputs.valid_word_masks
    feature_words = _initial_feature_words(packed_inputs.words, masks)
    seen_features = {
        _feature_key(feature_words[idx], masks) for idx in range(feature_words.shape[0])
    }

    best_source, best_score = _best_existing_source(
        feature_words,
        packed_labels.words,
        masks,
        n_examples=n_examples,
    )
    best_inverted = best_score.best_inverted
    selected_gates: list[SelectedGate] = []

    for _ in range(max_gates):
        candidate = _find_best_new_candidate(
            feature_words,
            packed_labels.words,
            masks,
            seen_features=seen_features,
            n_examples=n_examples,
            objective=objective,
        )
        if candidate is None:
            break

        candidate_score, candidate_words = candidate
        output_source = int(feature_words.shape[0])
        selected_gate = SelectedGate(
            gate_index=len(selected_gates),
            output_source=output_source,
            left_source=candidate_score.left_source,
            right_source=candidate_score.right_source,
            mask=candidate_score.mask,
            name=candidate_score.name,
            accuracy=candidate_score.score.accuracy,
            balanced_accuracy=candidate_score.score.balanced_accuracy,
            correlation=candidate_score.score.correlation,
        )
        selected_gates.append(selected_gate)
        feature_words = np.vstack((feature_words, candidate_words[None, :]))
        seen_features.add(_feature_key(candidate_words, masks))
        source_names = (
            *source_names,
            _render_gate_source_name(selected_gate, source_names),
        )

        if candidate_score.score.best_accuracy > best_score.best_accuracy:
            best_source = output_source
            best_score = candidate_score.score
            best_inverted = candidate_score.score.best_inverted
        if best_score.best_accuracy >= 1.0:
            break

    prediction_words = feature_words[best_source].copy()
    if best_inverted:
        prediction_words = (~prediction_words) & masks
    predictions = unpack_packed_vector(prediction_words, n_examples)
    majority_accuracy = _majority_accuracy(packed_labels.words, masks, n_examples)
    state = HardCircuitState(
        input_dim=input_dim,
        n_examples=n_examples,
        source_names=source_names,
        feature_words=feature_words,
        valid_word_masks=masks.copy(),
        selected_gates=tuple(selected_gates),
        best_source=best_source,
        best_inverted=best_inverted,
        best_score=best_score,
    )
    result = HardCircuitSynthesisResult(
        state=state,
        predictions=predictions,
        accuracy=best_score.best_accuracy,
        majority_accuracy=majority_accuracy,
        metadata=_deployment_metadata(
            input_dim=input_dim,
            n_examples=n_examples,
            selected_gate_count=len(selected_gates),
            output_source=best_source,
            output_inverted=best_inverted,
        ),
    )
    return result


def predict_binary_hard_circuit(
    result: HardCircuitSynthesisResult,
    inputs: ArrayLike,
) -> BoolArray:
    """Evaluate a synthesized hard circuit on new Boolean inputs."""
    input_matrix = _as_bool_matrix(inputs)
    if int(input_matrix.shape[1]) != result.state.input_dim:
        raise ValueError("inputs must have the same feature dimension used for fitting")
    packed_inputs = pack_bool_matrix(input_matrix)
    masks = packed_inputs.valid_word_masks
    feature_words = _initial_feature_words(packed_inputs.words, masks)
    for gate in result.gates:
        left = feature_words[gate.left_source]
        right = feature_words[gate.right_source]
        output = evaluate_packed_gate(left, right, gate.mask, masks)
        feature_words = np.vstack((feature_words, output[None, :]))
    output = feature_words[result.output_source].copy()
    if result.output_inverted:
        output = (~output) & masks
    return unpack_packed_vector(output, int(input_matrix.shape[0]))


def export_selected_gate_arrays(
    result_or_gates: HardCircuitSynthesisResult | Sequence[SelectedGate],
) -> SelectedGateExport:
    """Export selected hard masks and source indices as deployment arrays."""
    gates = _coerce_selected_gates(result_or_gates)
    return SelectedGateExport(
        masks=np.asarray([gate.mask for gate in gates], dtype=np.uint8),
        left_sources=np.asarray([gate.left_source for gate in gates], dtype=np.int32),
        right_sources=np.asarray([gate.right_source for gate in gates], dtype=np.int32),
        output_sources=np.asarray([gate.output_source for gate in gates], dtype=np.int32),
    )


def export_selected_gate_specs(
    result_or_gates: HardCircuitSynthesisResult | Sequence[SelectedGate],
) -> tuple[dict[str, int | float | str], ...]:
    """Export selected gates as JSON-friendly mask/source dictionaries."""
    return tuple(gate.to_config() for gate in _coerce_selected_gates(result_or_gates))


def witness_gate_masks_with_eml(
    masks: Iterable[int],
    *,
    depth: int = 2,
    eps: float = 0.05,
) -> EMLWitnessReport:
    """Check that hard Boolean masks are covered by EML threshold templates."""
    requested = tuple(validate_gate_mask(mask) for mask in masks)
    from alberta_framework.core.diffeml import eml_threshold_gate_library

    library = eml_threshold_gate_library(depth=depth, eps=eps)
    available = {int(mask) for mask in library.masks}
    missing = tuple(mask for mask in requested if mask not in available)
    mask_to_name = {
        int(mask): str(name)
        for mask, name in zip(library.masks, library.names, strict=True)
        if int(mask) in requested
    }
    mask_to_expression = {
        int(mask): str(expression)
        for mask, expression in zip(library.masks, library.expressions, strict=True)
        if int(mask) in requested
    }
    return EMLWitnessReport(
        covered=len(missing) == 0,
        depth=depth,
        eps=eps,
        requested_masks=requested,
        missing_masks=missing,
        mask_to_name=mask_to_name,
        mask_to_expression=mask_to_expression,
    )


def witness_selected_gates_with_eml(
    result_or_gates: HardCircuitSynthesisResult | Sequence[SelectedGate],
    *,
    depth: int = 2,
    eps: float = 0.05,
) -> EMLWitnessReport:
    """Check EML template coverage for every selected gate mask."""
    gates = _coerce_selected_gates(result_or_gates)
    return witness_gate_masks_with_eml((gate.mask for gate in gates), depth=depth, eps=eps)


def validate_gate_mask(mask: int) -> int:
    """Validate and normalize a two-input Boolean mask."""
    normalized = int(mask)
    if normalized < 0 or normalized > 15:
        raise ValueError("gate mask must be in [0, 15]")
    return normalized


def _as_bool_matrix(values: ArrayLike) -> BoolArray:
    arr = np.asarray(values, dtype=np.bool_)
    if arr.ndim == 1:
        arr = arr.reshape((-1, 1))
    if arr.ndim != 2:
        raise ValueError("values must be a one- or two-dimensional Boolean array")
    return arr


def _as_bool_vector(values: ArrayLike) -> BoolArray:
    arr = np.asarray(values, dtype=np.bool_)
    if arr.ndim == 2 and arr.shape[1] == 1:
        arr = arr[:, 0]
    if arr.ndim != 1:
        raise ValueError("values must be a one-dimensional Boolean vector")
    return arr


def _as_uint64_array(values: ArrayLike, *, name: str) -> UInt64Array:
    arr = np.asarray(values, dtype=np.uint64)
    if arr.dtype != np.uint64:
        raise TypeError(f"{name} must be coercible to uint64")
    return arr


def _as_word_vector(values: ArrayLike, *, name: str) -> UInt64Array:
    arr = _as_uint64_array(values, name=name)
    if arr.ndim != 1:
        raise ValueError(f"{name} must be a one-dimensional uint64 word vector")
    return arr


def _initial_source_names(
    input_dim: int,
    input_names: Sequence[str] | None,
) -> tuple[str, ...]:
    if input_names is None:
        names = tuple(f"x{idx}" for idx in range(input_dim))
    else:
        if len(input_names) != input_dim:
            raise ValueError("input_names length must match input feature dimension")
        names = tuple(str(name) for name in input_names)
    return (*names, "CONST_FALSE", "CONST_TRUE")


def _initial_feature_words(input_words: UInt64Array, masks: UInt64Array) -> UInt64Array:
    if input_words.ndim != 2:
        raise ValueError("input_words must have shape (n_features, n_words)")
    false_column = np.zeros((1, masks.shape[0]), dtype=np.uint64)
    true_column = masks.reshape((1, masks.shape[0])).copy()
    return np.vstack((input_words, false_column, true_column))


def _best_existing_source(
    feature_words: UInt64Array,
    labels: UInt64Array,
    masks: UInt64Array,
    *,
    n_examples: int,
) -> tuple[int, BinaryFeatureScore]:
    if feature_words.shape[0] == 0:
        raise ValueError("at least one feature source is required")
    best_source = 0
    best_score = score_packed_feature_against_labels(
        feature_words[0],
        labels,
        masks,
        n_examples=n_examples,
    )
    for source_idx in range(1, feature_words.shape[0]):
        score = score_packed_feature_against_labels(
            feature_words[source_idx],
            labels,
            masks,
            n_examples=n_examples,
        )
        if _is_better_output_score(score, best_score):
            best_source = source_idx
            best_score = score
    return best_source, best_score


def _find_best_new_candidate(
    feature_words: UInt64Array,
    labels: UInt64Array,
    masks: UInt64Array,
    *,
    seen_features: set[bytes],
    n_examples: int,
    objective: ObjectiveName,
) -> tuple[CandidateGateScore, UInt64Array] | None:
    best_candidate: CandidateGateScore | None = None
    best_words: UInt64Array | None = None
    best_value = -float("inf")
    n_sources = int(feature_words.shape[0])
    for left_source in range(n_sources):
        left = feature_words[left_source]
        for right_source in range(n_sources):
            right = feature_words[right_source]
            outputs = evaluate_all_packed_gates(left, right, masks)
            for gate_mask in range(16):
                output_words = outputs[gate_mask]
                if _feature_key(output_words, masks) in seen_features:
                    continue
                score = score_packed_feature_against_labels(
                    output_words,
                    labels,
                    masks,
                    n_examples=n_examples,
                )
                value = _candidate_objective(score, objective)
                candidate = CandidateGateScore(
                    left_source=left_source,
                    right_source=right_source,
                    mask=gate_mask,
                    name=BOOLEAN_GATE_NAMES[gate_mask],
                    score=score,
                )
                if _is_better_candidate(value, candidate, best_value, best_candidate):
                    best_value = value
                    best_candidate = candidate
                    best_words = output_words.copy()
    if best_candidate is None or best_words is None:
        return None
    return best_candidate, best_words


def _candidate_objective(score: BinaryFeatureScore, objective: ObjectiveName) -> float:
    if objective == "accuracy":
        return score.accuracy
    if objective == "balanced_accuracy":
        return score.balanced_accuracy
    if objective == "correlation":
        return abs(score.correlation)
    raise ValueError("unknown objective")


def _is_better_output_score(
    score: BinaryFeatureScore,
    best_score: BinaryFeatureScore,
) -> bool:
    if score.best_accuracy > best_score.best_accuracy + 1e-12:
        return True
    if abs(score.best_accuracy - best_score.best_accuracy) > 1e-12:
        return False
    return abs(score.correlation) > abs(best_score.correlation) + 1e-12


def _is_better_candidate(
    value: float,
    candidate: CandidateGateScore,
    best_value: float,
    best_candidate: CandidateGateScore | None,
) -> bool:
    if best_candidate is None:
        return True
    if value > best_value + 1e-12:
        return True
    if abs(value - best_value) > 1e-12:
        return False
    candidate_key = (
        -abs(candidate.score.correlation),
        candidate.left_source,
        candidate.right_source,
        candidate.mask,
    )
    best_key = (
        -abs(best_candidate.score.correlation),
        best_candidate.left_source,
        best_candidate.right_source,
        best_candidate.mask,
    )
    return candidate_key < best_key


def _feature_key(words: UInt64Array, masks: UInt64Array) -> bytes:
    masked = np.ascontiguousarray(words & masks)
    return masked.tobytes()


def _majority_accuracy(labels: UInt64Array, masks: UInt64Array, n_examples: int) -> float:
    positives = count_true_bits(labels, masks)
    return max(positives, n_examples - positives) / n_examples


def _deployment_metadata(
    *,
    input_dim: int,
    n_examples: int,
    selected_gate_count: int,
    output_source: int,
    output_inverted: bool,
) -> dict[str, MetadataValue]:
    return {
        "input_dim": input_dim,
        "fit_examples": n_examples,
        "selected_gate_count": selected_gate_count,
        "gate_mask_bits": 4,
        "source_indices_per_gate": 2,
        "deploy_readout": "boolean_source_with_optional_inversion",
        "deploy_uses_float_head": False,
        "deploy_float_head_parameters": 0,
        "deploy_uses_learned_real_thresholds": False,
        "deploy_gate_family": "eml_witnessed_4bit_boolean_masks",
        "output_source": output_source,
        "output_inverted": output_inverted,
    }


def _render_gate_source_name(gate: SelectedGate, source_names: Sequence[str]) -> str:
    left = source_names[gate.left_source]
    right = source_names[gate.right_source]
    return f"g{gate.gate_index}:{gate.name}({left},{right})"


def _coerce_selected_gates(
    result_or_gates: HardCircuitSynthesisResult | Sequence[SelectedGate],
) -> tuple[SelectedGate, ...]:
    if isinstance(result_or_gates, HardCircuitSynthesisResult):
        return result_or_gates.gates
    return tuple(result_or_gates)


_BYTE_POPCOUNT = np.asarray([int(value).bit_count() for value in range(256)], dtype=np.uint8)


__all__ = [
    "BOOLEAN_GATE_NAMES",
    "BinaryFeatureScore",
    "CandidateGateScore",
    "EMLWitnessReport",
    "HardCircuitState",
    "HardCircuitSynthesisResult",
    "PackedBooleanMatrix",
    "PackedBooleanVector",
    "SelectedGate",
    "SelectedGateExport",
    "count_true_bits",
    "evaluate_all_packed_gates",
    "evaluate_packed_gate",
    "export_selected_gate_arrays",
    "export_selected_gate_specs",
    "fit_binary_hard_circuit",
    "n_words_for_rows",
    "pack_bool_matrix",
    "pack_bool_vector",
    "popcount_uint64",
    "predict_binary_hard_circuit",
    "score_all_gates_for_pair",
    "score_packed_feature_against_binary_residuals",
    "score_packed_feature_against_labels",
    "unpack_bool_matrix",
    "unpack_bool_vector",
    "unpack_packed_columns",
    "unpack_packed_vector",
    "valid_word_masks",
    "validate_gate_mask",
    "witness_gate_masks_with_eml",
    "witness_selected_gates_with_eml",
]
