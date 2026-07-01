"""Error-correcting output-code readouts for Boolean DiffEML circuits.

The deployed path represented here is intentionally discrete: a circuit emits
code bits, and classification is nearest-codeword decoding under Hamming
distance.  The helpers below avoid a learned floating-point readout head.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, cast

import jax.numpy as jnp
import numpy as np
import numpy.typing as npt
from jax import Array

UInt64Array = npt.NDArray[np.uint64]
UInt8Array = npt.NDArray[np.uint8]
Int32Array = npt.NDArray[np.int32]
BoolArray = npt.NDArray[np.bool_]


@dataclass(frozen=True)
class ECOCCodebookMetrics:
    """Summary statistics for a binary class codebook.

    Attributes:
        n_classes: Number of class codewords.
        code_length: Number of bits per codeword.
        min_distance: Minimum pairwise Hamming distance between classes.
        mean_distance: Mean pairwise Hamming distance between classes.
        class_balance: Mean minority-class fraction per code bit.  Higher is
            better; ``0.5`` is perfectly balanced.
        min_bit_balance: Worst minority-class fraction among code bits.
        max_bit_imbalance: Worst absolute deviation from a ``0.5`` one-rate.
    """

    n_classes: int
    code_length: int
    min_distance: int
    mean_distance: float
    class_balance: float
    min_bit_balance: float
    max_bit_imbalance: float


def one_vs_rest_codebook(n_classes: int) -> Array:
    """Return a deterministic one-vs-rest binary codebook.

    Args:
        n_classes: Number of classes.

    Returns:
        Boolean codebook with shape ``(n_classes, n_classes)``.

    Raises:
        ValueError: If ``n_classes`` is less than two.
    """
    _validate_positive_int("n_classes", n_classes, minimum=2)
    return jnp.eye(n_classes, dtype=jnp.bool_)


def dense_balanced_random_codebook(
    n_classes: int,
    n_bits: int,
    *,
    min_distance: int = 1,
    seed: int = 0,
    max_retries: int = 4096,
) -> Array:
    """Return a deterministic dense balanced random codebook.

    Each bit column assigns as close as possible to half of the classes to one.
    Candidate codebooks are retried until the requested minimum pairwise Hamming
    distance is met.

    Args:
        n_classes: Number of class codewords.
        n_bits: Number of bits per codeword.
        min_distance: Required minimum pairwise Hamming distance.
        seed: Deterministic random seed.
        max_retries: Maximum number of balanced candidates to try.

    Returns:
        Boolean codebook with shape ``(n_classes, n_bits)``.

    Raises:
        ValueError: If dimensions or retry settings are invalid.
        RuntimeError: If no candidate satisfies ``min_distance``.
    """
    _validate_positive_int("n_classes", n_classes, minimum=2)
    _validate_positive_int("n_bits", n_bits)
    _validate_positive_int("max_retries", max_retries)
    if min_distance < 0 or min_distance > n_bits:
        raise ValueError("min_distance must be in [0, n_bits]")

    rng = np.random.default_rng(seed)
    low_ones = n_classes // 2

    for attempt in range(max_retries):
        candidate = np.zeros((n_classes, n_bits), dtype=np.bool_)
        for bit_idx in range(n_bits):
            n_ones = low_ones
            if n_classes % 2 == 1 and (attempt + bit_idx) % 2 == 1:
                n_ones += 1
            one_rows = rng.permutation(n_classes)[:n_ones]
            candidate[one_rows, bit_idx] = True

        if _min_pairwise_hamming_np(candidate) >= min_distance:
            return jnp.asarray(candidate)

    raise RuntimeError(
        "failed to sample a balanced codebook with "
        f"min_distance >= {min_distance} after {max_retries} retries"
    )


def hadamard_codebook(n_classes: int, n_bits: int | None = None) -> Array:
    """Return a deterministic Hadamard-style binary codebook when possible.

    The constructor uses Sylvester Hadamard matrices.  If ``n_bits`` is omitted,
    it chooses the smallest power-of-two order that can supply all classes and
    drops the constant first column.  If ``n_bits`` is provided, either
    ``n_bits + 1`` must be a feasible power-of-two order for the dropped-column
    form, or ``n_bits`` must be a feasible power-of-two order for the full form.

    Args:
        n_classes: Number of class codewords.
        n_bits: Optional requested code length.

    Returns:
        Boolean codebook with rows derived from Hadamard signs.

    Raises:
        ValueError: If the requested dimensions cannot be represented.
    """
    _validate_positive_int("n_classes", n_classes, minimum=2)
    if n_bits is not None:
        _validate_positive_int("n_bits", n_bits)

    if n_bits is None:
        order = _next_power_of_two(n_classes)
        drop_constant_column = True
    elif _is_power_of_two(n_bits + 1) and n_classes <= n_bits + 1:
        order = n_bits + 1
        drop_constant_column = True
    elif _is_power_of_two(n_bits) and n_classes <= n_bits:
        order = n_bits
        drop_constant_column = False
    else:
        raise ValueError(
            "Hadamard codebook requires n_bits + 1 or n_bits to be a "
            "power-of-two order that is at least n_classes"
        )

    hadamard = _sylvester_hadamard(order)
    signs = hadamard[:n_classes, 1:] if drop_constant_column else hadamard[:n_classes]
    return jnp.asarray(signs > 0)


def hamming_distances(bits: Any, codebook: Any) -> Array:
    """Return Hamming distances from bit vectors to each class codeword.

    Args:
        bits: Binary array with shape ``(..., n_bits)``.
        codebook: Binary class codebook with shape ``(n_classes, n_bits)``.

    Returns:
        Integer distances with shape ``(..., n_classes)``.

    Raises:
        ValueError: If the trailing bit dimension does not match the codebook.
    """
    bit_array = _as_bits(bits)
    code_array = _as_codebook(codebook)
    if bit_array.ndim < 1:
        raise ValueError("bits must have at least one dimension")
    if bit_array.shape[-1] != code_array.shape[1]:
        raise ValueError("bits trailing dimension must match codebook length")

    mismatches = jnp.not_equal(jnp.expand_dims(bit_array, axis=-2), code_array)
    distances: Array = jnp.sum(mismatches, axis=-1, dtype=jnp.int32)
    return distances


def hamming_match_counts(bits: Any, codebook: Any) -> Array:
    """Return matching-bit counts for each class codeword."""
    code_array = _as_codebook(codebook)
    matches: Array = code_array.shape[1] - hamming_distances(bits, code_array)
    return matches.astype(jnp.int32)


def decode_hamming(bits: Any, codebook: Any) -> Array:
    """Decode bit vectors by nearest codeword under Hamming distance.

    Ties are resolved deterministically by choosing the lowest class index.
    """
    decoded: Array = jnp.argmin(hamming_distances(bits, codebook), axis=-1)
    return decoded.astype(jnp.int32)


def fit_code_bit_targets(y: Any, codebook: Any) -> tuple[Array, ECOCCodebookMetrics]:
    """Map integer labels to binary ECOC targets.

    Args:
        y: Integer labels with any leading shape.
        codebook: Binary class codebook with shape ``(n_classes, n_bits)``.

    Returns:
        Pair ``(targets, metrics)`` where ``targets`` has shape
        ``y.shape + (n_bits,)`` and ``metrics`` summarizes the codebook.

    Raises:
        ValueError: If any label is outside the codebook class range.
    """
    code_array = _as_codebook(codebook)
    labels = jnp.asarray(y, dtype=jnp.int32)
    label_values = np.asarray(labels)
    if label_values.size > 0:
        min_label = int(np.min(label_values))
        max_label = int(np.max(label_values))
        if min_label < 0 or max_label >= code_array.shape[0]:
            raise ValueError("labels must be in [0, n_classes)")

    targets: Array = jnp.take(code_array, labels, axis=0)
    return targets, codebook_metrics(code_array)


def codebook_metrics(codebook: Any) -> ECOCCodebookMetrics:
    """Return distance and balance metrics for a binary class codebook."""
    code_array = _as_codebook(codebook)
    code_np = np.asarray(code_array, dtype=np.bool_)
    n_classes = int(code_np.shape[0])
    code_length = int(code_np.shape[1])

    distances = _pairwise_hamming_np(code_np)
    if n_classes >= 2:
        pairwise = distances[np.triu_indices(n_classes, k=1)]
        min_distance = int(np.min(pairwise))
        mean_distance = float(np.mean(pairwise))
    else:
        min_distance = 0
        mean_distance = 0.0

    one_fraction = np.mean(code_np, axis=0)
    bit_balance = np.minimum(one_fraction, 1.0 - one_fraction)
    max_imbalance = np.max(np.abs(one_fraction - 0.5))

    return ECOCCodebookMetrics(
        n_classes=n_classes,
        code_length=code_length,
        min_distance=min_distance,
        mean_distance=mean_distance,
        class_balance=float(np.mean(bit_balance)),
        min_bit_balance=float(np.min(bit_balance)),
        max_bit_imbalance=float(max_imbalance),
    )


def pack_bits_uint64(bits: Any) -> UInt64Array:
    """Pack a trailing bit axis into little-endian ``uint64`` words.

    Bit ``i`` in the trailing axis is stored at bit position ``i % 64`` in word
    ``i // 64``.  The leading dimensions are preserved.
    """
    bit_array = np.asarray(bits, dtype=np.bool_)
    if bit_array.ndim < 1:
        raise ValueError("bits must have at least one dimension")
    n_bits = int(bit_array.shape[-1])
    _validate_positive_int("n_bits", n_bits)

    n_words = (n_bits + 63) // 64
    packed = np.zeros((*bit_array.shape[:-1], n_words), dtype=np.uint64)
    for bit_idx in range(n_bits):
        word_idx = bit_idx // 64
        offset = np.uint64(bit_idx % 64)
        packed[..., word_idx] |= bit_array[..., bit_idx].astype(np.uint64) << offset
    return packed


def popcount_uint64(values: Any) -> UInt8Array:
    """Return population counts for each ``uint64`` value."""
    x = np.asarray(values, dtype=np.uint64)
    x = x - ((x >> np.uint64(1)) & np.uint64(0x5555555555555555))
    x = (x & np.uint64(0x3333333333333333)) + (
        (x >> np.uint64(2)) & np.uint64(0x3333333333333333)
    )
    x = (x + (x >> np.uint64(4))) & np.uint64(0x0F0F0F0F0F0F0F0F)
    counts = (x * np.uint64(0x0101010101010101)) >> np.uint64(56)
    return counts.astype(np.uint8)


def packed_hamming_distances(
    packed_bits: Any,
    packed_codebook: Any,
    *,
    n_bits: int,
) -> Int32Array:
    """Return Hamming distances from packed bits to packed codewords.

    Args:
        packed_bits: ``uint64`` array with shape ``(..., n_words)``.
        packed_codebook: ``uint64`` codebook with shape ``(n_classes, n_words)``.
        n_bits: Number of valid bits before padding in the packed words.

    Returns:
        Integer distances with shape ``(..., n_classes)``.
    """
    _validate_positive_int("n_bits", n_bits)
    bits_array = np.asarray(packed_bits, dtype=np.uint64)
    code_array = np.asarray(packed_codebook, dtype=np.uint64)
    if bits_array.ndim < 1:
        raise ValueError("packed_bits must have at least one dimension")
    if code_array.ndim != 2:
        raise ValueError("packed_codebook must have shape (n_classes, n_words)")
    if bits_array.shape[-1] != code_array.shape[1]:
        raise ValueError("packed word counts must match")
    if bits_array.shape[-1] != (n_bits + 63) // 64:
        raise ValueError("n_bits is inconsistent with packed word count")

    xors = np.bitwise_xor(np.expand_dims(bits_array, axis=-2), code_array)
    remainder = n_bits % 64
    if remainder != 0:
        last_mask = np.uint64((1 << remainder) - 1)
        xors[..., -1] &= last_mask

    distances = np.asarray(np.sum(popcount_uint64(xors), axis=-1, dtype=np.int32), dtype=np.int32)
    return distances


def decode_packed_hamming(
    packed_bits: Any,
    packed_codebook: Any,
    *,
    n_bits: int,
) -> Int32Array:
    """Decode packed bit vectors by nearest packed codeword."""
    decoded = np.argmin(
        packed_hamming_distances(packed_bits, packed_codebook, n_bits=n_bits),
        axis=-1,
    )
    return cast(Int32Array, np.asarray(decoded, dtype=np.int32))


def _as_bits(bits: Any) -> Array:
    bit_array: Array = jnp.asarray(bits) != 0
    return bit_array


def _as_codebook(codebook: Any) -> Array:
    code_array: Array = jnp.asarray(codebook) != 0
    if code_array.ndim != 2:
        raise ValueError("codebook must have shape (n_classes, n_bits)")
    if code_array.shape[0] < 1:
        raise ValueError("codebook must contain at least one class")
    if code_array.shape[1] < 1:
        raise ValueError("codebook must contain at least one bit")
    return code_array


def _validate_positive_int(name: str, value: int, minimum: int = 1) -> None:
    if value < minimum:
        raise ValueError(f"{name} must be >= {minimum}")


def _pairwise_hamming_np(codebook: BoolArray) -> Int32Array:
    mismatches = np.logical_xor(codebook[:, np.newaxis, :], codebook[np.newaxis, :, :])
    distances = np.asarray(np.sum(mismatches, axis=-1, dtype=np.int32), dtype=np.int32)
    return distances


def _min_pairwise_hamming_np(codebook: BoolArray) -> int:
    if codebook.shape[0] < 2:
        return 0
    distances = _pairwise_hamming_np(codebook)
    pairwise = distances[np.triu_indices(codebook.shape[0], k=1)]
    return int(np.min(pairwise))


def _is_power_of_two(value: int) -> bool:
    return value > 0 and (value & (value - 1)) == 0


def _next_power_of_two(value: int) -> int:
    if value <= 1:
        return 1
    return 1 << (value - 1).bit_length()


def _sylvester_hadamard(order: int) -> npt.NDArray[np.int8]:
    if not _is_power_of_two(order):
        raise ValueError("Hadamard order must be a power of two")
    matrix = np.array([[1]], dtype=np.int8)
    while matrix.shape[0] < order:
        matrix = np.block([[matrix, matrix], [matrix, -matrix]]).astype(np.int8, copy=False)
    return matrix
