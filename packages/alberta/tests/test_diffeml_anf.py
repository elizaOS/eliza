"""Tests for DiffEML algebraic normal form helpers."""

from __future__ import annotations

import chex
import jax.numpy as jnp

from alberta_framework.core.diffeml import boolean_truth_table, eml_threshold_gate_library
from alberta_framework.core.diffeml_anf import (
    AND_GATE_MASK,
    XOR_GATE_MASK,
    ANFTerm,
    GreedySparseANFLearner,
    all_boolean_inputs,
    anf_terms_from_coefficients,
    anf_to_truth_table,
    evaluate_anf,
    evaluate_anf_coefficients,
    evaluate_anf_terms,
    evaluate_eml_anf_export,
    export_anf_to_eml,
    fit_sparse_anf_greedy,
    truth_table_to_anf,
    validate_eml_anf_export,
)


def test_truth_table_to_anf_recovers_xor_and_and() -> None:
    """Möbius transform should recover canonical two-input ANF terms."""
    xor_coefficients = truth_table_to_anf(boolean_truth_table(6), num_variables=2)
    and_coefficients = truth_table_to_anf(boolean_truth_table(8), num_variables=2)

    chex.assert_trees_all_equal(xor_coefficients, jnp.array([0, 1, 1, 0]))
    chex.assert_trees_all_equal(and_coefficients, jnp.array([0, 0, 0, 1]))
    assert set(anf_terms_from_coefficients(xor_coefficients, 2)) == {
        ANFTerm((0,)),
        ANFTerm((1,)),
    }
    assert anf_terms_from_coefficients(and_coefficients, 2) == (ANFTerm((0, 1)),)
    chex.assert_trees_all_equal(anf_to_truth_table(xor_coefficients, 2), boolean_truth_table(6))
    chex.assert_trees_all_equal(anf_to_truth_table(and_coefficients, 2), boolean_truth_table(8))


def test_truth_table_to_anf_recovers_majority_and_parity_three() -> None:
    """Small three-variable functions should have exact sparse ANF forms."""
    inputs = all_boolean_inputs(3)
    majority = (jnp.sum(inputs, axis=1) >= 2).astype(jnp.int32)
    parity = jnp.mod(jnp.sum(inputs, axis=1), 2).astype(jnp.int32)

    majority_terms = set(anf_terms_from_coefficients(truth_table_to_anf(majority), 3))
    parity_terms = set(anf_terms_from_coefficients(truth_table_to_anf(parity), 3))

    assert majority_terms == {
        ANFTerm((0, 1)),
        ANFTerm((0, 2)),
        ANFTerm((1, 2)),
    }
    assert parity_terms == {ANFTerm((0,)), ANFTerm((1,)), ANFTerm((2,))}
    chex.assert_trees_all_equal(
        evaluate_anf(inputs, tuple(sorted(majority_terms, key=lambda term: term.variables))),
        majority,
    )
    chex.assert_trees_all_equal(
        evaluate_anf_coefficients(inputs, truth_table_to_anf(parity), num_variables=3),
        parity,
    )


def test_evaluate_anf_terms_builds_conjunction_features_and_xor_readout() -> None:
    """Term evaluation should expose AND features and XOR them as parity."""
    inputs = all_boolean_inputs(3)
    terms = (ANFTerm(()), ANFTerm((0, 1)), ANFTerm((2,)))
    features = evaluate_anf_terms(inputs, terms)
    expected_conjunction = jnp.logical_and(inputs[:, 0] == 1, inputs[:, 1] == 1)
    expected_prediction = jnp.mod(
        1 + expected_conjunction.astype(jnp.int32) + inputs[:, 2],
        2,
    ).astype(jnp.int32)

    chex.assert_shape(features, (8, 3))
    chex.assert_trees_all_equal(features[:, 0], jnp.ones((8,), dtype=jnp.int32))
    chex.assert_trees_all_equal(features[:, 1], expected_conjunction.astype(jnp.int32))
    chex.assert_trees_all_equal(features[:, 2], inputs[:, 2])
    chex.assert_trees_all_equal(evaluate_anf(inputs, terms), expected_prediction)


def test_greedy_sparse_anf_recovers_xor_toy() -> None:
    """Neutral GF(2) steps let greedy ANF recover XOR from conjunction terms."""
    inputs = all_boolean_inputs(2)
    labels = boolean_truth_table(6).astype(jnp.int32)
    learner = GreedySparseANFLearner(max_terms=2, max_degree=2)
    model = learner.fit(inputs, labels)

    assert model.training_errors == 0
    assert set(model.terms) == {ANFTerm((0,)), ANFTerm((1,))}
    assert model.steps[0].net_improvement == 0
    chex.assert_trees_all_equal(model.predict(inputs), labels)


def test_greedy_sparse_anf_recovers_parity_toy() -> None:
    """Greedy sparse ANF should recover a small parity polynomial."""
    inputs = all_boolean_inputs(3)
    labels = jnp.mod(jnp.sum(inputs, axis=1), 2).astype(jnp.int32)
    model = fit_sparse_anf_greedy(inputs, labels, max_terms=3, max_degree=3)

    assert model.training_errors == 0
    assert set(model.terms) == {ANFTerm((0,)), ANFTerm((1,)), ANFTerm((2,))}
    chex.assert_trees_all_equal(model.coefficients(), truth_table_to_anf(labels, 3))
    chex.assert_trees_all_equal(model.predict(inputs), labels)


def test_export_anf_to_eml_uses_witnessed_and_xor_masks() -> None:
    """Sparse ANF export should compile terms to EML-witnessed AND/XOR gates."""
    inputs = all_boolean_inputs(3)
    terms = (ANFTerm((0, 1)), ANFTerm((0, 2)), ANFTerm((1, 2)))
    export = export_anf_to_eml(terms, num_variables=3)
    library = eml_threshold_gate_library(depth=2)

    assert export.and_gate_mask == AND_GATE_MASK
    assert export.xor_gate_mask == XOR_GATE_MASK
    assert validate_eml_anf_export(export, library=library)
    assert AND_GATE_MASK in library.masks
    assert XOR_GATE_MASK in library.masks
    assert all(gate.mask == AND_GATE_MASK for term in export.terms for gate in term.and_gates)
    assert all(gate.mask == XOR_GATE_MASK for gate in export.xor_gates)
    assert [len(term.and_gates) for term in export.terms] == [1, 1, 1]
    assert len(export.xor_gates) == 2
    assert "eml(" in export.and_gate_expression
    assert "eml(" in export.xor_gate_expression
    chex.assert_trees_all_equal(
        evaluate_eml_anf_export(export, inputs),
        evaluate_anf(inputs, terms),
    )
