"""Tests for DiffEML ECOC readouts."""

from __future__ import annotations

import chex
import jax.numpy as jnp
import numpy as np

from alberta_framework.core.diffeml_ecoc import (
    codebook_metrics,
    decode_hamming,
    decode_packed_hamming,
    dense_balanced_random_codebook,
    fit_code_bit_targets,
    hadamard_codebook,
    hamming_distances,
    one_vs_rest_codebook,
    pack_bits_uint64,
    packed_hamming_distances,
)


def test_codebook_constructors_shape_balance_and_min_distance() -> None:
    """Codebook constructors should be deterministic and distance-auditable."""
    one_vs_rest = one_vs_rest_codebook(5)
    chex.assert_shape(one_vs_rest, (5, 5))
    one_vs_rest_metrics = codebook_metrics(one_vs_rest)
    assert one_vs_rest_metrics.min_distance == 2
    assert one_vs_rest_metrics.code_length == 5

    dense = dense_balanced_random_codebook(
        6,
        16,
        min_distance=5,
        seed=17,
        max_retries=2048,
    )
    repeat = dense_balanced_random_codebook(
        6,
        16,
        min_distance=5,
        seed=17,
        max_retries=2048,
    )
    chex.assert_trees_all_equal(dense, repeat)
    chex.assert_shape(dense, (6, 16))
    chex.assert_trees_all_equal(jnp.sum(dense, axis=0), jnp.full((16,), 3))
    dense_metrics = codebook_metrics(dense)
    assert dense_metrics.min_distance >= 5
    assert dense_metrics.class_balance == 0.5

    hadamard = hadamard_codebook(4, n_bits=7)
    chex.assert_shape(hadamard, (4, 7))
    hadamard_metrics = codebook_metrics(hadamard)
    assert hadamard_metrics.min_distance == 4
    assert hadamard_metrics.code_length == 7


def test_decode_hamming_exact_codewords() -> None:
    """Exact class codewords should decode to their row indices."""
    codebook = hadamard_codebook(8, n_bits=7)

    decoded = decode_hamming(codebook, codebook)
    distances = hamming_distances(codebook, codebook)

    chex.assert_trees_all_equal(decoded, jnp.arange(8, dtype=jnp.int32))
    chex.assert_trees_all_equal(jnp.diag(distances), jnp.zeros((8,), dtype=jnp.int32))


def test_decode_hamming_corrects_single_noisy_bit() -> None:
    """A distance-four code should correct one flipped output bit."""
    codebook = hadamard_codebook(8, n_bits=7)
    noisy = codebook.at[jnp.arange(8), jnp.arange(8) % 7].set(
        jnp.logical_not(codebook[jnp.arange(8), jnp.arange(8) % 7])
    )

    decoded = decode_hamming(noisy, codebook)

    chex.assert_trees_all_equal(decoded, jnp.arange(8, dtype=jnp.int32))


def test_fit_code_bit_targets_returns_binary_targets_and_metrics() -> None:
    """Labels should map directly to binary code-bit targets."""
    codebook = hadamard_codebook(4, n_bits=7)
    labels = jnp.array([3, 0, 2, 1], dtype=jnp.int32)

    targets, metrics = fit_code_bit_targets(labels, codebook)

    chex.assert_trees_all_equal(targets, codebook[labels])
    assert targets.dtype == jnp.bool_
    assert metrics.n_classes == 4
    assert metrics.code_length == 7
    assert metrics.min_distance == 4


def test_packed_hamming_distances_match_unpacked_decoder() -> None:
    """Packed uint64 scoring should match ordinary Hamming distances."""
    codebook = hadamard_codebook(8, n_bits=7)
    noisy = codebook.at[:, 2].set(jnp.logical_not(codebook[:, 2]))
    packed_noisy = pack_bits_uint64(noisy)
    packed_codebook = pack_bits_uint64(codebook)

    packed_distances = packed_hamming_distances(
        packed_noisy,
        packed_codebook,
        n_bits=7,
    )
    packed_decoded = decode_packed_hamming(
        packed_noisy,
        packed_codebook,
        n_bits=7,
    )

    np.testing.assert_array_equal(packed_distances, np.asarray(hamming_distances(noisy, codebook)))
    np.testing.assert_array_equal(packed_decoded, np.arange(8, dtype=np.int32))


def test_ecoc_decoding_beats_direct_weak_vote_toy() -> None:
    """ECOC should survive one bad bit where direct class voting is brittle."""
    n_classes = 8
    labels = jnp.arange(n_classes, dtype=jnp.int32)
    codebook = hadamard_codebook(n_classes, n_bits=7)
    ecoc_bits = codebook.at[labels, labels % 7].set(
        jnp.logical_not(codebook[labels, labels % 7])
    )

    direct_votes = one_vs_rest_codebook(n_classes)
    direct_weak_bits = direct_votes[labels]
    direct_weak_bits = direct_weak_bits.at[labels, labels].set(False)
    direct_weak_bits = direct_weak_bits.at[labels, (labels + 1) % n_classes].set(True)

    ecoc_predictions = decode_hamming(ecoc_bits, codebook)
    direct_predictions = decode_hamming(direct_weak_bits, direct_votes)

    ecoc_accuracy = jnp.mean(ecoc_predictions == labels)
    direct_accuracy = jnp.mean(direct_predictions == labels)

    assert float(ecoc_accuracy) == 1.0
    assert float(direct_accuracy) == 0.0
    assert float(ecoc_accuracy) > float(direct_accuracy)
